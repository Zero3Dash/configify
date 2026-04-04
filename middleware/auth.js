/**
 * middleware/auth.js
 * Express middleware for route protection.
 */

function requireAuth(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) return next();
    if (req.headers['accept'] && req.headers['accept'].includes('application/json')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        if (req.headers['accept']?.includes('application/json')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login.html');
    }
    if (req.user.role !== 'admin') {
        if (req.headers['accept']?.includes('application/json')) {
            return res.status(403).json({ error: 'Admin role required' });
        }
        return res.status(403).send('Forbidden: admin role required');
    }
    next();
}

module.exports = { requireAuth, requireAdmin };
