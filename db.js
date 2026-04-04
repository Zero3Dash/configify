/**
 * db.js
 * PostgreSQL connection pool — shared across all route modules.
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'configify_db',
    user:     process.env.DB_USER     || 'configify_user',
    password: process.env.DB_PASSWORD,
    max:                    20,    // maximum pool size
    idleTimeoutMillis:   30000,    // close idle clients after 30 s
    connectionTimeoutMillis: 2000, // error if no connection in 2 s
});

// Verify connectivity on startup
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.stack);
    } else {
        console.log('✅ PostgreSQL connected');
        release();
    }
});

pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
});

module.exports = {
    query:  (text, params) => pool.query(text, params),
    pool,
};
