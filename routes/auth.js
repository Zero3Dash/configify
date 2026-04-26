/**
 * routes/auth.js
 * Login / logout endpoints for local, LDAP, and SAML.
 *
 * Security fix (v2.8.2): brute-force rate limiting is now applied to the
 * two password-based login endpoints:
 *
 *   POST /auth/login/local   — 10 attempts per IP per 15 minutes
 *   POST /auth/login/ldap    — 10 attempts per IP per 15 minutes
 *
 * Successful logins do not count against the limit (skipSuccessfulRequests).
 * A blocked IP receives HTTP 429 with a JSON error body and a Retry-After
 * header telling it when the window resets.
 *
 * SAML login (/auth/saml/login) is a redirect to the IdP and never accepts
 * a password, so no rate limiting is applied there.
 *
 * Note: effective IP detection depends on `trust proxy` being set correctly
 * in server.js (fix #1 scopes this to NODE_ENV === 'production' so it only
 * trusts the X-Forwarded-For header when actually behind Nginx).
 */
const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db       = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Rate limiter — applied to password-based login routes only ──
//
// Configuration rationale:
//   • 10 attempts / 15 min per IP — enough for a user who misremembers a
//     password, tight enough to make credential-stuffing impractical
//   • skipSuccessfulRequests — legitimate users who log in successfully do
//     not burn through their allowance
//   • standardHeaders: 'draft-7' — sends RateLimit-* headers so API clients
//     can inspect limits; legacyHeaders disabled to avoid X-RateLimit-* clutter
//   • The error is JSON so the login page can display it normally
//
const loginRateLimiter = rateLimit({
    windowMs:               15 * 60 * 1000,   // 15-minute sliding window
    max:                    10,                // max failed attempts per IP
    skipSuccessfulRequests: true,              // successful logins are free
    standardHeaders:        'draft-7',         // RateLimit-* response headers
    legacyHeaders:          false,             // suppress X-RateLimit-* headers
    message: {
        error: 'Too many login attempts from this IP address. Please wait 15 minutes before trying again.'
    },
    // Return JSON regardless of Accept header — the login endpoints are
    // always called as fetch() API requests from the login page.
    handler: (req, res, next, options) => {
        res.status(options.statusCode).json(options.message);
    },
    // Key by IP address. In production, req.ip is the real client IP because
    // trust proxy is enabled in server.js (fix #1). In development it is the
    // direct connection address, which is correct for local testing.
    keyGenerator: (req) => req.ip,
    // Skip the rate limiter entirely if req.ip is undefined (e.g. during
    // unit tests that don't set up a full HTTP stack).
    skip: (req) => !req.ip,
});

// ── Current user info ──────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    const { id, username, email, role, auth_provider } = req.user;
    res.json({ id, username, email, role, auth_provider });
});

// ── Local login ────────────────────────────────────────────────
router.post('/login/local', loginRateLimiter, (req, res, next) => {
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
router.post('/login/ldap', loginRateLimiter, (req, res, next) => {
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
// No rate limit — this redirects to the external IdP and never accepts
// a password directly. The IdP is responsible for its own brute-force protection.
router.get('/saml/login', passport.authenticate('saml'));

// ── SAML: callback from IdP ────────────────────────────────────
router.post('/saml/callback',
    passport.authenticate('saml', { failureRedirect: '/login.html?error=saml' }),
    (req, res) => res.redirect('/')
);

// ── SAML: logout ───────────────────────────────────────────────
router.get('/saml/logout', requireAuth, (req, res, next) => {
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
