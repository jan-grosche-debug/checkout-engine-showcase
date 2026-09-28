'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyPool, parseProxyLine, label, toPlaywright } = require('../src/net/proxies');
const { DiscordNotifier } = require('../src/notify/discord');
const { Task } = require('../src/core/task');

test('Proxy-Formate: ip:port, ip:port:user:pass, URL', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:8080'), { protocol: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(parseProxyLine('1.2.3.4:8080:u:p'), { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'p' });
  assert.equal(parseProxyLine('http://u:p%40x@h.de:3128').password, 'p@x');
  assert.equal(parseProxyLine('# Kommentar'), null);
  assert.equal(parseProxyLine('kaputt'), null);
});

test('label() zeigt nie Zugangsdaten', () => {
  const p = parseProxyLine('1.2.3.4:8080:geheimuser:geheimpass');
  assert.equal(label(p), '1.2.3.4:8080');
  assert.ok(!label(p).includes('geheim'));
  assert.deepEqual(toPlaywright(p), { server: 'http://1.2.3.4:8080', username: 'geheimuser', password: 'geheimpass' });
});

test('Exit verbrennt PRO SEITE nach burnAfter Ladevorgängen', () => {
  const pool = new ProxyPool();
  pool.addList('isp', ['1.1.1.1:1', '2.2.2.2:2']);
  const a = pool.lease('isp', 't1', 'pc');
  for (let i = 0; i < 7; i++) pool.countUse(a, 'pc', 7);
  assert.equal(pool.siteState(a, 'pc').burned, true);
  pool.release(a, 't1');
  const b = pool.lease('isp', 't2', 'pc');
  assert.notEqual(b.host, a.host, 'für PC nicht mehr vergeben');
  assert.throws(() => pool.lease('isp', 't3', 'pc'), /kein frischer Exit/);
  pool.release(b, 't2');
  // gleicher Exit ist für eine andere Seite weiter nutzbar
  assert.equal(pool.lease('isp', 't4', 'pagro').host, '1.1.1.1');
  assert.deepEqual(pool.stats('isp', 'pc'), { total: 2, fresh: 1, usable: 1, burned: 1 });
});

test('Seite ohne bekannte Grenze verbrennt nicht durch Zählen, nur durch Block', () => {
  const pool = new ProxyPool();
  pool.addList('isp', ['1.1.1.1:1']);
  const a = pool.lease('isp', 't', 'x');
  for (let i = 0; i < 50; i++) pool.countUse(a, 'x', null);
  assert.equal(pool.siteState(a, 'x').burned, false);
  pool.markBurned(a, 'x');
  assert.equal(pool.siteState(a, 'x').burned, true);
});

test('Nutzungsstand übersteht Neustart und enthält keine Zugangsdaten', () => {
  const pool = new ProxyPool();
  pool.addList('isp', ['1.1.1.1:1:user:geheim']);
  const a = pool.lease('isp', 't', 'pc');
  pool.countUse(a, 'pc', 7); pool.setLatency(a, 'pc', 420);
  const state = pool.exportState();
  assert.ok(!JSON.stringify(state).includes('geheim'));
  assert.ok(!JSON.stringify(state).includes('user'));
  const fresh = new ProxyPool();
  fresh.addList('isp', ['1.1.1.1:1:user:geheim']);
  fresh.importState(state);
  assert.deepEqual(fresh.siteState(fresh.lists.get('isp')[0], 'pc'), { uses: 1, burned: false, latencyMs: 420 });
});

test('lease bevorzugt ungenutzte und schnellere Exits', () => {
  const pool = new ProxyPool();
  pool.addList('res', ['1.1.1.1:1', '2.2.2.2:2', '3.3.3.3:3']);
  const [x, y, z] = pool.lists.get('res');
  pool.countUse(x, 's'); pool.countUse(x, 's');
  pool.setLatency(y, 's', 900); pool.setLatency(z, 's', 300);
  assert.equal(pool.lease('res', 't', 's').host, '3.3.3.3');
});

test('Discord: Erfolgsmeldung ohne echten Checkout wird verweigert', async () => {
  const sent = [];
  const n = new DiscordNotifier({ webhookUrl: 'https://discord.test/x', fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; } });
  const t = new Task({ site: 'testshop', mode: 'preload', input: 'p1' });
  t.setStatus('running');
  t.mark('cart'); // Warenkorb ist KEIN Checkout
  await assert.rejects(() => n.success(t), /verweigert/);
  assert.equal(sent.length, 0);
});

test('Discord: echte Meldung enthält Bestellnummer, aber keine Profildaten', async () => {
  const sent = [];
  const n = new DiscordNotifier({ webhookUrl: 'https://discord.test/x', fetchImpl: async (u, o) => { sent.push(o.body); return { ok: true }; } });
  const t = new Task({ site: 'testshop', mode: 'preload', input: 'p1', profileId: 'Max', cardNumber: '4111111111111111' });
  t.markTrigger();
  t.confirmSuccess({ orderId: 'ORD1001', source: 'site', from: 'api:/api/purchase' });
  assert.equal(await n.success(t), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ORD1001/);
  assert.ok(!sent[0].includes('4111'), 'keine Kartendaten im Embed');
});
