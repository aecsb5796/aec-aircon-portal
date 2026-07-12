// Custom express-session store backed by the same persistent Turso database
// as the rest of the app (see datastore5.js). This replaces express-session's
// default in-memory store, which loses every logged-in session — forcing
// everyone to log back in — whenever the server process restarts, which
// happens on every Render redeploy.
const session = require('express-session');

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours, matches cookie.maxAge below

class TursoSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
  }

  get(sid, callback) {
    this.db.prepare('SELECT data, expires_at FROM sessions WHERE id = ?').get(sid)
      .then(async (row) => {
        if (!row) return callback(null, null);
        if (row.expires_at && row.expires_at < Date.now()) {
          // Expired — clean it up and report as if it never existed.
          await this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid).catch(() => {});
          return callback(null, null);
        }
        callback(null, JSON.parse(row.data));
      })
      .catch((err) => callback(err));
  }

  set(sid, sessionData, callback) {
    const expiresAt = (sessionData.cookie && sessionData.cookie.expires)
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + DEFAULT_TTL_MS;
    this.db.prepare(`
      INSERT INTO sessions (id, data, expires_at) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
    `).run(sid, JSON.stringify(sessionData), expiresAt)
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  destroy(sid, callback) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  // Refreshes a session's expiry (called on activity when rolling sessions
  // are used) without needing to rewrite the whole session payload.
  touch(sid, sessionData, callback) {
    const expiresAt = (sessionData.cookie && sessionData.cookie.expires)
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + DEFAULT_TTL_MS;
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, sid)
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }
}

module.exports = TursoSessionStore;
