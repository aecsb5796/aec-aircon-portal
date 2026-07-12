// Persistent database via Turso (hosted libSQL / SQLite-compatible, free
// tier). This replaces the earlier setup where the database lived only in a
// local file (data/aec.db) on Render's free-tier disk. Render's free plan
// has no persistent disk, so that file was wiped on every deploy/restart —
// losing every submitted report and resetting the K-number job reference
// sequence back to K000001 each time. Turso keeps the data (and the running
// number) intact across deploys, restarts, and redeploys.
//
// Requires two environment variables (set in .env locally, and as Render
// environment variables in production):
//   TURSO_DATABASE_URL  e.g. libsql://aec-portal-xxxx.aws-ap-south-1.turso.io
//   TURSO_AUTH_TOKEN     the token generated for that database
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set as environment variables.');
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Thin wrapper so the rest of the app can use a familiar
// db.prepare(sql).run/get/all(...) shape — just async (returns Promises)
// instead of sync, since Turso is a remote database reached over the
// network rather than a local file.
const db = {
  exec: async (sql) => { await client.executeMultiple(sql); },
  prepare: (sql) => ({
    run: async (...params) => {
      const result = await client.execute({ sql, args: params });
      return {
        lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
        changes: result.rowsAffected
      };
    },
    get: async (...params) => {
      const result = await client.execute({ sql, args: params });
      return result.rows[0];
    },
    all: async (...params) => {
      const result = await client.execute({ sql, args: params });
      return result.rows;
    }
  })
};

async function init() {
  await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('technician','head','scheduler')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT UNIQUE NOT NULL,
  technician_id INTEGER NOT NULL,
  technician_name TEXT NOT NULL,
  service_date TEXT,
  service_type TEXT,
  customer_name TEXT NOT NULL,
  customer_address TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  unit_location TEXT,
  unit_details TEXT,
  complaint_description TEXT,
  job_sheet_no TEXT,
  written_name TEXT,
  team_members TEXT,
  amount TEXT,
  assigned_by INTEGER,
  checklist_json TEXT,
  work_performed TEXT,
  findings TEXT,
  parts_json TEXT,
  photos_json TEXT,
  technician_notes TEXT,
  recommendations TEXT,
  next_service_date TEXT,
  technician_signature TEXT,
  customer_signature TEXT,
  customer_ack INTEGER DEFAULT 0,
  head_remarks TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('assigned','submitted','reviewed','approved','sent')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

  // Sessions used to live only in the server process's memory
  // (express-session's default MemoryStore), so everyone got logged out
  // whenever the server restarted — e.g. on every Render redeploy. They're
  // now stored in this same persistent database instead (see
  // session-store.js). Sweep out anything already expired on startup so the
  // table doesn't grow forever.
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

  // Defensive migration: add new columns to a reports table that already
  // existed from an earlier deploy (SQLite has no "ADD COLUMN IF NOT EXISTS",
  // so we just try each one and ignore the "duplicate column" error).
  const newColumns = [
    'job_sheet_no', 'written_name', 'team_members', 'amount', 'date_started', 'date_finished',
    // Older, now-unused single-unit fields (superseded by units_json below,
    // which supports recording multiple units per job). Left in the schema
    // rather than dropped, consistent with this project's migration style.
    'unit_model', 'unit_serial', 'operating_pressure_psi', 'current_ampere',
    // Repeatable list of units serviced on this job — JSON array of
    // { model, serial, psi, ampere }.
    'units_json'
  ];
  for (const col of newColumns) {
    try {
      await db.exec(`ALTER TABLE reports ADD COLUMN ${col} TEXT`);
    } catch (e) {
      // Column already exists — fine.
    }
  }

  // Remove old demo accounts that have been replaced (safe no-op if they
  // were never created, e.g. on a fresh database).
  const legacyUsernames = ['tech1', 'tech2', 'alexteam', 'scheduler1'];
  const dropLegacy = db.prepare('DELETE FROM users WHERE username = ?');
  for (const u of legacyUsernames) {
    await dropLegacy.run(u);
  }

  // Real staff accounts. Upserted (insert or update-in-place) on every
  // startup so usernames/passwords/names stay correct even if the database
  // already existed from a previous deploy.
  const accounts = [
    { username: 'alex', password: 'alexaec', name: 'Alex', role: 'technician' },
    { username: 'christian', password: 'christaec', name: 'Christian', role: 'technician' },
    { username: 'fredie', password: 'Fredaec', name: 'Fredie', role: 'technician' },
    { username: 'leo', password: 'Leoaec', name: 'Leo', role: 'technician' },
    { username: 'lester', password: 'Lesteraec', name: 'Lester', role: 'technician' },
    { username: 'khonglak', password: 'Khongaec', name: 'Khonglak', role: 'technician' },
    { username: 'wawantiyo', password: 'wawanaec', name: 'Wawantiyo', role: 'technician' },
    { username: 'marcial', password: 'marcialaec', name: 'Marcial', role: 'technician' },
    { username: 'aecnora', password: 'aec5796', name: 'Nora (Scheduler)', role: 'scheduler' },
    { username: 'head', password: 'head5796', name: 'Hj. Rahman (Head of Dept)', role: 'head' }
  ];

  const upsert = db.prepare(`
    INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      name = excluded.name,
      role = excluded.role
  `);
  for (const a of accounts) {
    await upsert.run(a.username, bcrypt.hashSync(a.password, 10), a.name, a.role);
  }
  console.log('Accounts ready: ' + accounts.map((a) => a.username).join(', '));
}

// Resolves once schema creation, migrations, and account upserts are done.
// The server waits on this before it starts accepting requests.
const ready = init().catch((err) => {
  console.error('Database initialization failed:', err);
  throw err;
});

module.exports = { db, ready };
