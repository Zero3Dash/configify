/**
 * routes/compliance.js
 *
 * Configuration compliance checking for Cisco IOS and NX-OS devices.
 *
 * Golden configs (a.k.a. "golden configurations") define expected configuration
 * lines that must be present in a device's running config.  Assignments link
 * a golden config to a specific device or an entire device group.
 *
 * Flow:
 *   POST /api/compliance/check         → starts async check job, returns { jobId }
 *   GET  /api/compliance/poll/:jobId   → streams progress { status, completed, total, newLog, results }
 *
 * Supported device types: cisco_ios, cisco_nxos
 */

const express     = require('express');
const { NodeSSH } = require('node-ssh');
const db          = require('../db');
const vault       = require('../crypto/vault');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── In-memory check jobs ──────────────────────────────────────
const jobs = new Map();
let jobCounter = 0;

const SUPPORTED_TYPES = new Set(['cisco_ios', 'cisco_nxos']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) jobs.delete(id);
    }
}, 60_000);

// ════════════════════════════════════════════════════════════════
// GOLDEN CONFIGS
// ════════════════════════════════════════════════════════════════

router.get('/golden-configs', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT  gc.id, gc.name, gc.description, gc.device_types,
                    gc.created_at, gc.updated_at,
                    u.username AS created_by_name,
                    (SELECT COUNT(*) FROM golden_config_assignments
                     WHERE golden_config_id = gc.id)::int AS assignment_count
            FROM    golden_configs gc
            LEFT JOIN users u ON u.id = gc.created_by
            ORDER BY gc.name
        `);
        res.json(rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Database error' }); }
});

router.get('/golden-configs/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT * FROM golden_configs WHERE id = $1', [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Golden config not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.post('/golden-configs', async (req, res) => {
    const { name, description, config_text, device_types } = req.body;
    if (!name || !config_text) return res.status(400).json({ error: 'name and config_text required' });
    const types = (Array.isArray(device_types) && device_types.length)
        ? device_types.filter(t => SUPPORTED_TYPES.has(t))
        : ['cisco_ios', 'cisco_nxos'];
    if (!types.length) return res.status(400).json({ error: 'No valid device_types. Use cisco_ios or cisco_nxos.' });
    try {
        const { rows } = await db.query(
            `INSERT INTO golden_configs (name, description, config_text, device_types, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [name.trim(), description?.trim() || null, config_text, types, req.user.id]
        );
        res.status(201).json(rows[0]);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Database error' }); }
});

router.put('/golden-configs/:id', async (req, res) => {
    const { name, description, config_text, device_types } = req.body;
    if (!name || !config_text) return res.status(400).json({ error: 'name and config_text required' });
    const types = (Array.isArray(device_types) && device_types.length)
        ? device_types.filter(t => SUPPORTED_TYPES.has(t))
        : ['cisco_ios', 'cisco_nxos'];
    try {
        const { rows } = await db.query(
            `UPDATE golden_configs
             SET name=$1, description=$2, config_text=$3, device_types=$4, updated_at=NOW()
             WHERE id=$5 RETURNING *`,
            [name.trim(), description?.trim() || null, config_text, types, req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Golden config not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

router.delete('/golden-configs/:id', requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            'DELETE FROM golden_configs WHERE id=$1 RETURNING id', [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Golden config not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ════════════════════════════════════════════════════════════════
// ASSIGNMENTS
// ════════════════════════════════════════════════════════════════

router.get('/assignments', async (req, res) => {
    const gcId   = req.query.golden_config_id || null;
    const devId  = req.query.device_id        || null;
    const params = [];
    const wheres = [];
    if (gcId)  { params.push(gcId);  wheres.push(`gca.golden_config_id = $${params.length}`); }
    if (devId) { params.push(devId); wheres.push(`gca.device_id = $${params.length}`); }
    const whereClause = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    try {
        const { rows } = await db.query(`
            SELECT  gca.id, gca.golden_config_id, gca.device_id, gca.device_group_id, gca.created_at,
                    gc.name AS golden_config_name, gc.device_types,
                    d.name  AS device_name,  d.hostname,    d.device_type,
                    dg.name AS device_group_name, dg.color AS device_group_color,
                    u.username AS created_by_name
            FROM    golden_config_assignments gca
            JOIN    golden_configs gc ON gc.id = gca.golden_config_id
            LEFT JOIN devices       d  ON d.id  = gca.device_id
            LEFT JOIN device_groups dg ON dg.id = gca.device_group_id
            LEFT JOIN users         u  ON u.id  = gca.created_by
            ${whereClause}
            ORDER BY gc.name, COALESCE(d.name, dg.name)
        `, params);
        res.json(rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Database error' }); }
});

router.post('/assignments', async (req, res) => {
    const { golden_config_id, device_id, device_group_id } = req.body;
    if (!golden_config_id)             return res.status(400).json({ error: 'golden_config_id required' });
    if (!device_id && !device_group_id) return res.status(400).json({ error: 'device_id or device_group_id required' });
    if (device_id  && device_group_id)  return res.status(400).json({ error: 'Specify only one of device_id or device_group_id' });
    try {
        const { rows } = await db.query(
            `INSERT INTO golden_config_assignments (golden_config_id, device_id, device_group_id, created_by)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
            [golden_config_id, device_id || null, device_group_id || null, req.user.id]
        );
        res.status(201).json(rows[0] || { ok: true, message: 'Already assigned' });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Database error' }); }
});

router.delete('/assignments/:id', async (req, res) => {
    try {
        const { rows } = await db.query(
            'DELETE FROM golden_config_assignments WHERE id=$1 RETURNING id', [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Assignment not found' });
        res.status(204).send();
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════

router.get('/dashboard', async (req, res) => {
    try {
        const { rows: [summary] } = await db.query(`
            WITH latest AS (
                SELECT DISTINCT ON (device_id, golden_config_id)
                    device_id, golden_config_id, status
                FROM  compliance_results
                WHERE status IN ('compliant','non_compliant','error')
                ORDER BY device_id, golden_config_id, checked_at DESC
            )
            SELECT
                COUNT(*)::int                                          AS total,
                COUNT(*) FILTER (WHERE status='compliant')::int       AS compliant,
                COUNT(*) FILTER (WHERE status='non_compliant')::int   AS non_compliant,
                COUNT(*) FILTER (WHERE status='error')::int           AS error_count,
                COUNT(DISTINCT device_id)::int                        AS devices_checked
            FROM latest
        `);

        const { rows: devices } = await db.query(`
            WITH latest AS (
                SELECT DISTINCT ON (cr.device_id, cr.golden_config_id)
                    cr.id AS result_id, cr.device_id, cr.golden_config_id,
                    cr.status, cr.checked_at, cr.missing_lines,
                    cr.total_lines, cr.matched_lines, cr.error_message
                FROM compliance_results cr
                WHERE cr.status IN ('compliant','non_compliant','error')
                ORDER BY cr.device_id, cr.golden_config_id, cr.checked_at DESC
            )
            SELECT  l.*,
                    d.name  AS device_name, d.hostname, d.device_type,
                    gc.name AS golden_config_name,
                    dg.name AS group_name, dg.color AS group_color
            FROM    latest l
            JOIN    devices        d  ON d.id  = l.device_id
            JOIN    golden_configs gc ON gc.id = l.golden_config_id
            LEFT JOIN device_groups dg ON dg.id = d.group_id
            ORDER BY l.status, d.name
        `);

        res.json({ summary, devices });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Database error' }); }
});

// Single result detail (for modal)
router.get('/results/:id', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT  cr.*,
                    d.name  AS device_name,  d.hostname, d.device_type,
                    gc.name AS golden_config_name, gc.config_text AS golden_config_text,
                    u.username AS checked_by_name
            FROM    compliance_results cr
            JOIN    devices        d  ON d.id  = cr.device_id
            JOIN    golden_configs gc ON gc.id = cr.golden_config_id
            LEFT JOIN users u ON u.id = cr.checked_by
            WHERE   cr.id = $1
        `, [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Result not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ════════════════════════════════════════════════════════════════
// CHECK EXECUTION
// ════════════════════════════════════════════════════════════════

/**
 * POST /api/compliance/check
 * Body options:
 *   { golden_config_id, device_id }  — check one device against one golden config
 *   { golden_config_id }             — check all assigned devices for a golden config
 *   {}                               — check all assignments (full audit)
 */
router.post('/check', async (req, res) => {
    const { golden_config_id, device_id } = req.body;
    let pairs = [];

    try {
        if (golden_config_id && device_id) {
            // Single explicit pair
            const [dRow, gcRow] = await Promise.all([
                db.query('SELECT * FROM devices WHERE id=$1', [device_id]),
                db.query('SELECT * FROM golden_configs WHERE id=$1', [golden_config_id])
            ]);
            if (!dRow.rows.length)  return res.status(404).json({ error: 'Device not found' });
            if (!gcRow.rows.length) return res.status(404).json({ error: 'Golden config not found' });
            pairs = [{ device: dRow.rows[0], goldenConfig: gcRow.rows[0] }];
        } else {
            // Resolve from assignments ─────────────────────────────
            const params = [];
            let gcFilter = '';
            if (golden_config_id) { params.push(golden_config_id); gcFilter = `AND gca.golden_config_id = $${params.length}`; }

            // Direct device assignments
            const { rows: direct } = await db.query(`
                SELECT  d.*, gc.id AS gc_id, gc.name AS gc_name,
                        gc.config_text, gc.device_types
                FROM    golden_config_assignments gca
                JOIN    golden_configs gc ON gc.id = gca.golden_config_id
                JOIN    devices        d  ON d.id  = gca.device_id
                WHERE   gca.device_id IS NOT NULL
                ${gcFilter}
            `, params);

            // Group assignments (expand to member devices)
            const { rows: grouped } = await db.query(`
                SELECT  d.*, gc.id AS gc_id, gc.name AS gc_name,
                        gc.config_text, gc.device_types
                FROM    golden_config_assignments gca
                JOIN    golden_configs gc ON gc.id = gca.golden_config_id
                JOIN    device_groups  dg ON dg.id = gca.device_group_id
                JOIN    devices        d  ON d.group_id = dg.id
                WHERE   gca.device_group_id IS NOT NULL
                ${gcFilter}
            `, params);

            // Deduplicate by device_id + gc_id
            const seen = new Set();
            for (const row of [...direct, ...grouped]) {
                const key = `${row.id}:${row.gc_id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                pairs.push({
                    device: row,
                    goldenConfig: { id: row.gc_id, name: row.gc_name, config_text: row.config_text, device_types: row.device_types }
                });
            }
        }

        // Filter to supported device types only
        pairs = pairs.filter(p => SUPPORTED_TYPES.has(p.device.device_type));

        if (!pairs.length) {
            return res.status(400).json({
                error: 'No eligible devices found. Ensure assignments exist and devices are of type cisco_ios or cisco_nxos.'
            });
        }

        // Create job
        const jobId = ++jobCounter;
        jobs.set(jobId, {
            userId:    req.user.id,
            status:    'running',
            total:     pairs.length,
            completed: 0,
            results:   [],
            log:       '',
            sentUpTo:  0,
            createdAt: Date.now()
        });

        // Run asynchronously
        runChecks(jobId, pairs, req.user.id).catch(err => {
            console.error('[compliance] runChecks fatal:', err.message);
            const job = jobs.get(jobId);
            if (job) { job.status = 'done'; job.log += `\nFatal error: ${err.message}`; }
        });

        return res.json({ ok: true, jobId, total: pairs.length });
    } catch (err) {
        console.error('[compliance] check setup error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

router.get('/poll/:jobId', requireAuth, (req, res) => {
    const jobId = parseInt(req.params.jobId);
    const job   = jobs.get(jobId);
    if (!job)                        return res.status(404).json({ error: 'Job not found' });
    if (job.userId !== req.user.id)  return res.status(403).json({ error: 'Forbidden' });

    const newLog  = job.log.slice(job.sentUpTo);
    job.sentUpTo  = job.log.length;

    res.json({
        status:    job.status,
        total:     job.total,
        completed: job.completed,
        results:   job.results,
        newLog
    });
});

// ════════════════════════════════════════════════════════════════
// ASYNC RUNNER
// ════════════════════════════════════════════════════════════════

async function runChecks(jobId, pairs, userId) {
    const job = jobs.get(jobId);
    const log = msg => { if (job) job.log += msg + '\n'; };

    log(`▶ Starting compliance audit — ${pairs.length} check${pairs.length !== 1 ? 's' : ''}...`);

    for (const { device, goldenConfig } of pairs) {
        if (!jobs.has(jobId)) break;  // job was cleaned up

        log(`\n[${device.name}] Checking "${goldenConfig.name}"...`);

        // Resolve credential
        if (!device.default_credential_id) {
            log(`[${device.name}] ✗ No default credential — skipping`);
            job.completed++;
            continue;
        }

        let cred;
        try {
            const r = await db.query('SELECT * FROM credentials WHERE id=$1', [device.default_credential_id]);
            if (!r.rows.length) { log(`[${device.name}] ✗ Credential not found — skipping`); job.completed++; continue; }
            cred = r.rows[0];
        } catch { log(`[${device.name}] ✗ DB error fetching credential`); job.completed++; continue; }

        // Create pending result row
        let resultId;
        try {
            const r = await db.query(
                `INSERT INTO compliance_results
                   (golden_config_id, device_id, credential_id, status, checked_by)
                 VALUES ($1,$2,$3,'running',$4) RETURNING id`,
                [goldenConfig.id, device.id, device.default_credential_id, userId]
            );
            resultId = r.rows[0].id;
        } catch (err) {
            log(`[${device.name}] ✗ Could not create result record: ${err.message}`);
            job.completed++;
            continue;
        }

        // SSH + fetch running config
        let runningConfig = null;
        let sshError      = null;
        try {
            log(`[${device.name}] Connecting to ${device.hostname}:${device.port || 22}...`);
            runningConfig = await fetchRunningConfig(device, cred);
            log(`[${device.name}] Config fetched (${runningConfig.split('\n').length} lines)`);
        } catch (err) {
            sshError = err.message;
            log(`[${device.name}] ✗ SSH error: ${err.message}`);
        }

        // Compare lines
        let status, missingLines, lineResults, totalLines, matchedLines;
        if (sshError || !runningConfig) {
            status       = 'error';
            missingLines = [];
            lineResults  = [];
            totalLines   = 0;
            matchedLines = 0;
        } else {
            const result = checkComplianceLines(goldenConfig.config_text, runningConfig);
            status       = result.compliant ? 'compliant' : 'non_compliant';
            missingLines = result.missingLines;
            lineResults  = result.lineResults;
            totalLines   = result.totalLines;
            matchedLines = result.matchedLines;
            if (status === 'compliant') {
                log(`[${device.name}] ✓ Compliant — all ${totalLines} lines present`);
            } else {
                log(`[${device.name}] ✗ Non-compliant — ${missingLines.length}/${totalLines} lines missing`);
            }
        }

        // Persist result
        try {
            await db.query(
                `UPDATE compliance_results
                 SET status=$1, config_snapshot=$2, missing_lines=$3, line_results=$4,
                     total_lines=$5, matched_lines=$6, error_message=$7, completed_at=NOW()
                 WHERE id=$8`,
                [status, runningConfig || null, missingLines, JSON.stringify(lineResults),
                 totalLines, matchedLines, sshError || null, resultId]
            );
        } catch (err) {
            log(`[${device.name}] Warning: could not persist result: ${err.message}`);
        }

        job.results.push({
            result_id:          resultId,
            device_id:          device.id,
            device_name:        device.name,
            device_type:        device.device_type,
            golden_config_id:   goldenConfig.id,
            golden_config_name: goldenConfig.name,
            status,
            missing_count: missingLines.length,
            total_lines:   totalLines,
            matched_lines: matchedLines
        });
        job.completed++;
    }

    if (job) {
        job.status = 'done';
        const compliant    = job.results.filter(r => r.status === 'compliant').length;
        const nonCompliant = job.results.filter(r => r.status === 'non_compliant').length;
        const errors       = job.results.filter(r => r.status === 'error').length;
        log(`\n✔ Audit complete — ${compliant} compliant, ${nonCompliant} non-compliant, ${errors} error(s)`);
    }
}

// ════════════════════════════════════════════════════════════════
// SSH HELPER  — fetch "show running-config" via PTY shell
// ════════════════════════════════════════════════════════════════

async function fetchRunningConfig(device, cred) {
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

    const ssh = new NodeSSH();
    await ssh.connect(sshCfg);
    if (ssh.connection) {
        ssh.connection.on('error', () => {}); // suppress post-close errors
    }

    try {
        return await new Promise((resolve, reject) => {
            let collected = '';
            let settled   = false;
            let quietTimer = null;
            const QUIET_MS = 3000;
            const HARD_MS  = 60000;

            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(quietTimer);
                resolve(collected);
            };

            ssh.requestShell({ term: 'vt100', rows: 500, cols: 220 }).then(shell => {
                const hardTimer = setTimeout(() => { if (!settled) finish(); }, HARD_MS);

                shell.on('data', chunk => {
                    collected += chunk.toString();
                    clearTimeout(quietTimer);
                    quietTimer = setTimeout(finish, QUIET_MS);
                });
                shell.on('close', () => { clearTimeout(hardTimer); finish(); });
                shell.on('error', err => { clearTimeout(hardTimer); if (!settled) reject(err); });

                // Sequence: wait for prompt → disable paging → fetch config
                setTimeout(() => {
                    shell.write('terminal length 0\n');
                    setTimeout(() => {
                        shell.write('show running-config\n');
                    }, 600);
                }, 1000);
            }).catch(reject);
        });
    } finally {
        try { ssh.dispose(); } catch (_) {}
    }
}

// ════════════════════════════════════════════════════════════════
// COMPLIANCE CHECK LOGIC
// ════════════════════════════════════════════════════════════════

/**
 * Compare the golden config against the running config line by line.
 *
 * Rules:
 *  - Blank lines in golden config are ignored
 *  - Lines starting with ! (IOS comments) are ignored
 *  - Each remaining golden line must appear verbatim (preserving indentation)
 *    somewhere in the running config output
 */
function checkComplianceLines(goldenConfigText, runningConfigText) {
    const goldenLines = goldenConfigText
        .split('\n')
        .map(l => l.replace(/\r/g, '').trimEnd())
        .filter(l => l.trim().length > 0 && !l.trim().startsWith('!'));

    const runningLineSet = new Set(
        runningConfigText
            .split('\n')
            .map(l => l.replace(/\r/g, '').trimEnd())
            .filter(l => l.trim().length > 0)
    );

    const lineResults = goldenLines.map(line => ({
        line,
        found: runningLineSet.has(line)
    }));

    const missingLines = lineResults.filter(r => !r.found).map(r => r.line);

    return {
        compliant:    missingLines.length === 0,
        lineResults,
        missingLines,
        totalLines:   goldenLines.length,
        matchedLines: goldenLines.length - missingLines.length
    };
}

module.exports = router;
