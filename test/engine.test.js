'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/core/engine');
const { Task, STATUS } = require('../src/core/task');
const { defineSite } = require('../src/core/modes');

function fakeSite(overrides = {}) {
  return defineSite({
    key: 'fake',
    defaultMode: 'buy',
    modes: {
      buy: { transport: 'request', why: 'Test', async fire(ctx) { ctx.mark('cart'); await ctx.finalSubmit(() => {}); ctx.confirm({ orderId: 'ORD-1', source: 'site', from: 'test' }); } },
      nobeleg: { transport: 'request', why: 'Test: endet ohne Beleg', async fire(ctx) { ctx.mark('cart'); } },
      probe: { transport: 'none', checkout: false, why: 'Test', async fire() { return 'ok, 12 ms'; } },
      preload: {
        transport: 'request', preload: true, why: 'Test',
        async warm(ctx) { ctx.state.token = 'warm'; },
        async fire(ctx) { if (ctx.state.token !== 'warm') throw new Error('nicht warm'); ctx.confirm({ orderId: `ORD-${ctx.task.id}`, source: 'site', from: 'test' }); },
      },
      ...overrides,
    },
  });
}

const engineWith = (settings = {}, notifier = null) =>
  new Engine({ sites: { fake: fakeSite() }, notifier, settings: { finalSubmit: 'auto', ...settings } });

test('Task: SUCCESS nur mit gültigem Beleg', () => {
  const t = new Task({ site: 'fake', mode: 'buy' });
  assert.throws(() => t.setStatus(STATUS.SUCCESS), /confirmSuccess/);
  assert.throws(() => t.confirmSuccess({ orderId: 'ORD-1' }), /Bestellbeleg/);
  assert.throws(() => t.confirmSuccess({ orderId: 'ORD-1', source: 'redirect', from: 'x' }), /Bestellbeleg/);
  assert.throws(() => t.confirmSuccess({ orderId: '', source: 'site', from: 'x' }), /Bestellbeleg/);
  assert.equal(t.status, STATUS.IDLE);
  assert.equal(t.confirmSuccess({ orderId: 'ORD-1', source: 'site', from: 'page:/confirmation' }), true);
  assert.equal(t.status, STATUS.SUCCESS);
  assert.equal(t.fail('zu spät'), false, 'Endzustand bleibt');
  assert.equal(t.status, STATUS.SUCCESS);
});

test('Kauf-Modus ohne Beleg endet als FAILED, nie als Erfolg', async () => {
  const notified = [];
  const e = engineWith({}, { success: async (t) => notified.push(t), handoff: async () => {} });
  const t = e.add({ site: 'fake', mode: 'nobeleg' });
  await e.fire(t);
  assert.equal(t.status, STATUS.FAILED);
  assert.match(t.detail, /ohne Bestellbestätigung/);
  assert.equal(notified.length, 0);
});

test('Kauf-Modus mit Beleg → SUCCESS + Meldung', async () => {
  const notified = [];
  const e = engineWith({}, { success: async (t) => notified.push(t.id), handoff: async () => {} });
  const t = e.add({ site: 'fake', mode: 'buy' });
  await e.fire(t);
  assert.equal(t.status, STATUS.SUCCESS);
  assert.equal(t.result.orderId, 'ORD-1');
  assert.deepEqual(notified, [t.id]);
});

test('Nicht-Kauf-Modus (Proxy-Test) endet als DONE, nie als SUCCESS', async () => {
  const e = engineWith();
  const t = e.add({ site: 'fake', mode: 'probe' });
  await e.fire(t);
  assert.equal(t.status, STATUS.DONE);
  assert.equal(t.result, null);
  assert.equal(t.detail, 'ok, 12 ms');
});

test('Fehler im Adapter → FAILED mit Grund', async () => {
  const e = new Engine({ sites: { fake: fakeSite({ boom: { transport: 'request', why: 'Test', async fire() { throw new Error('Block beim Warenkorb'); } } }) } });
  const t = e.add({ site: 'fake', mode: 'boom' });
  await e.fire(t);
  assert.equal(t.status, STATUS.FAILED);
  assert.equal(t.failure, 'Block beim Warenkorb');
});

test('Unbekannter Modus/Seite wird beim Anlegen abgelehnt', () => {
  const e = engineWith();
  assert.throws(() => e.add({ site: 'fake', mode: 'gibtsnicht' }), /keinen Modus/);
  assert.throws(() => e.add({ site: 'nope', mode: 'buy' }), /Unbekannte Seite/);
});

test('Preload: warm() läuft VOR dem Trigger, Trigger feuert nur passende Tasks', async () => {
  const e = engineWith();
  const a = e.add({ site: 'fake', mode: 'preload', input: 'p1' });
  const b = e.add({ site: 'fake', mode: 'preload', input: 'p2' });
  const ra = e.run(a);
  const rb = e.run(b);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.status, STATUS.READY);
  assert.equal(b.status, STATUS.READY);
  assert.equal(e.trigger({ site: 'fake', input: 'p1' }), 1);
  await ra;
  assert.equal(a.status, STATUS.SUCCESS);
  assert.equal(b.status, STATUS.READY, 'p2 darf nicht mitfeuern');
  const warmDone = a.phases.find((p) => p.name === 'warm-done').t;
  assert.ok(warmDone <= a.t0, 'warm fertig vor T0');
  e.stop(b.id);
  await rb;
  assert.equal(b.status, STATUS.STOPPED);
});

test('Latenz: 100 warme Tasks starten nach Trigger ohne Verzögerung', async () => {
  const e = engineWith({ maxConcurrentWarm: 100 });
  const tasks = Array.from({ length: 100 }, () => e.add({ site: 'fake', mode: 'preload' }));
  const runs = tasks.map((t) => e.run(t));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(tasks.every((t) => t.status === STATUS.READY));
  const n = e.trigger({ site: 'fake' });
  assert.equal(n, 100);
  await Promise.all(runs);
  assert.ok(tasks.every((t) => t.status === STATUS.SUCCESS));
  // Zeit von T0 bis Bestätigung je Task (reiner Engine-Overhead, kein Netz)
  const worst = Math.max(...tasks.map((t) => t.sinceTrigger('confirmed')));
  assert.ok(worst < 50, `Engine-Overhead zu hoch: ${worst} ms`);
});

test('finalSubmit=human: wartet auf OK, erst dann Kauf', async () => {
  let clicked = false;
  const site = fakeSite({
    humanbuy: { transport: 'request', why: 'Test', async fire(ctx) { await ctx.finalSubmit(() => { clicked = true; }); ctx.confirm({ orderId: 'ORD-9', source: 'site', from: 'test' }); } },
  });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'human' } });
  const t = e.add({ site: 'fake', mode: 'humanbuy' });
  const run = e.fire(t);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.status, STATUS.HANDOFF);
  assert.equal(clicked, false, 'ohne OK kein Klick');
  assert.equal(e.resolveHandoff(t.id), true);
  await run;
  assert.equal(clicked, true);
  assert.equal(t.status, STATUS.SUCCESS);
});

test('Übergabe mit Zeitablauf → FAILED, kein Kauf', async () => {
  let clicked = false;
  const site = fakeSite({
    humanbuy: { transport: 'request', why: 'Test', async fire(ctx) { await ctx.finalSubmit(() => { clicked = true; }); } },
  });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'human', handoffTimeoutMs: 30 } });
  const t = e.add({ site: 'fake', mode: 'humanbuy' });
  await e.fire(t);
  assert.equal(t.status, STATUS.FAILED);
  assert.match(t.failure, /nicht erledigt/);
  assert.equal(clicked, false);
});

test('Warm-Slots begrenzen parallele Browser-Anläufe', async () => {
  let active = 0;
  let peak = 0;
  const site = fakeSite({
    slow: {
      transport: 'browser', preload: true, why: 'Test',
      async warm() { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; },
      async fire(ctx) { ctx.confirm({ orderId: 'ORD-2', source: 'site', from: 't' }); },
    },
  });
  const e = new Engine({ sites: { fake: site }, settings: { maxConcurrentWarm: 2 } });
  const ts = Array.from({ length: 6 }, () => e.add({ site: 'fake', mode: 'slow' }));
  await Promise.all(ts.map((t) => e.warm(t)));
  assert.equal(peak, 2);
  assert.ok(ts.every((t) => t.status === STATUS.READY));
});

// ---- Regressionstests aus dem adversarialen Review (25.09.2026)

test('Review: zweite gleichzeitige Übergabe wird abgelehnt (kein Überschreiben)', async () => {
  let clicked = 0;
  let second = null;
  const site = fakeSite({
    double: {
      transport: 'request', why: 'Test',
      async fire(ctx) {
        const first = ctx.handoff({ type: 'challenge', message: 'x' });
        second = ctx.finalSubmit(() => { clicked++; }).catch((e) => e);
        await first;
      },
    },
  });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'human', handoffTimeoutMs: 200 } });
  const t = e.add({ site: 'fake', mode: 'double' });
  const run = e.fire(t);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.pendingHandoff(t.id).type, 'challenge');
  e.resolveHandoff(t.id); // OK gilt der Challenge, nicht dem Kauf
  await run;
  const err = await second;
  assert.match(String(err && err.message), /schon eine Übergabe offen/);
  assert.equal(clicked, 0);
});

test('Review: OK mit falscher Übergabe-ID wird ignoriert', async () => {
  let clicked = 0;
  const site = fakeSite({ hb: { transport: 'request', why: 'T', async fire(ctx) { await ctx.finalSubmit(() => { clicked++; }); } } });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'human', handoffTimeoutMs: 100 } });
  const t = e.add({ site: 'fake', mode: 'hb' });
  const run = e.fire(t);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.resolveHandoff(t.id, true, 'alte-id'), false);
  await run;
  assert.equal(clicked, 0);
  assert.equal(t.status, STATUS.FAILED);
});

test('Review: Stop vor finalSubmit (auto) → kein Klick', async () => {
  let clicked = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const site = fakeSite({ slowbuy: { transport: 'request', why: 'T', async fire(ctx) { await gate; await ctx.finalSubmit(() => { clicked++; }); } } });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'auto' } });
  const t = e.add({ site: 'fake', mode: 'slowbuy' });
  const run = e.fire(t);
  e.stop(t.id);
  release();
  await run;
  assert.equal(clicked, 0);
  assert.equal(t.status, STATUS.STOPPED);
});

test('Review: Stop während Kauf-Übergabe (human) → kein Klick', async () => {
  let clicked = 0;
  const site = fakeSite({ hb: { transport: 'request', why: 'T', async fire(ctx) { await ctx.finalSubmit(() => { clicked++; }); } } });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'human' } });
  const t = e.add({ site: 'fake', mode: 'hb' });
  const run = e.fire(t);
  await new Promise((r) => setTimeout(r, 10));
  e.stop(t.id);
  assert.equal(e.resolveHandoff(t.id), false, 'nach Stop gibt es nichts mehr zu bestätigen');
  await run;
  assert.equal(clicked, 0);
});

test('Review: Stop während warm → Browser-Kontext zu, Proxy frei', async () => {
  const { ProxyPool } = require('../src/net/proxies');
  const proxies = new ProxyPool();
  proxies.addList('res', ['1.1.1.1:1']);
  let open = 0;
  const browsers = { newPage: async () => { open++; await new Promise((r) => setTimeout(r, 20)); return { page: { bringToFront: async () => {} }, close: async () => { open--; } }; } };
  const site = fakeSite({ w: { transport: 'browser', preload: true, why: 'T', async warm(ctx) { await ctx.page(); }, async fire() {} } });
  const e = new Engine({ sites: { fake: site }, browsers, proxies });
  const t = e.add({ site: 'fake', mode: 'w', proxyList: 'res' });
  const w = e.warm(t);
  await new Promise((r) => setTimeout(r, 5));
  e.stop(t.id);
  await w;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(open, 0, 'kein offener Browser-Kontext');
  assert.equal(proxies.lists.get('res')[0].leasedBy, null, 'Proxy wieder frei');
});

test('Review: Trigger während Anwärmen geht nicht verloren', async () => {
  const site = fakeSite({
    slowwarm: {
      transport: 'request', preload: true, why: 'T',
      async warm() { await new Promise((r) => setTimeout(r, 30)); },
      async fire(ctx) { ctx.confirm({ orderId: 'ORD-7', source: 'site', from: 't' }); },
    },
  });
  const e = new Engine({ sites: { fake: site }, settings: { finalSubmit: 'auto' } });
  const t = e.add({ site: 'fake', mode: 'slowwarm' });
  const run = e.run(t);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.status, STATUS.WARMING);
  assert.equal(e.trigger({ site: 'fake' }), 1);
  await run;
  assert.equal(t.status, STATUS.SUCCESS);
});

test('Review: Status/Ergebnis lassen sich von außen nicht setzen', () => {
  const t = new Task({ site: 'fake', mode: 'buy' });
  assert.throws(() => { t.status = 'success'; }, TypeError);
  assert.throws(() => { t.result = { orderId: 'X' }; }, TypeError);
  t.confirmSuccess({ orderId: 'ORD-1', source: 'site', from: 't' });
  assert.throws(() => { t.result.orderId = 'Y'; }, TypeError);
});

test('Review: sleep() hinterlässt keine Abort-Listener', async () => {
  const site = fakeSite({ nap: { transport: 'none', checkout: false, why: 'T', async fire(ctx) { for (let i = 0; i < 20; i++) await ctx.sleep(1); return 'ok'; } } });
  const e = new Engine({ sites: { fake: site } });
  const t = e.add({ site: 'fake', mode: 'nap' });
  const { getEventListeners } = require('node:events');
  await e.fire(t);
  assert.equal(getEventListeners(t.abort.signal, 'abort').length, 0);
});

test('Bibliothek: Seite bekommt nur Bausteine, die ihr Ablauf tragen kann', () => {
  const { pick } = require('../src/core/library');
  const onlyApi = { home: () => 'https://x', api: { run: async () => {} } };
  assert.deepEqual(Object.keys(pick(onlyApi, ['preload', 'request', 'testproxy'])), ['preload', 'request', 'testproxy']);
  assert.throws(() => pick(onlyApi, ['safe']), /browser\.run/);
  assert.throws(() => pick(onlyApi, ['watch']), /flow\.stock/);
  assert.throws(() => pick(onlyApi, ['raffle']), /Unbekannter Baustein/);
});

test('Seiten haben eigene Modus-Sätze', () => {
  const sites = require('../src/sites');
  for (const s of Object.values(sites)) {
    assert.ok(Object.keys(s.modes).length >= 1, `${s.key} hat keine Modi`);
    assert.ok(s.modes.testproxy, `${s.key} ohne TestProxy`);
    for (const m of Object.values(s.modes)) assert.ok(m.why.length > 20, `${s.key}/${m.key} ohne Begründung`);
  }
});

test('Review 2: 3DS-Prüfung, die hängt, überschreitet die Frist nicht', async () => {
  const site = fakeSite({
    hang: { transport: 'request', why: 'Test: 3DS-Abfrage hängt', async fire(ctx) { await ctx.await3ds(() => new Promise(() => {})); } },
  });
  const e = new Engine({ sites: { fake: site }, settings: { threeDsTimeoutMs: 150, threeDsPollMs: 20 } });
  const t = e.add({ site: 'fake', mode: 'hang' });
  const t0 = Date.now();
  await e.fire(t);
  assert.ok(Date.now() - t0 < 600, `zu lange: ${Date.now() - t0} ms`);
  assert.equal(t.status, STATUS.FAILED);
  assert.match(t.failure, /Bestellstatus unklar/);
});

test('Review 2: Watch – 3× unklar → Exit verbrannt, Task FAILED, Warten beendet', async () => {
  const { ProxyPool } = require('../src/net/proxies');
  const { pick } = require('../src/core/library');
  const proxies = new ProxyPool();
  proxies.addList('isp', ['1.1.1.1:1']);
  const browsers = { newPage: async () => ({ page: { goto: async () => ({ status: () => 200 }), content: async () => 'ok', bringToFront: async () => {} }, close: async () => {} }) };
  const flow = { home: () => 'https://x.test/', api: { run: async () => {} }, stock: async () => null };
  const site = defineSite({ key: 'w', modes: pick(flow, ['watch']) });
  const e = new Engine({ sites: { w: site }, browsers, proxies });
  const t = e.add({ site: 'w', mode: 'watch', proxyList: 'isp', monitorDelayMs: 10 });
  await e.run(t);
  assert.equal(t.status, STATUS.FAILED);
  assert.match(t.failure, /3× blockiert/);
  const exit = proxies.lists.get('isp')[0];
  assert.equal(proxies.siteState(exit, 'w').burned, true);
  assert.equal(proxies.siteState(exit, 'w').uses, 4, '1 Anwärmen + 3 Abfragen gezählt');
  assert.equal(exit.leasedBy, null);
});

test('Review 2: gleicher host:port mit verschiedenen Benutzern = getrennte Exits im gespeicherten Stand', () => {
  const { ProxyPool } = require('../src/net/proxies');
  const lines = ['gw.resi.test:8000:user-sess1:pw', 'gw.resi.test:8000:user-sess2:pw'];
  const pool = new ProxyPool();
  pool.addList('resi', lines);
  pool.markBurned(pool.lists.get('resi')[0], 'pc');
  const state = pool.exportState();
  assert.ok(!JSON.stringify(state).includes('user-sess'), 'kein Benutzername im Klartext');
  const again = new ProxyPool();
  again.addList('resi', lines);
  again.importState(state);
  assert.deepEqual(again.stats('resi', 'pc'), { total: 2, fresh: 1, usable: 1, burned: 1 });
});
