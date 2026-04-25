/**
 * lib/validate-hostname.js
 *
 * Validates that a device hostname / IP is safe to connect to via SSH.
 * Prevents SSRF attacks where a user with device-write access points a
 * hostname at an internal service (loopback, cloud metadata, etc.).
 *
 * ─── What is blocked ────────────────────────────────────────────────────────
 *  • Loopback         127.0.0.0/8,  ::1
 *  • Link-local       169.254.0.0/16 (AWS/GCP/Azure metadata lives here)
 *                     fe80::/10
 *  • Unspecified      0.0.0.0/8,  ::
 *  • Multicast        224.0.0.0/4,  ff00::/8
 *  • Reserved         240.0.0.0/4, 255.255.255.255
 *  • Documentation    192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24,
 *                     2001:db8::/32
 *  • IPv4-mapped IPv6 ::ffff:x.x.x.x  (embedded v4 is re-checked)
 *  • Unique-local v6  fc00::/7  (fd00:: included)
 *
 * ─── What is intentionally ALLOWED ─────────────────────────────────────────
 *  • RFC-1918 private ranges: 10/8, 172.16/12, 192.168/16
 *    Network devices under management live on private LANs.
 *    If your deployment never reaches private-range hosts, add those CIDRs
 *    to BLOCKED_V4_CIDRS below.
 *
 * ─── DNS resolution ─────────────────────────────────────────────────────────
 *  When the hostname is not a bare IP address the function resolves it via
 *  DNS and checks every returned address against the blocked lists.
 *  This stops attacks like:  hostname = "metadata.google.internal"
 *  Note: this does NOT prevent DNS-rebinding after connection time. For full
 *  protection also enforce an OS-level firewall / egress allowlist.
 *
 * ─── Port validation ────────────────────────────────────────────────────────
 *  Port must be an integer in 1–65535.
 */

'use strict';

const dns = require('dns').promises;
const net = require('net');

// ── Custom error ──────────────────────────────────────────────────────────────

class HostnameValidationError extends Error {
    constructor(message) {
        super(message);
        this.name   = 'HostnameValidationError';
        this.status = 400;
    }
}

// ── IPv4 helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * @param {string} ip
 * @returns {number}
 */
function ipv4ToLong(ip) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Blocked IPv4 CIDR ranges.
 * Each entry: { net (as long), bits (prefix length) }
 */
const BLOCKED_V4_CIDRS = [
    { net: ipv4ToLong('0.0.0.0'),       bits: 8  }, // "this" network
    { net: ipv4ToLong('127.0.0.0'),     bits: 8  }, // loopback
    { net: ipv4ToLong('169.254.0.0'),   bits: 16 }, // link-local / APIPA / cloud metadata
    { net: ipv4ToLong('192.0.0.0'),     bits: 24 }, // IETF protocol assignments
    { net: ipv4ToLong('192.0.2.0'),     bits: 24 }, // TEST-NET-1 (RFC 5737)
    { net: ipv4ToLong('198.18.0.0'),    bits: 15 }, // benchmarking (RFC 2544)
    { net: ipv4ToLong('198.51.100.0'),  bits: 24 }, // TEST-NET-2 (RFC 5737)
    { net: ipv4ToLong('203.0.113.0'),   bits: 24 }, // TEST-NET-3 (RFC 5737)
    { net: ipv4ToLong('224.0.0.0'),     bits: 4  }, // multicast (RFC 3171)
    { net: ipv4ToLong('240.0.0.0'),     bits: 4  }, // reserved / future use
    { net: ipv4ToLong('255.255.255.255'), bits: 32 }, // limited broadcast
];

/**
 * Returns true if the IPv4 address falls within any blocked CIDR.
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIPv4(ip) {
    const addr = ipv4ToLong(ip);
    return BLOCKED_V4_CIDRS.some(({ net, bits }) => {
        const mask = bits === 32
            ? 0xFFFFFFFF
            : (~(0xFFFFFFFF >>> bits)) >>> 0;
        return (addr & mask) === (net & mask);
    });
}

// ── IPv6 helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true if the IPv6 address is in a blocked range.
 * Handles common cases without a full BigInt CIDR library.
 * @param {string} ip  — raw IPv6 string, brackets already stripped
 * @returns {boolean}
 */
function isBlockedIPv6(ip) {
    const lower = ip.toLowerCase();

    // Exact matches
    if (lower === '::1' || lower === '::') return true;

    // fe80::/10 — link-local (fe80..feb)
    // Hex nibbles: fe80 = 1111 1110 1000 0000
    //              febf = 1111 1110 1011 1111  ← upper bound of /10
    // The 10th bit being 1 means top two hex chars are fe, third nibble is 8-b
    if (/^fe[89ab][0-9a-f]/i.test(lower)) return true;

    // fc00::/7 — unique local addresses (fc and fd prefixes)
    if (/^f[cd]/i.test(lower)) return true;

    // ff00::/8 — multicast
    if (/^ff/i.test(lower)) return true;

    // 2001:db8::/32 — documentation
    if (lower.startsWith('2001:db8:')) return true;

    // ::ffff:0:0/96 — IPv4-mapped addresses; check the embedded v4 portion
    const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mapped) {
        return isBlockedIPv4(v4mapped[1]);
    }

    return false;
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate that a device hostname and port are safe to SSH to.
 *
 * @param {string}         hostname  — value stored in devices.hostname
 * @param {number|string}  port      — value stored in devices.port
 * @throws {HostnameValidationError} if the target is not permitted
 */
async function validateHostname(hostname, port) {
    // ── Basic input checks ────────────────────────────────────────────────────

    if (!hostname || typeof hostname !== 'string') {
        throw new HostnameValidationError('Hostname is required');
    }

    const trimmed = hostname.trim();
    if (!trimmed) {
        throw new HostnameValidationError('Hostname must not be blank');
    }

    // Reject obvious injection / path-traversal characters
    if (/[^a-zA-Z0-9.\-:[\]_]/.test(trimmed)) {
        throw new HostnameValidationError(
            `Hostname "${trimmed}" contains invalid characters`
        );
    }

    // ── Port check ────────────────────────────────────────────────────────────

    const portNum = parseInt(port, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new HostnameValidationError(
            `Port ${port} is not a valid port number (1–65535)`
        );
    }

    // ── Resolve to IP(s) and check each one ───────────────────────────────────

    // Strip IPv6 brackets if present
    const bareHost = trimmed.replace(/^\[|\]$/g, '');

    let addresses;

    if (net.isIPv4(bareHost)) {
        // Already an IPv4 literal — no DNS lookup needed
        addresses = [{ address: bareHost, family: 4 }];
    } else if (net.isIPv6(bareHost)) {
        // Already an IPv6 literal
        addresses = [{ address: bareHost, family: 6 }];
    } else {
        // DNS hostname — resolve all A and AAAA records
        try {
            addresses = await dns.lookup(bareHost, { all: true });
        } catch (err) {
            // Treat unresolvable hostnames as invalid — an SSH attempt would
            // fail anyway, and we don't want speculative probing of the network.
            throw new HostnameValidationError(
                `Hostname "${bareHost}" could not be resolved: ${err.message}`
            );
        }

        if (!addresses || addresses.length === 0) {
            throw new HostnameValidationError(
                `Hostname "${bareHost}" resolved to no addresses`
            );
        }
    }

    // Check every resolved address
    for (const { address, family } of addresses) {
        if (family === 4 && isBlockedIPv4(address)) {
            throw new HostnameValidationError(
                `Target address ${address} (resolved from "${bareHost}") is in a ` +
                `restricted range and cannot be used as an SSH target`
            );
        }
        if (family === 6 && isBlockedIPv6(address)) {
            throw new HostnameValidationError(
                `Target address ${address} (resolved from "${bareHost}") is in a ` +
                `restricted IPv6 range and cannot be used as an SSH target`
            );
        }
    }
}

module.exports = { validateHostname, HostnameValidationError };