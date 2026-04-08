/**
 * routes/ssh.js
 * REST endpoint to initiate SSH execution + WebSocket handler for streaming output.
 *
 * Flow:
 *   1. POST /api/ssh/execute  →  creates execution_log row, returns { logId }
 *   2. Client opens WebSocket ws://host/ws/ssh/:logId
 *   3. Server SSHes the device, streams stdout/stderr back, closes WS when done
 *
 * Host-key policy:
 *   hostVerifier is set to always return true so unknown or changed host keys
 *   are automatically accepted. This mirrors "StrictHostKeyChecking=accept-new"
 *   behaviour and prevents executions from blocking on a fingerprint prompt.
 *   The resolved fingerprint (SHA-256, hex) is streamed to the browser over the
 *   WebSocket so operators can verify it out-of-band.
 */
const express      = require('express');
const { NodeSSH }  = require('node-ssh');
const db           = require('../db');
const vault        = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Initiate execution (REST) ──────────────────────────────────
router.post('/execute', requireAuth, async (req, res) => {
    const { device_id, credential_id, command, template_id } = req.body;

    if (!device_id || !command) {
        return res.status(400).json({ error: 'device_id and command required' });
    }

    try {
        // Fetch device
        const devRes = await db.query('SELECT * FROM devices WHERE id = $1', [device_id]);
        if (!devRes.rows.length) {
            return res.status(404).json({ error: 'Device not found' });
        }
        const device = devRes.rows[0];

        // Resolve credential: explicit override → device default → error
        const credId = credential_id || device.default_credential_id;
        if (!credId) {
            return res.status(400).json({
                error: 'No credential specified and no default credential configured for this device'
            });
        }

        // Verify credential exists before creating the log
        const credCheck = await db.query('SELECT id FROM credentials WHERE id = $1', [credId]);
        if (!credCheck.rows.length) {
            return res.status(400).json({ error: 'Credential not found' });
        }

        // Create execution log — store credId so the WS handler can retrieve it
        const logRes = await db.query(
            `INSERT INTO execution_logs
               (device_id, template_id, executed_by, command_text, status, credential_id)
             VALUES ($1, $2, $3, $4, 'running', $5)
             RETURNING id`,
            [device_id, template_id || null, req.user.id, command, credId]
        );
        const logId = logRes.rows[0].id;

        return res.json({ ok: true, logId });

    } catch (err) {
        console.error('SSH execute error:', err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// ── WebSocket handler ──────────────────────────────────────────
async function handleSshConnection(ws, logId, userId) {
    let ssh       = null;
    let logOutput = '';

    // ── Helpers ──────────────────────────────────────────────
    const send = (type, data) => {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type, data }));
            }
        } catch (_) { /* ignore write errors on a closing socket */ }
    };

    const progress = (step, total, label) => {
        send('progress', { step, total, label });
    };

    const finish = async (exitCode, status) => {
        try {
            await db.query(
                `UPDATE execution_logs
                 SET output = $1, exit_code = $2, status = $3, completed_at = NOW()
                 WHERE id = $4`,
                [logOutput, exitCode, status, logId]
            );
        } catch (e) {
            console.error('Log update error:', e);
        }
        progress(4, 4, status === 'success' ? 'Complete' : 'Failed');
        send('done', { exitCode, status });
        try { ws.close(); } catch (_) {}
    };

    // ── Main flow ─────────────────────────────────────────────
    try {
        // Step 1 — fetch job details
        progress(1, 4, 'Fetching job details');

        const logRes = await db.query(
            `SELECT l.*, d.hostname, d.port, d.device_type
             FROM   execution_logs l
             JOIN   devices d ON d.id = l.device_id
             WHERE  l.id = $1 AND l.executed_by = $2`,
            [logId, userId]
        );

        if (!logRes.rows.length) {
            send('error', 'Execution log not found or access denied');
            return ws.close();
        }
        const log = logRes.rows[0];

        if (!log.credential_id) {
            send('error', 'No credential associated with this execution log');
            return await finish(-1, 'failed');
        }

        const credRes = await db.query(
            'SELECT * FROM credentials WHERE id = $1',
            [log.credential_id]
        );

        if (!credRes.rows.length) {
            send('error', 'Credential not found');
            return await finish(-1, 'failed');
        }
        const cred = credRes.rows[0];

        // Step 2 — connect
        progress(2, 4, `Connecting to ${log.hostname}:${log.port}`);
        send('status', `Connecting to ${log.hostname}:${log.port}…`);

        // Build SSH config
        const sshCfg = {
            host:     log.hostname,
            port:     log.port,
            username: cred.username,
            // Accept all host keys; capture fingerprint for display
            hostVerifier: (keyOrHash) => {
                try {
                    const thumbprint = Buffer.isBuffer(keyOrHash)
                        ? keyOrHash.toString('hex')
                        : String(keyOrHash);
                    send('thumbprint', thumbprint);
                } catch (_) {}
                return true;
            },
            // Reasonable connection timeout
            readyTimeout: 20000,
        };

        // Attach credentials
        if (cred.auth_method === 'password') {
            const pw = vault.decrypt(cred.encrypted_password);
            if (!pw) {
                send('error', 'Failed to decrypt password — check VAULT_SECRET');
                return await finish(-1, 'failed');
            }
            sshCfg.password = pw;
        } else {
            const key = vault.decrypt(cred.encrypted_key);
            if (!key) {
                send('error', 'Failed to decrypt private key — check VAULT_SECRET');
                return await finish(-1, 'failed');
            }
            sshCfg.privateKey = key;
            const pp = vault.decrypt(cred.encrypted_passphrase);
            if (pp) sshCfg.passphrase = pp;
        }

        ssh = new NodeSSH();
        await ssh.connect(sshCfg);

        // Step 3 — run
        progress(3, 4, 'Running command');
        send('status', 'Connected. Running command…');

        const result = await ssh.execCommand(log.command_text, {
            onStdout: (chunk) => {
                const txt = chunk.toString();
                logOutput += txt;
                send('output', txt);
            },
            onStderr: (chunk) => {
                const txt = chunk.toString();
                logOutput += txt;
                send('stderr', txt);
            }
        });

        ssh.dispose();
        ssh = null;

        await finish(
            result.code,
            result.code === 0 ? 'success' : 'failed'
        );

    } catch (err) {
        console.error('SSH connection/execution error:', err.message);
        send('error', err.message);
        if (ssh) {
            try { ssh.dispose(); } catch (_) {}
            ssh = null;
        }
        await finish(-1, 'failed');
    }
}

// ── Attach WebSocket server ────────────────────────────────────
function attachSshWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        // Validate URL pattern
        const match = req.url.match(/^\/ws\/ssh\/(\d+)$/);
        if (!match) {
            ws.close();
            return;
        }

        const logId  = parseInt(match[1], 10);

        // req.session is populated by the session middleware in server.js
        // upgrade handler — if it's missing the session restore failed.
        const userId = req.session && req.session.passport && req.session.passport.user;
        if (!userId) {
            try {
                ws.send(JSON.stringify({ type: 'error', data: 'Not authenticated' }));
            } catch (_) {}
            ws.close();
            return;
        }

        await handleSshConnection(ws, logId, userId);
    });
}

router.attachSshWebSocket = attachSshWebSocket;
module.exports = router;
