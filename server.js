/**
 * server.js  –  configify
 * Express + Passport (local/LDAP/SAML)
 */
require('dotenv').config();

// ── Startup environment assertions ─────────────────────────────
// Fail fast: if any required secret is missing, crash immediately
// with a clear message rather than silently using a fallback or
// failing on the first request that needs the value.
(function assertEnv() {
    const required = [
        {
            key:  'SESSION_SECRET',
            hint: 'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        },
        {
            key:  'VAULT_SECRET',
            hint: 'Must be a 64-char hex string (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        },
        {
            key:  'DB_PASSWORD',
            hint: 'Set the PostgreSQL password for the configify_user account.',
        },
    ];

    const missing = required.filter(({ key }) => !process.env[key]);

    if (missing.length > 0) {
        console.error('\n❌  configify cannot start — required environment variables are not set:\n');
        missing.forEach(({ key, hint }) => {
            console.error(`  • ${key}`);
            console.error(`    ${hint}\n`);
        });
        console.error('  Add these values to your .env file (see .env.example) and restart.\n');
        process.exit(1);
    }

    // Additional quality checks — catch obviously invalid values that
    // would pass the presence check but still be insecure.
    const sessionSecret = process.env.SESSION_SECRET;
    if (sessionSecret.length < 32) {
        console.error('❌  SESSION_SECRET must be at least 32 characters long.');
        process.exit(1);
    }

    const vaultSecret = process.env.VAULT_SECRET;
    if (!/^[0-9a-f]{64}$/i.test(vaultSecret)) {
        console.error('❌  VAULT_SECRET must be exactly 64 lowercase hex characters (32 bytes).');
        console.error('    Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        process.exit(1);
    }

    console.log('✅  Environment variables validated');
})();

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

// Only trust the immediate upstream proxy in production.
// Without this guard, req.ip is attacker-controlled when the app
// is reached directly (e.g. in development or if Nginx is bypassed),
// which defeats any IP-based rate limiting.
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// ── Session store ──────────────────────────────────────────────
const sessionMiddleware = session({
    store: new pgSession({
        pool:                 db.pool,
        tableName:            'user_sessions',
        createTableIfMissing: true,
    }),
    // SESSION_SECRET is guaranteed to be set and at least 32 chars by assertEnv() above.
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        secure:   process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict',  // free CSRF mitigation — no token needed for same-origin requests
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
app.use((req, res) => {
    if (req.isAuthenticated()) return res.sendFile(__dirname + '/public/index.html');
    res.redirect('/login.html');
});

// ── Start ──────────────────────────────────────────────────────
async function start() {
    await initAuth();
    startScheduler();
    http.createServer(app).listen(PORT, () => {
        console.log(`[server] configify running on http://localhost:${PORT}`);
        console.log(`[server] NODE_ENV=${process.env.NODE_ENV}`);
    });
}

start().catch(err => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
});
