/**
 * routes/ssh.js
 * REST endpoint to initiate SSH execution + WebSocket handler for streaming output.
 *
 * Auth flow:
 *   1. POST /api/ssh/execute  — authenticated via session cookie (normal Express route)
 *                              → creates execution_log row
 *                              → generates a short-lived one-time token
 *                              → returns { logId, token }
 *   2. Client opens WebSocket ws://host/ws/ssh/:logId?token=<token>
 *   3. Upgrade handler validates token directly — no session middleware needed
 *   4. Server SSHes the device, streams stdout/stderr back, closes WS when done
 *
 * This avoids running express-session over a raw socket upgrade (which requires
 * a fake res shim and silently fails in certain environments).
 */
const express      = require('express');
const crypto       = require('crypto');
const { NodeSSH }  = require('node-ssh');
const db           = require('../db');
const vault        = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── In-memory token store ─────────────────────────────────────
// token → { logId, userId, expires }
// Tokens are single-use and expire after 60 seconds.
const pendingTokens = new Map();

// Sweep expired tokens every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, meta] of pendingTokens) {
        if (meta.expires < now) pendingTokens.delete(token);
    }
}, 5 * 60 * 1000);

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

        // Create execution log — persist credId so the WS handler can retrieve it
        const logRes = await db.query(
            `INSERT INTO execution_logs
               (device_id, template_id, executed_by, command_text, status, credential_id)
             VALUES ($1, $2, $3, $4, 'running', $5)
             RETURNING id`,
            [device_id, template_id || null, req.user.id, command, credId]
        );
        const logId = logRes.rows[0].id;

        // Generate a short-lived single-use token for the WebSocket upgrade
        const token = crypto.randomBytes(32).toString('hex');
        pendingTokens.set(token, {
            logId,
            userId: req.user.id,
            expires: Date.now() + 60_000   // 60 seconds to open the WS
        });

        return res.json({ ok: true, logId, token });

    } catch (err) {
        console.error('SSH execute error:', err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// ── WebSocket connection handler ───────────────────────────────
async function handleSshConnection(ws, logId, userId) {
    let ssh       = null;
    let logOutput = '';

    const send = (type, data) => {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type, data }));
            }
        } catch (_) {}
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
            send('error', 'No credential on log row — run: ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL;');
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

        const sshCfg = {
            host:         log.hostname,
            port:         log.port,
            username:     cred.username,
            readyTimeout: 20000,
            // Accept all host keys; stream fingerprint to browser for out-of-band verification
            hostVerifier: (keyOrHash) => {
                try {
                    const thumbprint = Buffer.isBuffer(keyOrHash)
                        ? keyOrHash.toString('hex')
                        : String(keyOrHash);
                    send('thumbprint', thumbprint);
                } catch (_) {}
                return true;
            },
        };

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

        await finish(result.code, result.code === 0 ? 'success' : 'failed');

    } catch (err) {
        console.error('SSH connection/execution error:', err.message);
        send('error', err.message);
        if (ssh) { try { ssh.dispose(); } catch (_) {} ssh = null; }
        await finish(-1, 'failed');
    }
}

// ── Attach WebSocket server ────────────────────────────────────
function attachSshWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        // URL format: /ws/ssh/:logId?token=<hex64>
        const match = req.url.match(/^\/ws\/ssh\/(\d+)\?token=([a-f0-9]{64})$/);
        if (!match) {
            try { ws.send(JSON.stringify({ type: 'error', data: 'Invalid WebSocket URL' })); } catch (_) {}
            ws.close();
            return;
        }

        const logId = parseInt(match[1], 10);
        const token = match[2];

        // Validate and consume the token (single-use)
        const meta = pendingTokens.get(token);
        if (!meta || meta.logId !== logId || Date.now() > meta.expires) {
            pendingTokens.delete(token);
            try { ws.send(JSON.stringify({ type: 'error', data: 'Invalid or expired token — try running the command again' })); } catch (_) {}
            ws.close();
            return;
        }
        pendingTokens.delete(token);

        await handleSshConnection(ws, logId, meta.userId);
    });
}

router.attachSshWebSocket = attachSshWebSocket;
module.exports = router;
