import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS x_requests (
        id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS x_requests_time ON x_requests(created_at);
      CREATE TABLE IF NOT EXISTS raids (
        key TEXT PRIMARY KEY, target_id TEXT, message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL, text TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', x_post_id TEXT,
        next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
  get(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; }
  set(key, value) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getRaid(key) { return this.db.prepare('SELECT * FROM raids WHERE key=?').get(key); }
  xUsage(now) {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM x_requests').get().n;
    const requests24h = this.db.prepare('SELECT COUNT(*) AS n FROM x_requests WHERE created_at>?').get(now - 86400).n;
    const posts24h = this.db.prepare("SELECT COUNT(*) AS n FROM x_requests WHERE method='POST' AND created_at>?").get(now - 86400).n;
    const lastPost = this.db.prepare("SELECT MAX(created_at) AS n FROM x_requests WHERE method='POST'").get().n;
    return { total, requests24h, posts24h, lastPost };
  }
  cancelPending(raid, useRunId) {
    if (useRunId) {
      this.db.prepare("UPDATE raids SET status='skipped', detail='Raid ended before delivery.' WHERE key=? AND status='pending'").run(raid.key);
    } else {
      // A completion may be a separate refreshed message. Its original message
      // ID bounds the starts it can cancel, so an old edited completion cannot
      // cancel a newer raid of the same target.
      this.db.prepare(`UPDATE raids SET status='skipped', detail='Raid ended before delivery.'
        WHERE status='pending' AND substr(key,1,?)=? AND target_id=? AND message_id<=?`)
        .run(raid.scope.length, raid.scope, raid.targetId, raid.messageId);
    }
  }
  add(raid, text, mode, status, detail = '') {
    return this.db.prepare(`INSERT OR IGNORE INTO raids
      (key,target_id,message_id,created_at,text,mode,status,detail) VALUES (?,?,?,?,?,?,?,?)`)
      .run(raid.key, raid.targetId, raid.messageId, raid.date, text, mode, status, detail).changes > 0;
  }
  update(key, status, detail = '', postId = null, nextAttempt = 0) {
    this.db.prepare('UPDATE raids SET status=?, detail=?, x_post_id=?, next_attempt=? WHERE key=?')
      .run(status, detail, postId, nextAttempt, key);
  }
  claim(now) {
    return this.db.prepare(`UPDATE raids SET status='posting', attempts=attempts+1
      WHERE key=(SELECT key FROM raids WHERE status='pending' AND next_attempt<=? ORDER BY created_at LIMIT 1)
      RETURNING *`).get(now);
  }
  recover() {
    return this.transaction(() => {
      const recovered = this.db.prepare(`UPDATE raids SET status='uncertain', detail='Process stopped during delivery; inspect X before any manual action.'
        WHERE status='posting'`).run().changes;
      if (recovered) {
        this.set('posting_paused', 'Process stopped during an X delivery; inspect X before resuming.');
        this.skipPending('Skipped after an interrupted X delivery.');
      }
      return recovered;
    });
  }
  skipPendingFromPreviousSession() {
    return this.skipPending('Not sent: bot restarted before delivery.');
  }
  skipPending(detail) {
    return this.db.prepare("UPDATE raids SET status='skipped', detail=? WHERE status='pending'").run(detail).changes;
  }
  recent() { return this.db.prepare('SELECT * FROM raids ORDER BY rowid DESC LIMIT 5').all(); }
  close() { this.db.close(); }
}
