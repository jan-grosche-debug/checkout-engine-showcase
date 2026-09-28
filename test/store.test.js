'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/data/store');
const { Task } = require('../src/core/task');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));

test('JSON task import: known sites imported, unknown skipped', () => {
  const file = path.join(tmp, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify([
    { site: 'testshop', mode: 'preload', input: '/product/1' },
    { site: 'unknown-shop', mode: 'request' },
    { site: 'testshop', mode: 'request', input: '/product/2' },
  ]));
  const s = new Store(':memory:');
  const r = s.importTasks(file, ['testshop']);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /unknown-shop/);
  const t = s.tasks();
  assert.equal(t[0].mode, 'preload');
  assert.equal(t[1].input, '/product/2');
  s.close();
});

test('JSON profile import: name list never contains card data', () => {
  const file = path.join(tmp, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify([{ uuid: 'p1', name: 'Test', shipping: { zip: '12345' }, card: { number: '4111111111111111' } }]));
  const s = new Store(':memory:');
  assert.equal(s.importProfiles(file), 1);
  const names = s.profileNames();
  assert.equal(names.length, 1);
  assert.equal(names[0].name, 'Test');
  assert.ok(!JSON.stringify(names).includes('4111'));
  assert.equal(s.profile('Test').shipping.zip, '12345');
  s.close();
});

test('checkouts() listet nur echte Erfolge mit Bestellnummer', () => {
  const s = new Store(':memory:');
  const ok = new Task({ site: 'testshop', mode: 'preload' });
  ok.confirmSuccess({ orderId: 'ORD1', source: 'site', from: 't' });
  const bad = new Task({ site: 'testshop', mode: 'preload' });
  bad.fail('Block');
  const probe = new Task({ site: 'testshop', mode: 'testproxy' });
  probe.complete('ok');
  [ok, bad, probe].forEach((t) => s.saveResult(t));
  const c = s.checkouts();
  assert.equal(c.length, 1);
  assert.equal(c[0].order_id, 'ORD1');
  s.close();
});
