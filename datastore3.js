// Uses Node's built-in SQLite module (available in Node.js 22.5+), so there
// is no native module to compile — this keeps installation simple on any host.
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const rawDb = new DatabaseSync(path.join(dataDir, 'aec.db'));
rawDb.exec('PRAGMA journal_mode = WAL;');

// Thin wrapper so the rest of the app can use the same better-sqlite3-style
// API (db.prepare(sql).run/get/all, db.exec(sql)) without further changes.
const db = {
  exec: (sql) => rawDb.exec(sql),
  prepare: (sql) => {
    const stmt = rawDb.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params)
    };
  }
};

db.exec(`
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
`);

// Defensive migration: add new columns to a reports table that already
// existed from an earlier deploy (SQLite has no "ADD COLUMN IF NOT EXISTS",
// so we just try each one and ignore the "duplicate column" error).
['job_sheet_no', 'written_name', 'team_members', 'amount'].forEach((col) => {
  try {
    db.exec(`ALTER TABLE reports ADD COLUMN ${col} TEXT`);
  } catch (e) {
    // Column already exists — fine.
  }
});

// Remove old demo accounts that have been replaced (safe no-op if they
// were never created, e.g. on a fresh database).
const legacyUsernames = ['tech1', 'tech2', 'alexteam', 'scheduler1'];
const dropLegacy = db.prepare('DELETE FROM users WHERE username = ?');
legacyUsernames.forEach((u) => dropLegacy.run(u));

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
accounts.forEach((a) => {
  upsert.run(a.username, bcrypt.hashSync(a.password, 10), a.name, a.role);
});
console.log('Accounts ready: ' + accounts.map((a) => a.username).join(', '));

module.exports = db;
