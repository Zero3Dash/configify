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
 *   lines, with a 600 ms settle delay after each step.  This brings the
 *   device from user-EXEC (>) to privileged-EXEC (#) before commands run.
 *
 * Jobs are kept in memory for 10 minutes then cleaned up.
 * All routes require a valid session (requireAuth).
 *
 * Note: the credential_id column on execution_logs is defined in schema.sql.
 * No runtime migrations are performed here.
 */

const express     = require('express');
const { NodeSSH } = require('node-ssh');
const db          = require('../db');
const vault       = require('../crypto/vault');
const { requireAuth } = require('../middleware/auth');

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

    // 3. Create execution log row
    //    credential_id column is guaranteed present by schema.sql
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

    // 4. Determine execution strategy
    const lines    = command.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
    const useShell = lines.length > 1 || SHELL_DEVICE_TYPES.has(device.device_type);

    // 5. Decrypt enable password (null when not configured or not a relevant device type)
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

    // 6. Create in-memory job
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

    // 7. Run SSH asynchronously (do not await)
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
        console.error(`[SSH] job ${jobId} error:`, e.message);
        appendOutput(`\nError: ${e.message}\n`);
        if (ssh) { try { ssh.dispose(); } catch (_) {} }
        await finishJob(-1, 'error', e.message);
    }
}

// ── Shell-mode runner ─────────────────────────────────────────
//
// Opens a PTY shell, optionally escalates to privileged EXEC mode via
// the "enable" command, then sends each template line individually
// (with a small inter-line delay).  Waits for output silence before
// closing the session.
//
// Enable sequence (only for ENABLE_DEVICE_TYPES when enablePassword set):
//   1. send "enable\n"
//   2. wait ENABLE_STEP_MS for the "Password:" prompt
//   3. send the enable password + "\n"
//   4. wait ENABLE_STEP_MS for the "#" prompt
//   5. proceed with template lines
//
// Quiet detection:  2 000 ms of no new output after all lines are sent.
// Hard cap:         90 seconds total, after which the shell is force-closed.
//
async function runWithShell(ssh, jobId, lines, deviceType, appendOutput, enablePassword = null) {
    const INTER_LINE_DELAY_MS  =  150;   // delay between each template line
    const ENABLE_STEP_MS       =  600;   // settle delay for each enable step
    const QUIET_SETTLE_MS      = 2000;   // idle time before considering output done
    const HARD_TIMEOUT_MS      = 90000;  // absolute maximum

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
            appendOutput(`\nFailed to open shell: ${e.message}\n`);
            finish(1);
            return;
        }

        shell.on('data', (chunk) => {
            appendOutput(chunk.toString());

            // Restart the quiet timer every time new data arrives
            clearTimeout(quietTimer);
            quietTimer = setTimeout(closeShell, QUIET_SETTLE_MS);
        });

        shell.on('close', () => finish(0));
        shell.on('error', (err) => {
            appendOutput(`\nShell error: ${err.message}\n`);
            finish(1);
        });

        // Hard timeout
        hardTimer = setTimeout(() => {
            appendOutput('\n[configify] Hard timeout reached — closing session.\n');
            closeShell();
        }, HARD_TIMEOUT_MS);

        const sendLines = async () => {
            // ── Enable / privilege escalation ──────────────────────
            if (enablePassword && ENABLE_DEVICE_TYPES.has(deviceType)) {
                if (settled) return;
                appendOutput('\n[configify] Entering privileged EXEC mode (enable)...\n');
                console.log(`[SSH] job ${jobId} → enable`);
                shell.write('enable\n');
                await sleep(ENABLE_STEP_MS);   // wait for "Password:" prompt
                if (settled) return;
                console.log(`[SSH] job ${jobId} → <enable password>`);
                shell.write(enablePassword + '\n');
                await sleep(ENABLE_STEP_MS);   // wait for "#" prompt
                if (settled) return;
            }

            // ── Template lines ─────────────────────────────────────
            for (const line of lines) {
                if (settled) return;
                console.log(`[SSH] job ${jobId} → ${line}`);
                shell.write(line + '\n');
                await sleep(INTER_LINE_DELAY_MS);
            }

            // Arm quiet timer after last line in case device sends no output
            clearTimeout(quietTimer);
            quietTimer = setTimeout(closeShell, QUIET_SETTLE_MS);
        };

        const closeShell = () => {
            if (settled) return;
            try { shell.write('exit\n'); } catch (_) {}
            setTimeout(() => finish(0), 1000);
        };

        sendLines().catch((e) => {
            appendOutput(`\nSend error: ${e.message}\n`);
            closeShell();
        });
    });
}

module.exports = router;