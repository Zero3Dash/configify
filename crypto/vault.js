/**
 * crypto/vault.js
 * AES-256-GCM encryption for stored credentials.
 * The VAULT_SECRET env var must be a 64-char hex string (32 bytes).
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;   // bytes
const TAG_LEN = 16;  // bytes (GCM auth tag)

function getKey() {
    const hex = process.env.VAULT_SECRET;
    if (!hex || hex.length !== 64) {
        throw new Error('VAULT_SECRET must be a 64-char hex string (32 bytes). Generate one and add it to .env');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext → "iv:tag:ciphertext" (all hex).
 * Returns null if plaintext is null/undefined/empty.
 */
function encrypt(plaintext) {
    if (!plaintext) return null;
    const key = getKey();
    const iv  = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt "iv:tag:ciphertext" → plaintext string.
 * Returns null if stored is null/undefined/empty.
 */
function decrypt(stored) {
    if (!stored) return null;
    const key = getKey();
    const parts = stored.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted value format');
    const [ivHex, tagHex, ctHex] = parts;
    const iv         = Buffer.from(ivHex, 'hex');
    const tag        = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(ctHex, 'hex');
    const decipher   = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
