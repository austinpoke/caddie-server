/**
 * server.js — Caddie Backend Proxy
 * ──────────────────────────────────────────────────────────────────────────
 * Express server that proxies requests to the GHIN API, enabling both the
 * Caddie web app and future iOS app to perform GHIN lookups without hitting
 * CORS restrictions.
 *
 * Start:        node server.js
 * Development:  npm run dev   (requires nodemon)
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const ghinRouter    = require('./routes/ghin');
const errorHandler  = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Allowed origins ──────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500')
  .split(',')
  .map(o => o.trim());

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. iOS app, Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
// Login: max 10 attempts per 15 minutes per IP (brute-force protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: true, message: 'Too many login attempts. Try again in 15 minutes.' }
});

// Search: max 60 requests per minute per IP
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: true, message: 'Too many requests. Slow down.' }
});

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());

// ── Request logging ──────────────────────────────────────────────────────────
app.use(requestLogger);

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check — useful for deployment monitoring (Railway, Render, etc.)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'caddie-server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// GHIN proxy routes (rate limited individually)
app.use('/api/ghin/login',  loginLimiter);
app.use('/api/ghin/search', searchLimiter);
app.use('/api/ghin',        ghinRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: true, message: `Route ${req.method} ${req.path} not found` });
});

// Central error handler (must be last)
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ⛳  Caddie Server');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Listening on  http://localhost:${PORT}`);
  console.log(`  GHIN API      ${process.env.GHIN_API_BASE || 'https://api.ghin.com/api/v1'}`);
  console.log(`  Allowed CORS  ${allowedOrigins.join(', ')}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    POST  http://localhost:${PORT}/api/ghin/login`);
  console.log(`    GET   http://localhost:${PORT}/api/ghin/search?q=<name or GHIN>`);
  console.log(`    GET   http://localhost:${PORT}/api/ghin/golfer/:ghinNumber`);
  console.log(`    GET   http://localhost:${PORT}/api/ghin/health`);
  console.log('');
});

module.exports = app;
