'use strict';

/**
 * Ende-zu-Ende mit echtem Chromium gegen den lokalen Test-Shop.
 * Läuft headless (nur Test-Shop, keine echte Seite). Wird übersprungen, wenn kein Chromium startet.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/core/engine');
const { STATUS } = require('../src/core/task');
const { BrowserPool } = require('../src/browser/pool');
const { startTestShop } = require('./testshop-server');
const sites = require('../src/sites');

let chromiumOk = true;
try { require('playwright'); } catch { chromiumOk = false; }

const profile = { name: 'Test', shipping: { zip: '48149' } };

async function setup(shopOpts = {}, settings = {}) {
  const shop = await startTestShop(shopOpts);
  const browsers = new BrowserPool({ headless: true, executablePath: process.env.BOT_CHROMIUM_PATH || undefined });
  const handoffs = [];
  const engine = new Engine({ sites, browsers, profiles: () => profile, settings: { finalSubmit: 'auto', maxConcurrentWarm: 4, ...settings } });
  engine.on('handoff', (t, h) => handoffs.push(h.type));
  return { shop, browsers, engine, handoffs, close: async () => { await browsers.close(); await shop.close(); } };
}

test('E2E Preload: warm vor Drop, Trigger → echter Beleg + Latenz gemessen', { skip: !chromiumOk }, async () => {
  const s = await setup();
  try {
    const t = s.engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: s.shop.url, profileId: 'x' });
    const run = s.engine.run(t);
    while (t.status !== STATUS.READY && !t.done) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.status, STATUS.READY, t.detail);
    s.shop.drop();
    assert.equal(s.engine.trigger({ site: 'testshop' }), 1);
    await run;
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
    assert.match(t.result.orderId, /^ORD\d+$/);
    assert.ok(s.shop.state.orders.includes(t.result.orderId), 'Bestellung existiert wirklich im Shop');
    const ms = t.sinceTrigger('confirmed');
    console.log(`    Preload T0→Bestätigung: ${Math.round(ms)} ms`);
    assert.ok(ms < 1000, `zu langsam: ${ms} ms`);
  } finally { await s.close(); }
});

test('E2E Safe (Klicks im Browser) → Beleg von der Bestätigungsseite', { skip: !chromiumOk }, async () => {
  const s = await setup();
  try {
    s.shop.drop();
    const t = s.engine.add({ site: 'testshop', mode: 'safe', input: 'p1', baseUrl: s.shop.url, profileId: 'x' });
    await s.engine.fire(t);
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
    assert.match(t.result.from, /^page:\/confirmation\//);
    console.log(`    Safe T0→Bestätigung: ${Math.round(t.sinceTrigger('confirmed'))} ms`);
  } finally { await s.close(); }
});

test('E2E Block-Seite mit HTTP 200 → FAILED, kein Erfolg, keine Bestellung', { skip: !chromiumOk }, async () => {
  const s = await setup({ blockApi: true });
  try {
    s.shop.drop();
    const t = s.engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: s.shop.url });
    await s.engine.warm(t);
    await s.engine.fire(t);
    assert.equal(t.status, STATUS.FAILED);
    assert.match(t.failure, /Block/);
    assert.equal(s.shop.state.orders.length, 0);
  } finally { await s.close(); }
});

test('E2E 3DS ohne Freigabe → Bot wartet selbst, dann FAILED (kein Fake-Erfolg)', { skip: !chromiumOk }, async () => {
  const s = await setup({ require3ds: true }, { threeDsTimeoutMs: 400, threeDsPollMs: 50 });
  try {
    s.shop.drop();
    const t = s.engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: s.shop.url });
    await s.engine.warm(t);
    await s.engine.fire(t);
    assert.deepEqual(s.handoffs, [], 'kein manuelles OK nötig');
    assert.equal(t.status, STATUS.FAILED);
    assert.match(t.failure, /3DS nicht rechtzeitig/);
    assert.equal(s.shop.state.orders.length, 0);
  } finally { await s.close(); }
});

test('E2E Ausverkauft beim Trigger → FAILED mit Grund', { skip: !chromiumOk }, async () => {
  const s = await setup();
  try {
    const t = s.engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: s.shop.url });
    await s.engine.warm(t);
    await s.engine.fire(t); // kein drop()
    assert.equal(t.status, STATUS.FAILED);
    assert.match(t.failure, /out_of_stock|Warenkorb/);
  } finally { await s.close(); }
});

test('E2E TestProxy → DONE mit Ladezeit, zählt als Ladevorgang', { skip: !chromiumOk }, async () => {
  const s = await setup();
  try {
    const t = s.engine.add({ site: 'testshop', mode: 'testproxy', baseUrl: s.shop.url });
    await s.engine.fire(t);
    assert.equal(t.status, STATUS.DONE);
    assert.match(t.detail, /^ok, \d+ ms$/);
    assert.equal(s.shop.state.pageLoads, 1);
  } finally { await s.close(); }
});

test('E2E 3DS in Bank-App freigegeben → Bot fragt selbst nach → echter Erfolg', { skip: !chromiumOk }, async () => {
  const s = await setup({ require3ds: true, threeDsApproves: true }, { threeDsPollMs: 50 });
  try {
    s.shop.drop();
    const t = s.engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: s.shop.url });
    await s.engine.warm(t);
    await s.engine.fire(t);
    assert.deepEqual(s.handoffs, [], 'kein manuelles OK nötig');
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
    assert.match(t.result.from, /nach 3DS/);
    assert.ok(s.shop.state.orders.includes(t.result.orderId));
  } finally { await s.close(); }
});

test('E2E Watch: Task wartet selbst auf Bestand und kauft beim Drop automatisch', { skip: !chromiumOk }, async () => {
  const s = await setup();
  try {
    const t = s.engine.add({ site: 'testshop', mode: 'watch', input: 'p1', baseUrl: s.shop.url, monitorDelayMs: 100 });
    const run = s.engine.run(t);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(t.status, STATUS.READY, 'vor dem Drop kein Kauf');
    s.shop.drop();
    await run;
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
    assert.ok(s.shop.state.orders.includes(t.result.orderId));
  } finally { await s.close(); }
});

test('E2E Standard ist Voll-Automatik: kein OK nötig', { skip: !chromiumOk }, async () => {
  const shop = await startTestShop();
  const browsers = new BrowserPool({ headless: true });
  const engine = new Engine({ sites, browsers, profiles: () => profile }); // keine settings → Standard
  try {
    assert.equal(engine.settings.finalSubmit, 'auto');
    shop.drop();
    const t = engine.add({ site: 'testshop', mode: 'request', input: 'p1', baseUrl: shop.url });
    await engine.fire(t);
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
  } finally { await browsers.close(); await shop.close(); }
});

test('E2E TestProxy: 404/5xx = unklar (nicht verbrannt), 403 = Block (verbrannt)', { skip: !chromiumOk }, async () => {
  const { ProxyPool } = require('../src/net/proxies');
  const { startLocalProxy } = require('./local-proxy');
  const proxy = await startLocalProxy();
  const shop = await startTestShop();
  const browsers = new BrowserPool({ headless: true, args: ['--proxy-bypass-list=<-loopback>'] });
  const proxies = new ProxyPool();
  proxies.addList('isp', [proxy.line]);
  const engine = new Engine({ sites, browsers, proxies });
  try {
    const t1 = engine.add({ site: 'testshop', mode: 'testproxy', baseUrl: shop.url + '/gibtsnicht', proxyList: 'isp' });
    await engine.fire(t1);
    assert.equal(t1.status, STATUS.DONE);
    assert.match(t1.detail, /unklar \(http-404\).*nicht verbrannt/);
    const exit = proxies.lists.get('isp')[0];
    assert.equal(proxies.siteState(exit, 'testshop').burned, false);
    const t2 = engine.add({ site: 'testshop', mode: 'testproxy', baseUrl: shop.url + '/forbidden', proxyList: 'isp' });
    await engine.fire(t2);
    assert.match(t2.detail, /blockiert \(http-403\)/);
    assert.equal(proxies.siteState(exit, 'testshop').burned, true);
  } finally { await browsers.close(); await shop.close(); await proxy.close(); }
});

test('E2E über Proxy mit Zugangsdaten: kompletter Kauf läuft durch den Exit, Ladevorgänge gezählt', { skip: !chromiumOk }, async () => {
  const { startLocalProxy } = require('./local-proxy');
  const { ProxyPool } = require('../src/net/proxies');
  const proxy = await startLocalProxy({ user: 'jan', pass: 'geheim' });
  const shop = await startTestShop();
  // Chromium umgeht Proxys für localhost standardmäßig → für den Test abschalten
  const browsers = new BrowserPool({ headless: true, args: ['--proxy-bypass-list=<-loopback>'] });
  const proxies = new ProxyPool();
  proxies.addList('isp', [proxy.line]);
  const logs = [];
  const engine = new Engine({ sites, browsers, proxies, profiles: () => profile });
  engine.on('status', (t, s) => logs.push(`${s.status} ${s.detail}`));
  try {
    shop.drop();
    const t = engine.add({ site: 'testshop', mode: 'preload', input: 'p1', baseUrl: shop.url, proxyList: 'isp' });
    await engine.warm(t);
    await engine.fire(t);
    assert.equal(t.status, STATUS.SUCCESS, t.detail);
    assert.ok(proxy.stats.authed >= 4, `nur ${proxy.stats.authed} Anfragen über den Proxy`);
    const exit = proxies.lists.get('isp')[0];
    assert.equal(proxies.siteState(exit, 'testshop').uses, 1, 'Anwärm-Ladevorgang gezählt');
    assert.equal(exit.leasedBy, null, 'Exit nach Task wieder frei');
    assert.ok(!logs.join(' ').includes('geheim'), 'Passwort nie im Status/Log');
  } finally { await browsers.close(); await shop.close(); await proxy.close(); }
});
