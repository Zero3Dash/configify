/**
 * routes/ssh.js
 *
 * Simple polling-based SSH execution. No WebSockets, no tokens, no upgrades.
 *
 * Flow:
 *   POST /api/ssh/execute          → starts SSH job, returns { jobId }
 *   GET  /api/ssh/poll/:jobId      → returns { status, newOutput, exitCode }
 *
 * Jobs are kept in memory for 10 minutes then cleaned up.
 * All routes require a valid session (requireAuth).
 */

const express     = require('express');
const { NodeSSH } = require('node-ssh');
const db          = require('../db');
const vault       = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── In-memory job store ───────────────────────────────────────
//
// jobId → {
//   userId,
//   status: 'running' | 'done' | 'error',
//   output: string,          // full output so far
//   sentUpTo: number,        // how many chars the client has already received
//   exitCode: number | null,
//   error: string | null,
//   createdAt: number,
// }
const jobs = new Map();
let jobCounter = 0;

// Clean up jobs older than 10 minutes
setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) jobs.delete(id);
    }
}, 60 * 1000);

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

    // 2. Resolve credential
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

    // 3. Ensure credential_id column exists (safe no-op if already present)
    try {
        await db.query(`
            ALTER TABLE execution_logs
            ADD COLUMN IF NOT EXISTS credential_id
            INTEGER REFERENCES credentials(id) ON DELETE SET NULL
        `);
    } catch (_) {}

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

    // 5. Create in-memory job
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

    console.log(`[SSH] job ${jobId} started — device=${device.hostname}:${device.port} user=${req.user.id} logId=${logId}`);

    // 6. Run SSH asynchronously (do not await)
    runSsh(jobId, logId, device, cred, command);

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

    // Return only new output since last poll
    const newOutput = job.output.slice(job.sentUpTo);
    job.sentUpTo    = job.output.length;

    return res.json({
        status:    job.status,           // 'running' | 'done' | 'error'
        newOutput,
        exitCode:  job.exitCode,
        error:     job.error,
    });
});

// ── SSH runner (async, does not block the request) ────────────
async function runSsh(jobId, logId, device, cred, command) {
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
            // Accept all host keys automatically
            hostVerifier: () => true,
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

        // Absorb socket-level errors (e.g. EPIPE on close) so they
        // don't become unhandled exceptions and crash the process.
        if (ssh.connection) {
            ssh.connection.on('error', (err) => {
                console.warn(`[SSH] job ${jobId} connection error (suppressed): ${err.message}`);
            });
        }

        console.log(`[SSH] job ${jobId} connected`);
        appendOutput(`Connected. Running command...\n`);

        const result = await ssh.execCommand(command, {
            onStdout: (chunk) => appendOutput(chunk.toString()),
            onStderr: (chunk) => appendOutput(chunk.toString()),
        });

        try { ssh.dispose(); } catch (_) {}
        ssh = null;

        await finishJob(result.code, result.code === 0 ? 'done' : 'error');

    } catch (e) {
        console.error(`[SSH] job ${jobId} error:`, e.message);
        appendOutput(`\nError: ${e.message}\n`);
        if (ssh) { try { ssh.dispose(); } catch (_) {} }
        await finishJob(-1, 'error', e.message);
    }
}

module.exports = router;
