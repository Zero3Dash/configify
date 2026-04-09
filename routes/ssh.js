/**
 * routes/ssh.js
 * REST endpoint + WebSocket handler for SSH execution.
 *
 * Auth: POST /execute returns { logId, token }
 *       WebSocket opens at /ws/ssh/:logId?token=<token>
 *       No session middleware needed on the upgrade path.
 *
 * Debug logging: set DEBUG_SSH=true in .env to enable verbose output.
 */
const express      = require('express');
const crypto       = require('crypto');
const { NodeSSH }  = require('node-ssh');
const db           = require('../db');
const vault        = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const DEBUG  = process.env.DEBUG_SSH === 'true';

function log(...args)  { console.log ('[SSH]',     new Date().toISOString(), ...args); }
function dbg(...args)  { if (DEBUG) console.log('[SSH:dbg]', new Date().toISOString(), ...args); }
function err(...args)  { console.error('[SSH:err]', new Date().toISOString(), ...args); }

// ── In-memory one-time token store ────────────────────────────
// Map<token, { logId, userId, expires }>
const pendingTokens = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [t, m] of pendingTokens) {
        if (m.expires < now) {
            dbg('Swept expired token:', t.slice(0, 8) + '…');
            pendingTokens.delete(t);
        }
    }
}, 60_000);

// ── POST /api/ssh/execute ─────────────────────────────────────
router.post('/execute', requireAuth, async (req, res) => {
    const { device_id, credential_id, command, template_id } = req.body;
    log(`execute  user=${req.user?.id} device=${device_id} cred_override=${credential_id}`);

    if (!device_id || !command) {
        err('execute: missing device_id or command');
        return res.status(400).json({ error: 'device_id and command required' });
    }

    try {
        // 1. Fetch device
        const devRes = await db.query('SELECT * FROM devices WHERE id = $1', [device_id]);
        if (!devRes.rows.length) {
            err('execute: device not found:', device_id);
            return res.status(404).json({ error: 'Device not found' });
        }
        const device = devRes.rows[0];
        dbg('execute: device:', device.name, device.hostname + ':' + device.port,
            'default_cred:', device.default_credential_id);

        // 2. Resolve credential
        const credId = parseInt(credential_id) || device.default_credential_id;
        dbg('execute: resolved credId:', credId);
        if (!credId) {
            err('execute: no credential available for device:', device_id);
            return res.status(400).json({
                error: 'No credential specified and device has no default credential'
            });
        }

        const credCheck = await db.query(
            'SELECT id, name, username FROM credentials WHERE id = $1', [credId]
        );
        if (!credCheck.rows.length) {
            err('execute: credential not found:', credId);
            return res.status(400).json({ error: `Credential id=${credId} not found` });
        }
        dbg('execute: credential:', credCheck.rows[0].name, '/', credCheck.rows[0].username);

        // 3. Auto-migrate: ensure credential_id column exists on execution_logs
        try {
            await db.query(`
                ALTER TABLE execution_logs
                ADD COLUMN IF NOT EXISTS credential_id
                INTEGER REFERENCES credentials(id) ON DELETE SET NULL
            `);
            dbg('execute: credential_id column verified');
        } catch (migrErr) {
            dbg('execute: credential_id column check:', migrErr.message);
        }

        // 4. Insert log row
        const logRes = await db.query(
            `INSERT INTO execution_logs
               (device_id, template_id, executed_by, command_text, status, credential_id)
             VALUES ($1,$2,$3,$4,'running',$5) RETURNING id`,
            [device_id, template_id || null, req.user.id, command, credId]
        );
        const logId = logRes.rows[0].id;
        log(`execute: log row created logId=${logId}`);

        // 5. Issue one-time token
        const token = crypto.randomBytes(32).toString('hex');
        pendingTokens.set(token, {
            logId,
            userId: req.user.id,
            expires: Date.now() + 60_000  // 60 s window to open the WebSocket
        });
        dbg('execute: token issued for logId:', logId);

        return res.json({ ok: true, logId, token });

    } catch (e) {
        err('execute: unhandled error:', e.message);
        err(e.stack);
        return res.status(500).json({ error: e.message || 'Server error' });
    }
});

// ── WebSocket SSH handler ─────────────────────────────────────
async function handleSshConnection(ws, logId, userId) {
    let ssh       = null;
    let logOutput = '';

    const send = (type, data) => {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type, data }));
            }
        } catch (e) {
            dbg('send() error:', e.message);
        }
    };

    const progress = (step, total, label) => {
        dbg(`progress ${step}/${total} "${label}"`);
        send('progress', { step, total, label });
    };

    const finish = async (exitCode, status) => {
        log(`finish  logId=${logId} exitCode=${exitCode} status=${status}`);
        try {
            await db.query(
                `UPDATE execution_logs
                 SET output=$1, exit_code=$2, status=$3, completed_at=NOW()
                 WHERE id=$4`,
                [logOutput, exitCode, status, logId]
            );
        } catch (e) {
            err('finish: db update failed:', e.message);
        }
        progress(4, 4, status === 'success' ? 'Complete' : 'Failed');
        send('done', { exitCode, status });
        try { ws.close(); } catch (_) {}
    };

    try {
        // ── Step 1: load log row ──────────────────────────────
        progress(1, 4, 'Fetching job details');
        dbg(`step1: loading log  logId=${logId} userId=${userId}`);

        const logRes = await db.query(
            `SELECT l.*, d.hostname, d.port, d.device_type
             FROM   execution_logs l
             JOIN   devices d ON d.id = l.device_id
             WHERE  l.id=$1 AND l.executed_by=$2`,
            [logId, userId]
        );

        if (!logRes.rows.length) {
            err(`step1: log row missing  logId=${logId} userId=${userId}`);
            send('error', `Log row not found (logId=${logId} userId=${userId})`);
            return ws.close();
        }

        const logRow = logRes.rows[0];
        dbg('step1: logRow:', {
            id:            logRow.id,
            hostname:      logRow.hostname,
            port:          logRow.port,
            device_type:   logRow.device_type,
            credential_id: logRow.credential_id,
        });

        if (!logRow.credential_id) {
            err('step1: credential_id is NULL — schema migration needed');
            send('error',
                'credential_id missing from log row. ' +
                'Run: ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS ' +
                'credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL;'
            );
            return await finish(-1, 'failed');
        }

        // ── Step 1b: load credential ──────────────────────────
        const credRes = await db.query(
            'SELECT * FROM credentials WHERE id=$1',
            [logRow.credential_id]
        );
        if (!credRes.rows.length) {
            err('step1b: credential row missing id:', logRow.credential_id);
            send('error', `Credential id=${logRow.credential_id} not found`);
            return await finish(-1, 'failed');
        }
        const cred = credRes.rows[0];
        dbg('step1b: cred:', {
            id:          cred.id,
            name:        cred.name,
            username:    cred.username,
            auth_method: cred.auth_method,
            has_pw:      !!cred.encrypted_password,
            has_key:     !!cred.encrypted_key,
        });

        // ── Step 2: build SSH config ──────────────────────────
        progress(2, 4, `Connecting to ${logRow.hostname}:${logRow.port}`);
        send('status', `Connecting to ${logRow.hostname}:${logRow.port}…`);
        log(`step2: SSH connect ${cred.username}@${logRow.hostname}:${logRow.port} method=${cred.auth_method}`);

        const sshCfg = {
            host:         logRow.hostname,
            port:         logRow.port,
            username:     cred.username,
            readyTimeout: 20000,
            hostVerifier: (keyOrHash) => {
                try {
                    const fp = Buffer.isBuffer(keyOrHash)
                        ? keyOrHash.toString('hex')
                        : String(keyOrHash);
                    dbg('step2: host fingerprint:', fp.slice(0, 32) + '…');
                    send('thumbprint', fp);
                } catch (_) {}
                return true;
            },
        };

        if (cred.auth_method === 'password') {
            dbg('step2: decrypting password…');
            let pw;
            try {
                pw = vault.decrypt(cred.encrypted_password);
            } catch (decryptErr) {
                err('step2: vault.decrypt threw:', decryptErr.message);
                send('error', 'Credential decrypt error: ' + decryptErr.message);
                return await finish(-1, 'failed');
            }
            if (!pw) {
                err('step2: vault.decrypt returned null/empty for password');
                send('error', 'Failed to decrypt password — verify VAULT_SECRET has not changed');
                return await finish(-1, 'failed');
            }
            dbg('step2: password decrypted, length:', pw.length);
            sshCfg.password = pw;

        } else {
            dbg('step2: decrypting private key…');
            let key;
            try {
                key = vault.decrypt(cred.encrypted_key);
            } catch (decryptErr) {
                err('step2: vault.decrypt threw for key:', decryptErr.message);
                send('error', 'Credential decrypt error: ' + decryptErr.message);
                return await finish(-1, 'failed');
            }
            if (!key) {
                err('step2: vault.decrypt returned null/empty for key');
                send('error', 'Failed to decrypt private key — verify VAULT_SECRET has not changed');
                return await finish(-1, 'failed');
            }
            dbg('step2: key decrypted, length:', key.length);
            sshCfg.privateKey = key;

            if (cred.encrypted_passphrase) {
                try {
                    const pp = vault.decrypt(cred.encrypted_passphrase);
                    if (pp) {
                        dbg('step2: passphrase decrypted OK');
                        sshCfg.passphrase = pp;
                    }
                } catch (ppErr) {
                    dbg('step2: passphrase decrypt failed (continuing):', ppErr.message);
                }
            }
        }

        // ── Step 2b: connect ──────────────────────────────────
        dbg('step2b: calling ssh.connect()…');
        ssh = new NodeSSH();
        await ssh.connect(sshCfg);
        log(`step2b: SSH connected  logId=${logId}`);

        // ── Step 3: execute command ───────────────────────────
        progress(3, 4, 'Running command');
        send('status', 'Connected. Running command…');
        dbg('step3: command:', logRow.command_text.slice(0, 120));

        const result = await ssh.execCommand(logRow.command_text, {
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

        log(`step3: command done  logId=${logId} exitCode=${result.code}`);
        ssh.dispose();
        ssh = null;

        await finish(result.code, result.code === 0 ? 'success' : 'failed');

    } catch (e) {
        err('handleSshConnection: unhandled error:', e.message);
        err(e.stack);
        send('error', e.message);
        if (ssh) { try { ssh.dispose(); } catch (_) {} ssh = null; }
        await finish(-1, 'failed');
    }
}

// ── Attach WebSocket server ───────────────────────────────────
function attachSshWebSocket(wss) {
    wss.on('connection', async (ws, req) => {
        log('WS: new connection  url:', req.url);

        // Expect: /ws/ssh/:logId?token=<64-char hex>
        const match = req.url.match(/^\/ws\/ssh\/(\d+)\?token=([a-f0-9]{64})$/);
        if (!match) {
            err('WS: URL does not match expected pattern:', req.url);
            try { ws.send(JSON.stringify({ type: 'error', data: 'Invalid WebSocket URL format' })); } catch (_) {}
            ws.close();
            return;
        }

        const logId = parseInt(match[1], 10);
        const token = match[2];
        dbg(`WS: parsed  logId=${logId} token=${token.slice(0, 8)}…`);

        const meta = pendingTokens.get(token);
        if (!meta) {
            err(`WS: token not in store  logId=${logId} (store size: ${pendingTokens.size})`);
            try { ws.send(JSON.stringify({ type: 'error', data: 'Invalid or expired token — try running again' })); } catch (_) {}
            ws.close();
            return;
        }

        if (meta.logId !== logId) {
            err(`WS: token logId mismatch  tokenLogId=${meta.logId} requestLogId=${logId}`);
            pendingTokens.delete(token);
            try { ws.send(JSON.stringify({ type: 'error', data: 'Token/logId mismatch' })); } catch (_) {}
            ws.close();
            return;
        }

        if (Date.now() > meta.expires) {
            err(`WS: token expired  logId=${logId}`);
            pendingTokens.delete(token);
            try { ws.send(JSON.stringify({ type: 'error', data: 'Token expired — try running again' })); } catch (_) {}
            ws.close();
            return;
        }

        pendingTokens.delete(token);  // single-use
        log(`WS: auth OK  logId=${logId} userId=${meta.userId}`);

        await handleSshConnection(ws, logId, meta.userId);
    });
}

router.attachSshWebSocket = attachSshWebSocket;
module.exports = router;
