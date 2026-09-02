require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();

// ── MIDDLEWARE ─────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [
    'https://wealthguard-rho.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
// NOTE: no separate app.options('*', cors()) here — the cors() middleware
// above already handles OPTIONS preflight automatically for every route.
// The explicit wildcard version was not only redundant, it's what crashed
// the whole server: newer path-to-regexp (pulled in by Node 24) dropped
// support for the bare '*' pattern and throws instead of matching it.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── STATIC FRONTEND ───────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── API ROUTES ────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/clients',      require('./routes/clients'));
app.use('/api/portfolio',    require('./routes/portfolio'));
app.use('/api/signals',      require('./routes/signals'));
app.use('/api/market',       require('./routes/market'));
app.use('/api/brief',        require('./routes/brief'));
app.use('/api/goals',        require('./routes/goals'));
app.use('/api/whatsapp',     require('./routes/whatsapp'));
app.use('/api/payments',     require('./routes/payments'));

// ── FRONTEND SPA fallback ─────────────────────────
// Uses app.use() with no path pattern at all, instead of app.get('*', ...).
// A bare '*' string has to be parsed as a route pattern by path-to-regexp,
// which is exactly what crashed above — app.use() with no path never goes
// through that parser, so this form is safe under any router version.
app.use((req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
  }
});

// ── ERROR HANDLER ─────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ── SCHEDULERS ────────────────────────────────────
const { startSchedulers } = require('./services/scheduler');
if (process.env.NODE_ENV !== 'test') startSchedulers();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🛡️  WealthGuard Platform v1.0`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
