const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// pg.Pool reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from env automatically.
const pool = new Pool({
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 30000,
  max: 5,
});

let dbReady = false;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function pollDb() {
  try {
    await pool.query('SELECT 1');
    if (!dbReady) await ensureSchema();
    dbReady = true;
  } catch (err) {
    dbReady = false;
    console.error(`[db] not ready: ${err.message}`);
  }
}

// Poll in the background instead of blocking startup, so the process comes
// up (and liveness passes) even while the DB dependency is unavailable.
// Readiness reflects real DB state so traffic only routes once we can serve it.
setInterval(pollDb, 3000);
pollDb();

app.get('/', (_req, res) => {
  res.json({ service: 'devops-challenge-backend', status: 'ok' });
});

// Liveness: is the node process itself alive and able to handle HTTP?
// Deliberately does NOT touch the database — a slow/down DB should not
// cause Kubernetes to kill and restart a perfectly healthy process.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness: can this pod actually serve traffic right now?
// Backed by the last background DB poll result (cheap, no per-request query).
app.get('/readyz', (_req, res) => {
  if (dbReady) {
    res.status(200).json({ status: 'ready', db: 'connected' });
  } else {
    res.status(503).json({ status: 'not-ready', db: 'disconnected' });
  }
});

app.get('/items', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, name, created_at FROM items ORDER BY id DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(503).json({ error: 'database unavailable', detail: err.message });
  }
});

app.post('/items', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'body must include a string "name"' });
  }
  try {
    const result = await pool.query('INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at', [name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(503).json({ error: 'database unavailable', detail: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`backend listening on :${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
