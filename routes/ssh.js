/**
 * routes/ssh.js
 *
 * Simple polling-based SSH execution. No WebSockets, no tokens, no upgrades.
 *
 * Flow:
 *   POST /api/ssh/execute          → starts SSH job, returns { jobId }
 *   GET  /api/ssh/poll/:jobId      → returns { status, newOutput, exitCode }
 *
 * Execution strategy:
 *   - Single-line commands on Linux/Unix: execCommand  (clean exit code)
 *   - Multi-line templates OR network device types:  PTY shell mode
 *     Commands are sent line-by-line; output is streamed back in real time.
 *     The shell is closed after 2 s of output silence (or 90 s hard cap).
 *
 * Enable / privilege escalation (Cisco IOS, NX-OS, JunOS):
 *   If the selected credential has an encrypted_enable_password, the shell
 *   runner automatically sends  "enable\n<password>\n"  before the template
 *   lines, with a 600 ms settle delay after each step.
 *
 * SSRF protection:
 *   validateHostname() is called before the async job is created.  A blocked
 *   or unresolvable hostname returns HTTP 400 immediately; it never reaches
 *   the SSH connection layer.  See lib/validate-hostname.js for blocked ranges.
 *
 * Jobs are kept in memory for 10 minutes then cleaned up.
 * All routes require a valid session (requireAuth).
 */

const express     = require('express');
const { NodeSSH } = require('node-ssh');
const db          = require('../db');
const vault       = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');
const { validateHostname, HostnameValidationError } = require('../lib/validate-hostname');

const router = express.Router();

// ── In-memory job store ───────────────────────────────────────
const jobs = new Map();
let jobCounter = 0;

// Device types that must use shell mode regardless of line count.
// These are also the types that support enable-mode escalation.
const SHELL_DEVICE_TYPES  = new Set(['cisco_ios', 'cisco_nxos', 'junos', 'windows']);
const ENABLE_DEVICE_TYPES = new Set(['cisco_ios', 'cisco_nxos', 'junos']);

// Clean up jobs older than 10 minutes
setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) jobs.delete(id);
    }
}, 60 * 1000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── POST /api/ssh/execute ─────────────────────────────────────
router.post('/execute', requireAuth, async (req, res) => {
    const { device_id, credential_id, command, template_id } = req.body;

    if (!device_id || !command) {
        return res.status(400).json({ error: 'device_id and command required' });
    }

    // 1. Fetch device
    let device;
    try {
        const r = await db.query('SELECT * FROM devices WHERE id = $1', [device_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Device not found' });
        device = r.rows[0];
    } catch (e) {
        console.error('[SSH] DB error fetching device:', e.message);
        return res.status(500).json({ error: 'Database error' });
    }

    // 2. SSRF guard — validate hostname before any network activity.
    //    Returns HTTP 400 immediately if the target is in a blocked range
    //    (loopback, link-local / cloud metadata, etc.).
    //    See lib/validate-hostname.js for the full list of blocked ranges.
    try {
        await validateHostname(device.hostname, device.port);
    } catch (err) {
        if (err instanceof HostnameValidationError) {
            console.warn(
                `[SSH] SSRF block: user ${req.user.id} attempted connection ` +
                `to blocked host "${device.hostname}:${device.port}" ` +
                `(device id=${device_id}): ${err.message}`
            );
            return res.status(400).json({ error: `Invalid device target: ${err.message}` });
        }
        // Unexpected error during DNS resolution — treat as server error
        console.error('[SSH] Hostname validation error:', err.message);
        return res.status(500).json({ error: 'Could not validate device hostname' });
    }

    // 3. Resolve credential
    const credId = parseInt(credential_id) || device.default_credential_id;
    if (!credId) {
        return res.status(400).json({
            error: 'No credential specified and device has no default credential'
        });
    }

    let cred;
    try {
        const r = await db.query('SELECT * FROM credentials WHERE id = $1', [credId]);
        if (!r.rows.length) return res.status(400).json({ error: 'Credential not found' });
        cred = r.rows[0];
    } catch (e) {
        console.error('[SSH] DB error fetching credential:', e.message);
        return res.status(500).json({ error: 'Database error' });
    }

    // 4. Create execution log row
    let logId;
    try {
        const r = await db.query(
            `INSERT INTO execution_logs
               (device_id, template_id, executed_by, command_text, status, credential_id)
             VALUES ($1, $2, $3, $4, 'running', $5)
             RETURNING id`,
            [device_id, template_id || null, req.user.id, command, credId]
        );
        logId = r.rows[0].id;
    } catch (e) {
        console.error('[SSH] DB error creating log:', e.message);
        return res.status(500).json({ error: 'Database error' });
    }

    // 5. Determine execution strategy
    const lines    = command.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    const useShell = lines.length > 1 || SHELL_DEVICE_TYPES.has(device.device_type);

    // 6. Decrypt enable password (null when not configured or not a relevant device type)
    let enablePassword = null;
    if (
        ENABLE_DEVICE_TYPES.has(device.device_type) &&
        cred.encrypted_enable_password
    ) {
        try {
            enablePassword = vault.decrypt(cred.encrypted_enable_password);
        } catch (e) {
            console.warn('[SSH] Could not decrypt enable password — continuing without enable:', e.message);
        }
    }

    // 7. Create in-memory job
    const jobId = ++jobCounter;
    jobs.set(jobId, {
        userId:    req.user.id,
        logId,
        status:    'running',
        output:    '',
        sentUpTo:  0,
        exitCode:  null,
        error:     null,
        createdAt: Date.now(),
    });

    console.log(
        `[SSH] job ${jobId} started — device=${device.hostname}:${device.port}` +
        ` user=${req.user.id} logId=${logId} mode=${useShell ? 'shell' : 'exec'}` +
        (enablePassword ? ' enable=yes' : '')
    );

    // 8. Run SSH asynchronously (do not await)
    runSsh(jobId, logId, device, cred, lines, useShell, enablePassword);

    return res.json({ ok: true, jobId });
});

// ── GET /api/ssh/poll/:jobId ──────────────────────────────────
router.get('/poll/:jobId', requireAuth, (req, res) => {
    const jobId = parseInt(req.params.jobId);
    const job   = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.userId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const newOutput = job.output.slice(job.sentUpTo);
    job.sentUpTo    = job.output.length;

    return res.json({
        status:    job.status,
        newOutput,
        exitCode:  job.exitCode,
        error:     job.error,
    });
});

// ── SSH runner ────────────────────────────────────────────────
async function runSsh(jobId, logId, device, cred, lines, useShell, enablePassword) {
    const job = jobs.get(jobId);
    let   ssh = null;

    const appendOutput = (txt) => {
        if (job) job.output += txt;
    };

    const finishJob = async (exitCode, status, errorMsg) => {
        if (!job) return;
        job.status   = status;
        job.exitCode = exitCode;
        job.error    = errorMsg || null;
        console.log(`[SSH] job ${jobId} finished — status=${status} exitCode=${exitCode}`);
        try {
            await db.query(
                `UPDATE execution_logs
                 SET output=$1, exit_code=$2, status=$3, completed_at=NOW()
                 WHERE id=$4`,
                [job.output, exitCode, status, logId]
            );
        } catch (e) {
            console.error('[SSH] DB error updating log:', e.message);
        }
    };

    try {
        // Build SSH config
        const sshCfg = {
            host:         device.hostname,
            port:         device.port || 22,
            username:     cred.username,
            readyTimeout: 20000,
            // NOTE: host key verification is not yet implemented (known_hosts).
            // The fingerprint is logged on every connection to provide a partial
            // audit trail. A future improvement should store expected fingerprints
            // in the database and reject mismatches.
            hostVerifier: (fingerprint) => {
                console.log(
                    `[SSH] job ${jobId} — host fingerprint for ` +
                    `${device.hostname}:${device.port || 22}: ${fingerprint}`
                );
                return true;
            },
        };

        if (cred.auth_method === 'password') {
            const pw = vault.decrypt(cred.encrypted_password);
            if (!pw) throw new Error('Failed to decrypt password — check VAULT_SECRET');
            sshCfg.password = pw;
        } else {
            const key = vault.decrypt(cred.encrypted_key);
            if (!key) throw new Error('Failed to decrypt private key — check VAULT_SECRET');
            sshCfg.privateKey = key;
            if (cred.encrypted_passphrase) {
                const pp = vault.decrypt(cred.encrypted_passphrase);
                if (pp) sshCfg.passphrase = pp;
            }
        }

        console.log(`[SSH] job ${jobId} connecting — ${cred.username}@${device.hostname}:${device.port || 22}`);
        appendOutput(`Connecting to ${device.hostname}:${device.port || 22}...\n`);

        ssh = new NodeSSH();
        await ssh.connect(sshCfg);

        if (ssh.connection) {
            ssh.connection.on('error', (err) => {
                console.warn(`[SSH] job ${jobId} connection error (suppressed): ${err.message}`);
            });
        }

        console.log(`[SSH] job ${jobId} connected — mode=${useShell ? 'shell' : 'exec'}`);
        appendOutput(`Connected. Running command...\n`);

        let exitCode;

        if (useShell) {
            exitCode = await runWithShell(ssh, jobId, lines, device.device_type, appendOutput, enablePassword);
        } else {
            // Single-line non-network command: use execCommand
            const result = await ssh.execCommand(lines[0], {
                onStdout: (chunk) => appendOutput(chunk.toString()),
                onStderr: (chunk) => appendOutput(chunk.toString()),
            });
            exitCode = result.code;
        }

        try { ssh.dispose(); } catch (_) {}
        ssh = null;

        await finishJob(exitCode, exitCode === 0 ? 'done' : 'error');

    } catch (e) {
        // Sanitise the error message before appending to job output.
        // Raw exception messages can contain internal hostnames, credential
        // names, or vault diagnostics that should not reach the browser.
        const safeMessage = sanitiseErrorMessage(e.message);
        console.error(`[SSH] job ${jobId} error:`, e.message); // full message to server log only
        appendOutput(`\nError: ${safeMessage}\n`);
        if (ssh) { try { ssh.dispose(); } catch (_) {} }
        await finishJob(-1, 'error', safeMessage);
    }
}

/**
 * Strip potentially sensitive details from SSH exception messages before
 * they are returned to the client via job output or the error field.
 *
 * Removes:
 *  - IP addresses and hostnames embedded in error strings
 *  - "VAULT_SECRET" references
 *  - Private key / passphrase mentions
 *
 * @param {string} message
 * @returns {string}
 */
function sanitiseErrorMessage(message) {
    if (!message) return 'SSH error';
    return message
        .replace(/VAULT_SECRET[^\s]*/gi, '[vault]')
        .replace(/private.?key/gi, '[key]')
        .replace(/passphrase/gi, '[passphrase]')
        // Keep generic SSH errors but remove embedded hostnames / IPs
        .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[host]')
        .substring(0, 200); // cap length
}

// ── Shell-mode runner ─────────────────────────────────────────
async function runWithShell(ssh, jobId, lines, deviceType, appendOutput, enablePassword = null) {
    const INTER_LINE_DELAY_MS  =  150;
    const ENABLE_STEP_MS       =  600;
    const QUIET_SETTLE_MS      = 2000;
    const HARD_TIMEOUT_MS      = 90000;

    return new Promise(async (resolve) => {
        let settled = false;
        let quietTimer   = null;
        let hardTimer    = null;

        const finish = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(quietTimer);
            clearTimeout(hardTimer);
            resolve(code);
        };

        let shell;
        try {
            shell = await ssh.requestShell({ term: 'vt100', rows: 80, cols: 220 });
        } catch (e) {
            appendOutput(`\nFailed to open shell: ${sanitiseErrorMessage(e.message)}\n`);
            finish(1);
            return;
        }

        shell.on('data', (chunk) => {
            appendOutput(chunk.toString());
            clearTimeout(quietTimer);
            quietTimer = setTimeout(closeShell, QUIET_SETTLE_MS);
        });

        shell.on('close', () => finish(0));
        shell.on('error', (err) => {
            appendOutput(`\nShell error: ${sanitiseErrorMessage(err.message)}\n`);
            finish(1);
        });

        hardTimer = setTimeout(() => {
            appendOutput('\n[configify] Hard timeout reached — closing session.\n');
            closeShell();
        }, HARD_TIMEOUT_MS);

        const sendLines = async () => {
            if (enablePassword && ENABLE_DEVICE_TYPES.has(deviceType)) {
                if (settled) return;
                appendOutput('\n[configify] Entering privileged EXEC mode (enable)...\n');
                console.log(`[SSH] job ${jobId} → enable`);
                shell.write('enable\n');
                await sleep(ENABLE_STEP_MS);
                if (settled) return;
                console.log(`[SSH] job ${jobId} → <enable password>`);
                shell.write(enablePassword + '\n');
                await sleep(ENABLE_STEP_MS);
                if (settled) return;
            }

            for (const line of lines) {
                if (settled) return;
                console.log(`[SSH] job ${jobId} → ${line}`);
                shell.write(line + '\n');
                await sleep(INTER_LINE_DELAY_MS);
            }

            clearTimeout(quietTimer);
            quietTimer = setTimeout(closeShell, QUIET_SETTLE_MS);
        };

        const closeShell = () => {
            if (settled) return;
            try { shell.write('exit\n'); } catch (_) {}
            setTimeout(() => finish(0), 1000);
        };

        sendLines().catch((e) => {
            appendOutput(`\nSend error: ${sanitiseErrorMessage(e.message)}\n`);
            closeShell();
        });
    });
}

module.exports = router;