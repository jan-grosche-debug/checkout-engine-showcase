#!/usr/bin/env node
'use strict';

/**
 * Kommandozeile des eigenen Bots. Bedienung später zusätzlich über Discord.
 *
 *   node src/index.js import-profiles <profiles.json>
 *   node src/index.js import-tasks <tasks.json>
 *   node src/index.js tasks | profiles | checkouts
 *   node src/index.js run            → alle Tasks anwärmen, dann interaktiv (fire / at / ok / stop / status)
 */
const path = require('node:path');
const readline = require('node:readline');
const { loadConfig, loadProxyPool, saveProxyState, DATA_DIR } = require('./config');
const { Store } = require('./data/store');
const { Engine } = require('./core/engine');
const { label } = require('./net/proxies');
const { BrowserPool } = require('./browser/pool');
const { DiscordNotifier } = require('./notify/discord');
const { atTime, serverClockOffset } = require('./monitor/triggers');
const sites = require('./sites');

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[90m', x: '\x1b[0m' };
const say = (color, msg) => console.log(`${C.d}[${new Date().toTimeString().slice(0, 8)}]${C.x} ${color}${msg}${C.x}`);

const announced = new Map(); // taskId -> zuletzt angezeigte Übergabe-ID (ein "ok" gilt genau für diese)

function build() {
  const cfg = loadConfig();
  const store = new Store(path.join(DATA_DIR, 'bot.db'));
  const proxies = loadProxyPool(cfg);
  const engine = new Engine({
    sites,
    proxies,
    browsers: new BrowserPool({ headless: cfg.headless, channel: cfg.browserChannel || undefined }),
    profiles: (id) => store.profile(id),
    notifier: cfg.webhookUrl ? new DiscordNotifier({ webhookUrl: cfg.webhookUrl }) : null,
    settings: { finalSubmit: cfg.finalSubmit, maxConcurrentWarm: cfg.maxConcurrentWarm, handoffTimeoutMs: cfg.handoffTimeoutMs },
  });
  engine.on('status', (t, s) => {
    const col = s.status === 'success' ? C.g : s.status === 'failed' ? C.r : s.status === 'handoff' ? C.y : C.c;
    say(col, `[${t.id}] ${t.def.site}/${t.def.mode} → ${s.status}${s.detail ? ` – ${s.detail}` : ''}`);
    if (t.done) {
      store.saveResult(t);
      saveProxyState(proxies);
      const l = t.summary().latency;
      if (t.t0 !== null) say(C.d, `[${t.id}] Latenz: T0→Warenkorb ${l.triggerToCart ?? '–'} ms · T0→Kauf ${l.triggerToSubmit ?? '–'} ms · T0→Bestätigung ${l.triggerToConfirm ?? '–'} ms`);
    }
  });
  engine.on('handoff', (t, h) => {
    announced.set(t.id, h.id);
    say(C.y, `>>> [${t.id}] ${h.type}: ${h.message}  → danach "ok ${t.id}" eingeben`);
  });
  engine.on('info', (t, m) => say(C.y, `[${t.id}] ${m}`));
  engine.on('log', (t, m) => say(C.d, `[${t.id}] ${m}`));
  return { cfg, store, engine, proxies };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { store, engine, proxies } = build();

  switch (cmd) {
    case 'import-profiles': {
      const n = store.importProfiles(path.resolve(args[0]));
      say(C.g, `${n} Profile importiert (Kartendaten bleiben lokal in data/bot.db)`);
      break;
    }
    case 'import-tasks': {
      const r = store.importTasks(path.resolve(args[0]), Object.keys(sites));
      say(C.g, `${r.imported} Tasks importiert`);
      r.skipped.forEach((s) => say(C.y, `übersprungen: ${s}`));
      break;
    }
    case 'tasks':
      store.tasks().forEach((t) => console.log(`${t.id}  ${t.site}/${t.mode || sites[t.site].defaultMode}  ${t.input || ''}  Profil:${t.profileId ?? '-'}  Proxys:${t.proxyList ?? 'lokal'}`));
      break;
    case 'profiles':
      store.profileNames().forEach((p) => console.log(`${p.id}  ${p.name}`));
      break;
    case 'checkouts':
      store.checkouts().forEach((r) => console.log(`${r.at}  ${r.site}/${r.mode}  Bestellung ${r.order_id}  ${r.latency}`));
      break;
    case 'proxies':
      for (const [name] of proxies.lists) {
        for (const key of Object.keys(sites)) {
          const st = proxies.stats(name, key);
          console.log(`${name} @ ${key}: ${st.total} gesamt · ${st.fresh} frisch · ${st.usable} nutzbar · ${st.burned} verbrannt`);
        }
      }
      break;
    case 'modes':
      for (const s of Object.values(sites)) {
        console.log(`\n${s.name} (${s.key}) – Standard: ${s.defaultMode}`);
        for (const m of Object.values(s.modes)) console.log(`  ${m.key.padEnd(10)} [${m.transport}${m.preload ? ', preload' : ''}] ${m.why}`);
      }
      break;
    case 'run':
      await interactive(store, engine, proxies);
      return;
    default:
      console.log('Befehle: import-profiles <json> · import-tasks <json> · tasks · profiles · checkouts · proxies · modes · run');
  }
  store.close();
}

async function interactive(store, engine, proxies) {
  const defs = store.tasks();
  if (defs.length === 0) { say(C.y, 'Keine Tasks – erst "import-tasks" ausführen.'); return; }
  say(C.c, `${defs.length} Tasks werden angewärmt …`);
  for (const d of defs) engine.run(engine.add(d)).catch((e) => say(C.r, e.message));
  for (const [name] of proxies.lists) { const s = proxies.stats(name); say(C.d, `Proxys ${name}: ${s.total} geladen`); }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'bot> ' });
  console.log('Befehle: fire [site] [input] · at HH:MM:SS [site] · ok <id> · stop <id|all> · status · exit');
  rl.prompt();
  rl.on('line', async (line) => {
    const [c, a, b] = line.trim().split(/\s+/);
    try {
      if (c === 'fire') say(C.g, `${engine.trigger({ site: a, input: b })} Task(s) gefeuert`);
      else if (c === 'ok') {
        const hid = announced.get(a);
        announced.delete(a); // zweites "ok" bestätigt nicht die nächste Übergabe
        const done = hid ? engine.resolveHandoff(a, true, hid) : false;
        say(done ? C.g : C.y, done ? `Task ${a} läuft weiter` : `Task ${a} wartet auf nichts`);
      }
      else if (c === 'stop') { if (a === 'all') engine.stopAll(); else engine.stop(a); }
      else if (c === 'at') {
        const [h, m, s] = a.split(':').map(Number);
        const when = new Date(); when.setHours(h, m, s || 0, 0);
        const site = b ? sites[b] : null;
        const offset = site && site.clockUrl ? await serverClockOffset(site.clockUrl).catch(() => 0) : 0;
        atTime(when, () => say(C.g, `T0: ${engine.trigger({ site: b })} Task(s) gefeuert`), { offsetMs: offset });
        say(C.c, `Trigger gestellt auf ${when.toTimeString().slice(0, 8)} (Server-Versatz ${Math.round(offset)} ms)`);
      } else if (c === 'status') {
        for (const t of engine.tasks.values()) {
          const p = t._ctx && t._ctx.state._proxy;
          const uses = p ? proxies.siteState(p, t.def.site).uses : 0;
          console.log(`${t.id}  ${t.def.site}/${t.def.mode}  ${t.status}  ${t.detail}  Exit:${label(p)}${p ? ` (${uses} Ladev.)` : ''}`);
        }
      } else if (c === 'exit') { engine.stopAll(); await engine.browsers.close(); store.close(); process.exit(0); }
    } catch (e) { say(C.r, e.message); }
    rl.prompt();
  });
}

main().catch((e) => { say(C.r, `Fehler: ${e.message}`); process.exit(1); });
