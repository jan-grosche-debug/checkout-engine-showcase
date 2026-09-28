'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, redactBody, cleanUrl } = require('../tools/redact');

const SECRETS = ['Max', 'Mustermann', 'Musterstr', '12345', 'Musterstadt', 'max@ex.com', '4111111111111111', '0151', '123', '12/30', '1999-01-01'];
const leaks = (obj) => SECRETS.filter((s) => JSON.stringify(obj).includes(s));

test('Recorder-Schwärzung: Felder außerhalb der Allowlist werden nie im Klartext gespeichert', () => {
  const body = {
    line1: 'Musterstr 1', line2: 'x', town: 'Musterstadt', locality: 'Musterstadt', mobile: '0151 123', dob: '1999-01-01',
    first: 'Max', last: 'Mustermann', pan: 4111111111111111, number: '4111111111111111', securityCode: '123', expiry: '12/30',
    street: ['Musterstr 1'], names: ['Max Mustermann'], nested: { deep: { email: 'max@ex.com', postcode: '12345' } },
  };
  assert.deepEqual(leaks(redact(body)), []);
});

test('Recorder-Schwärzung: Formulare, JSON ohne Content-Type, Location-Query', () => {
  assert.deepEqual(leaks(redactBody('firstName=Max&street=Musterstr+1&zip=12345&cc=4111111111111111', '')), []);
  assert.deepEqual(leaks(redactBody('{"first":"Max","zip":"12345"}', 'text/plain')), []);
  assert.deepEqual(leaks(cleanUrl('https://shop.de/checkout?email=max@ex.com&token=abc')), []);
  assert.deepEqual(cleanUrl('https://shop.de/checkout?email=max@ex.com').query, ['email']);
});

test('Recorder-Schwärzung: Ablauf-Informationen bleiben erhalten', () => {
  const r = redact({ _links: { self: { href: 'https://api.shop.de/carts/default?token=geheim' } }, quantity: 2, price: 1299, status: 'CONFIRMED', type: 'cart' });
  assert.equal(r._links.self.href, 'https://api.shop.de/carts/default');
  assert.equal(r.quantity, 2);
  assert.equal(r.price, 1299);
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(redact({ id: 'max@ex.com' }).id, '<text:10>', 'E-Mail auch in sicheren Feldern entfernt');
});
