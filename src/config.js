'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Alles Private liegt in bot/data/ (per .gitignore ausgeschlossen):
 *   data/config.json      Einstellungen + Webhook
 *   data/bot.db           Tasks, Profile, Ergebnisse
 *   data/proxies/<name>.txt  Proxy-Listen (eine pro Datei)
 */
const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULTS = {
  webhookUrl: '',
  finalSubmit: 'auto',    // 'auto' (Standard) | 'human' – siehe README
  headless: false,        // PC-DE blockt headless
  browserChannel: 'msedge', // Microsoft Edge; '' = mitgeliefertes Chromium
  maxConcurrentWarm: 4,
  handoffTimeoutMs: 300000,
};

function loadConfig() {
  const file = path.join(DATA_DIR, 'config.json');
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...user };
  if (!['human', 'auto'].includes(cfg.finalSubmit)) throw new Error('config.finalSubmit muss "human" oder "auto" sein');
  return cfg;
}

/**
 * Proxy-Listen aus data/proxies/: .txt (eine Zeile pro Proxy) oder .json im Format
 * ({ "proxies": "ip:port:user:pass\n…" }). Gibt { name, lines } zurück.
 */
function proxyFiles() {
  const dir = path.join(DATA_DIR, 'proxies');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    if (f.endsWith('.txt')) out.push({ name: f.replace(/\.txt$/, ''), lines: fs.readFileSync(file, 'utf8') });
    if (f.endsWith('.json')) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof j.proxies === 'string') out.push({ name: f.replace(/\.json$/, ''), lines: j.proxies });
    }
  }
  return out;
}

/** Proxy-Pool inkl. gespeichertem Nutzungsstand laden. */
function loadProxyPool(cfg) {
  const { ProxyPool } = require('./net/proxies');
  const pool = new ProxyPool();
  for (const { name, lines } of proxyFiles()) pool.addList(name, lines);
  const f = path.join(DATA_DIR, 'proxy-state.json');
  if (fs.existsSync(f)) pool.importState(JSON.parse(fs.readFileSync(f, 'utf8')));
  return pool;
}

function saveProxyState(pool) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'proxy-state.json'), JSON.stringify(pool.exportState(), null, 2));
}

module.exports = { DATA_DIR, DEFAULTS, loadConfig, proxyFiles, loadProxyPool, saveProxyState };
