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

app.set('trust proxy', 1);

// ── Session store ──────────────────────────────────────────────
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
        maxAge:   8 * 60 * 60 * 1000
    }
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
    const isPublic = publicPaths.some(p => req.path.startsWith(p));
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || isPublic) return next();
    if (req.isAuthenticated()) return next();
    if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login.html');
    next();
});

app.use(express.static('public'));

// ── API Routes ─────────────────────────────────────────────────
app.use('/auth',          authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/devices',   deviceRoutes);
app.use('/api/ssh',       requireAuth, sshRoutes);
app.use('/api/templates', requireAuth, require('./routes/templates'));

// ── SPA fallback ───────────────────────────────────────────────
app.use((req, res) => {
    if (req.isAuthenticated()) return res.sendFile(__dirname + '/public/index.html');
    res.redirect('/login.html');
});

// ── WebSocket — token auth, no session middleware needed ───────
const wss = new WebSocket.Server({ noServer: true });
sshRoutes.attachSshWebSocket(wss);

server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws/ssh/')) {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

// ── Start ──────────────────────────────────────────────────────
async function start() {
    await initAuth();
    server.listen(PORT, () => {
        console.log(`[server] configify running on http://localhost:${PORT}`);
        console.log(`[server] NODE_ENV=${process.env.NODE_ENV}`);
        console.log(`[server] DEBUG_SSH=${process.env.DEBUG_SSH}`);
    });
}

start().catch(err => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
});
