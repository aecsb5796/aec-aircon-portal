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
  role TEXT NOT NULL CHECK(role IN ('technician','head')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_ref TEXT UNIQUE NOT NULL,
  technician_id INTEGER NOT NULL,
  technician_name TEXT NOT NULL,
  service_date TEXT NOT NULL,
  service_type TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_address TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  unit_location TEXT,
  unit_details TEXT,
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
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','reviewed','approved','sent')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (technician_id) REFERENCES users(id)
);
`);

// Seed default accounts if none exist
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const insert = db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)');
  insert.run('tech1', bcrypt.hashSync('tech1234', 10), 'Ahmad Bin Yusof', 'technician');
  insert.run('tech2', bcrypt.hashSync('tech1234', 10), 'Siti Nurhaliza', 'technician');
  insert.run('head', bcrypt.hashSync('head1234', 10), 'Hj. Rahman (Head of Dept)', 'head');
  console.log('Seeded default users: tech1/tech1234, tech2/tech1234, head/head1234');
}

module.exports = db;
