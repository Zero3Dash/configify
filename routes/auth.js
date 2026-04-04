/**
 * routes/auth.js
 * Login / logout endpoints for local, LDAP, and SAML.
 */
const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcrypt');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Current user info ──────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    const { id, username, email, role, auth_provider } = req.user;
    res.json({ id, username, email, role, auth_provider });
});

// ── Local login ────────────────────────────────────────────────
router.post('/login/local', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err)   return next(err);
        if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
        req.logIn(user, (err) => {
            if (err) return next(err);
            res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
        });
    })(req, res, next);
});

// ── LDAP login ─────────────────────────────────────────────────
router.post('/login/ldap', (req, res, next) => {
    passport.authenticate('ldap', (err, user, info) => {
        if (err)   return next(err);
        if (!user) return res.status(401).json({ error: info?.message || 'LDAP authentication failed' });
        req.logIn(user, (err) => {
            if (err) return next(err);
            res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
        });
    })(req, res, next);
});

// ── SAML: redirect to IdP ──────────────────────────────────────
router.get('/saml/login', passport.authenticate('saml'));

// ── SAML: callback from IdP ────────────────────────────────────
router.post('/saml/callback',
    passport.authenticate('saml', { failureRedirect: '/login.html?error=saml' }),
    (req, res) => res.redirect('/')
);

// ── SAML: logout ───────────────────────────────────────────────
router.get('/saml/logout', requireAuth, (req, res, next) => {
    // For SAML SLO; falls back to local logout if strategy not registered
    if (req.user?.auth_provider === 'saml') {
        try {
            return req.logout(err => {
                if (err) return next(err);
                res.redirect('/login.html');
            });
        } catch { /* fall through */ }
    }
    req.logout((err) => { if (err) return next(err); res.redirect('/login.html'); });
});

// ── General logout ─────────────────────────────────────────────
router.post('/logout', (req, res, next) => {
    req.logout((err) => { if (err) return next(err); res.json({ ok: true }); });
});

// ── Change own password (local accounts only) ──────────────────
router.post('/change-password', requireAuth, async (req, res) => {
    if (req.user.auth_provider !== 'local') {
        return res.status(400).json({ error: 'Password change not supported for your auth provider' });
    }
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    try {
        const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Current password incorrect' });
        const hash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Auth provider status (public — for login page to show buttons) ──
router.get('/providers', async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT provider, enabled FROM auth_config ORDER BY provider'
        );
        const providers = { local: true };
        rows.forEach(r => { providers[r.provider] = r.enabled; });
        res.json(providers);
    } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

module.exports = router;
