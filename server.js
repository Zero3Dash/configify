/**
 * server.js  –  configify
 * Express + Passport (local/LDAP/SAML)
 */
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const cors       = require('cors');

const db                                       = require('./db');
const { passport, initAuth }                   = require('./auth');
const authRoutes                               = require('./routes/auth');
const userRoutes                               = require('./routes/users');
const deviceRoutes                             = require('./routes/devices');
const sshRoutes                                = require('./routes/ssh');
const templateRoutes                           = require('./routes/templates');
const { router: complianceRoutes,
        startScheduler }                       = require('./routes/compliance');
const { requireAuth }                          = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ── Session store ──────────────────────────────────────────────
const sessionMiddleware = session({
    store: new pgSession({
        pool:                 db.pool,
        tableName:            'user_sessions',
        createTableIfMissing: true,
    }),
    secret:            process.env.SESSION_SECRET || 'change-this-secret-in-production',
    resave:            false,
    saveUninitialized: false,
    cookie: {
        secure:   process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge:   8 * 60 * 60 * 1000,  // 8 hours
    },
});

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ── Auth gate for HTML pages ───────────────────────────────────
app.use((req, res, next) => {
    const publicPaths = ['/login.html', '/auth/', '/favicon.ico'];
    if (publicPaths.some(p => req.path.startsWith(p))) return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
    if (req.isAuthenticated()) return next();
    if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login.html');
    next();
});

app.use(express.static('public'));

// ── API Routes ─────────────────────────────────────────────────
app.use('/auth',             authRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/devices',      deviceRoutes);
app.use('/api/ssh',          requireAuth, sshRoutes);
app.use('/api/templates',    requireAuth, templateRoutes);
app.use('/api/compliance',   requireAuth, complianceRoutes);

// ── SPA fallback ───────────────────────────────────────────────
// Authenticated users land on the dashboard (index.html).
// The old "Use" page is now at /deploy.html — served as a static file above.
app.use((req, res) => {
    if (req.isAuthenticated()) return res.sendFile(__dirname + '/public/index.html');
    res.redirect('/login.html');
});

// ── Start ──────────────────────────────────────────────────────
async function start() {
    await initAuth();
    startScheduler();          // ← start the compliance schedule ticker
    http.createServer(app).listen(PORT, () => {
        console.log(`[server] configify running on http://localhost:${PORT}`);
        console.log(`[server] NODE_ENV=${process.env.NODE_ENV}`);
    });
}

start().catch(err => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
});
