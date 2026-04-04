/**
 * routes/ssh.js
 * REST endpoint to initiate SSH execution + WebSocket handler for streaming output.
 *
 * Flow:
 *   1. POST /api/ssh/execute  →  creates execution_log row, returns { logId }
 *   2. Client opens WebSocket ws://host/ws/ssh/:logId
 *   3. Server SSHes the device, streams stdout/stderr back, closes WS when done
 */
const express = require('express');
const { NodeSSH } = require('node-ssh');
const db      = require('../db');
const vault   = require('../crypto/vault');
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
        if (!devRes.rows.length) return res.status(404).json({ error: 'Device not found' });

        // Use override credential or device default
        const credId = credential_id || devRes.rows[0].default_credential_id;
        if (!credId) return res.status(400).json({ error: 'No credential specified or configured for this device' });

        // Create log entry
        const logRes = await db.query(
            `INSERT INTO execution_logs (device_id, template_id, executed_by, command_text, status)
             VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
            [device_id, template_id || null, req.user.id, command]
        );
        const logId = logRes.rows[0].id;

        res.json({ ok: true, logId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── WebSocket handler (attached in server.js) ──────────────────
/**
 * Exported function: attachSshWebSocket(wss, db, vault)
 * Call this from server.js after creating the WebSocket server.
 */
async function handleSshConnection(ws, logId, userId) {
    let ssh = null;
    let logOutput = '';

    const send = (type, data) => {
        if (ws.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify({ type, data }));
        }
    };

    const finish = async (exitCode, status) => {
        try {
            await db.query(
                `UPDATE execution_logs
                 SET output = $1, exit_code = $2, status = $3, completed_at = NOW()
                 WHERE id = $4`,
                [logOutput, exitCode, status, logId]
            );
        } catch (e) { console.error('Log update error:', e); }
        send('done', { exitCode, status });
        ws.close();
    };

    try {
        // Fetch log + device + credential
        const logRes = await db.query(
            `SELECT l.*, d.hostname, d.port, d.device_type,
                    d.default_credential_id
             FROM execution_logs l
             JOIN devices d ON d.id = l.device_id
             WHERE l.id = $1 AND l.executed_by = $2`,
            [logId, userId]
        );
        if (!logRes.rows.length) {
            send('error', 'Execution log not found or access denied');
            return ws.close();
        }
        const log = logRes.rows[0];

        const credRes = await db.query(
            'SELECT * FROM credentials WHERE id = $1',
            [log.default_credential_id]
        );
        if (!credRes.rows.length) {
            send('error', 'Credential not found');
            return ws.close();
        }
        const cred = credRes.rows[0];

        send('status', `Connecting to ${log.hostname}:${log.port}…`);

        // Build SSH config
        const sshCfg = {
            host:     log.hostname,
            port:     log.port,
            username: cred.username
        };

        if (cred.auth_method === 'password') {
            sshCfg.password = vault.decrypt(cred.encrypted_password);
        } else {
            sshCfg.privateKey  = vault.decrypt(cred.encrypted_key);
            const pp = vault.decrypt(cred.encrypted_passphrase);
            if (pp) sshCfg.passphrase = pp;
        }

        ssh = new NodeSSH();
        await ssh.connect(sshCfg);

        send('status', 'Connected. Running command…');
        send('output', '');

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
        await finish(result.code, result.code === 0 ? 'success' : 'failed');

    } catch (err) {
        console.error('SSH error:', err.message);
        send('error', err.message);
        if (ssh) try { ssh.dispose(); } catch {}
        await finish(-1, 'failed');
    }
}

// ── Attach WebSocket server ────────────────────────────────────
function attachSshWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        // URL: /ws/ssh/:logId   — parse logId and session user from req
        const match = req.url.match(/^\/ws\/ssh\/(\d+)$/);
        if (!match) return ws.close();

        const logId = parseInt(match[1]);

        // Extract user from session (stored by express-session on req.session)
        const userId = req.session?.passport?.user;
        if (!userId) {
            ws.send(JSON.stringify({ type: 'error', data: 'Not authenticated' }));
            return ws.close();
        }

        await handleSshConnection(ws, logId, userId);
    });
}

router.attachSshWebSocket = attachSshWebSocket;
module.exports = router;
