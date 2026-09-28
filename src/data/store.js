'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Lokale SQLite-Datenbank (bot/data/bot.db – per .gitignore nie im Repo).
 * Profile enthalten Kartendaten → bleiben NUR hier, werden nie geloggt oder exportiert.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS results  (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT, site TEXT, mode TEXT, status TEXT, order_id TEXT,
  latency TEXT, detail TEXT, at TEXT NOT NULL
);`;


class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  saveTask(def) {
    this.db.prepare('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)').run(def.id, JSON.stringify(def));
  }

  tasks() {
    return this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map((r) => JSON.parse(r.data));
  }

  saveProfile(p) {
    this.db.prepare('INSERT OR REPLACE INTO profiles (id, name, data) VALUES (?, ?, ?)').run(p.uuid, p.name, JSON.stringify(p));
  }

  /** Nur Namen/IDs – für Listen und Logs. */
  profileNames() {
    return this.db.prepare('SELECT id, name FROM profiles ORDER BY rowid').all();
  }

  /** Volles Profil – nur zur Übergabe an den Seitenadapter im Prozess. */
  profile(idOrName) {
    const r = this.db.prepare('SELECT data FROM profiles WHERE id = ? OR name = ?').get(idOrName, idOrName);
    return r ? JSON.parse(r.data) : null;
  }

  saveResult(task) {
    const s = task.summary();
    this.db.prepare(
      'INSERT INTO results (task_id, site, mode, status, order_id, latency, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(s.id, s.site, s.mode, s.status, task.result ? task.result.orderId : null, JSON.stringify(s.latency), s.detail, new Date().toISOString());
  }

  /** Nur echte Checkouts (status success mit Bestellnummer). */
  checkouts() {
    return this.db.prepare("SELECT * FROM results WHERE status = 'success' AND order_id IS NOT NULL ORDER BY id DESC").all();
  }

  /** Import profiles from a JSON array: [{ uuid, name, shipping, ... }]. */
  importProfiles(file) {
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of profiles) this.saveProfile(p);
    return profiles.length;
  }

  /** Import task definitions from a JSON array; entries for unknown sites are skipped. */
  importTasks(file, knownSites) {
    const defs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = { imported: 0, skipped: [] };
    defs.forEach((d, i) => {
      if (knownSites && !knownSites.includes(d.site)) { out.skipped.push(`entry ${i}: unknown site "${d.site}"`); return; }
      this.saveTask({ id: d.id || `t${Date.now().toString(36)}${i}`, ...d });
      out.imported++;
    });
    return out;
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
