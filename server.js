/**
 * server.js  –  configify
 * Express + Passport (local/LDAP/SAML) + WebSocket SSH streaming
 */
require('dotenv').config();

const express        = require('express');
const http           = require('http');
const session        = require('express-session');
const pgSession      = require('connect-pg-simple')(session);
const cors           = require('cors');
const WebSocket      = require('ws');
const url            = require('url');

const db             = require('./db');
const { passport, initAuth } = require('./auth');
const authRoutes     = require('./routes/auth');
const userRoutes     = require('./routes/users');
const deviceRoutes   = require('./routes/devices');
const sshRoutes      = require('./routes/ssh');
const { requireAuth } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── Session store in PostgreSQL ────────────────────────────────
const sessionMiddleware = session({
    store: new pgSession({
        pool: db.pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret:            process.env.SESSION_SECRET || 'change-this-secret-in-production',
    resave:            false,
    saveUninitialized: false,
    cookie: {
        secure:   process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge:   8 * 60 * 60 * 1000   // 8 hours
    }
});

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: false }));          // same-origin only
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ── Static files (public folder) ──────────────────────────────
// Protected: redirect to login if not authenticated
app.use((req, res, next) => {
    const publicPaths = ['/login.html', '/auth/', '/favicon.ico'];
    const isPublicFile = publicPaths.some(p => req.path.startsWith(p));
    // Let API routes and public pages through
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || isPublicFile) {
        return next();
    }
    // Serve static files — if authenticated
    if (req.isAuthenticated()) return next();
    // Not authenticated — serve static only for login page
    if (req.path === '/' || req.path === '/index.html') {
        return res.redirect('/login.html');
    }
    if (req.path.endsWith('.html')) {
        return res.redirect('/login.html');
    }
    next();
});

app.use(express.static('public'));

// ── API Routes ─────────────────────────────────────────────────
app.use('/auth',               authRoutes);
app.use('/api/users',          userRoutes);
app.use('/api/devices',        deviceRoutes);
app.use('/api/ssh',            requireAuth, sshRoutes);

// Templates routes (preserved from v1)
const templateRoutes = require('./routes/templates');
app.use('/api/templates',      requireAuth, templateRoutes);

// ── SPA fallback ───────────────────────────────────────────────
app.use((req, res) => {
    if (req.isAuthenticated()) {
        res.sendFile(__dirname + '/public/index.html');
    } else {
        res.redirect('/login.html');
    }
});

// ── WebSocket SSH streaming ────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
sshRoutes.attachSshWebSocket(wss);

// Upgrade handler — share express session with WS
server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws/ssh/')) {
        socket.destroy();
        return;
    }
    // Parse session so we can auth the WS connection
    sessionMiddleware(req, {}, () => {
        passport.initialize()(req, {}, () => {
            passport.session()(req, {}, () => {
                wss.handleUpgrade(req, socket, head, (ws) => {
                    wss.emit('connection', ws, req);
                });
            });
        });
    });
});

// ── Start ──────────────────────────────────────────────────────
async function start() {
    await initAuth();   // load LDAP/SAML strategies from DB config
    server.listen(PORT, () => {
        console.log(`✅ configify running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV}`);
        console.log(`🔌 WebSocket SSH endpoint: ws://localhost:${PORT}/ws/ssh/:logId`);
    });
}

start().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
