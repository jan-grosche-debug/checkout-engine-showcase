'use strict';

/**
 * Adapter für den lokalen Test-Shop (test/testshop-server.js).
 * VORLAGE für echte Seiten: die Seite beschreibt nur ihren Ablauf (flow) und
 * wählt die passenden Bausteine aus der Modus-Bibliothek.
 */
const { defineSite } = require('../core/modes');
const { pick } = require('../core/library');
const { fetchInPage, jsonOrThrow } = require('../browser/inpage');
const { detectBlock } = require('./common');

const base = (ctx) => ctx.def.baseUrl;
const ORDER_ID = /^ORD\d+$/; // Format der Bestellnummer dieser Seite

const flow = {
  home: (ctx) => `${base(ctx)}/`,

  /** Kaufweg per API im Seitenkontext (preload / request / watch). */
  api: {
    async run(ctx, page) {
      const pid = ctx.payload.pid || ctx.def.input;
      const post = (path, body) => fetchInPage(page, base(ctx) + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });

      const cartRes = await post('/api/cart', { pid });
      if (detectBlock(cartRes.body)) throw new Error('Block beim Warenkorb (HTTP 200 mit Block-Seite)');
      const cart = jsonOrThrow(cartRes, 'Warenkorb');
      if (!cart.cartId) throw new Error(`Warenkorb fehlgeschlagen: ${cart.error || cartRes.status}`);
      ctx.mark('cart');

      const p = ctx.profile || {};
      const ck = jsonOrThrow(await post('/api/checkout', { cartId: cart.cartId, name: p.name || '', zip: p.shipping?.zip || '' }), 'Kasse');
      if (!ck.checkoutId) throw new Error('Kasse fehlgeschlagen');
      ctx.mark('checkout');

      let purchase;
      await ctx.finalSubmit(async () => {
        purchase = jsonOrThrow(await post('/api/purchase', { checkoutId: ck.checkoutId }), 'Kauf');
      });
      if (!purchase) throw new Error('Kauf-Antwort fehlt');

      if (purchase.redirect) {
        // 3DS: Bot wartet selbst, der Nutzer gibt nur in der Bank-App frei
        await ctx.await3ds(async () => {
          const o = jsonOrThrow(await fetchInPage(page, `${base(ctx)}/api/order?checkoutId=${encodeURIComponent(ck.checkoutId)}`), 'Bestellstatus');
          return o.status === 'confirmed' && ORDER_ID.test(o.orderId || '') ? { orderId: o.orderId } : null;
        }, { from: 'api:/api/order status=confirmed (nach 3DS)' });
        return;
      }
      if (purchase.status === 'confirmed' && ORDER_ID.test(purchase.orderId || '')) {
        ctx.confirm({ orderId: purchase.orderId, source: 'site', from: 'api:/api/purchase status=confirmed' });
      }
    },
  },

  /** Kompletter Ablauf per Klick (safe). */
  browser: {
    async run(ctx, page) {
      const pid = ctx.payload.pid || ctx.def.input;
      await page.goto(`${base(ctx)}/product/${pid}`, { waitUntil: 'domcontentloaded' });
      ctx.countLoad();
      await page.click('#atc');
      await page.waitForURL(/\/checkout/);
      ctx.mark('cart');
      const p = ctx.profile || {};
      await page.fill('#name', p.name || '');
      await page.fill('#zip', p.shipping?.zip || '');
      ctx.mark('checkout');
      await ctx.finalSubmit(async () => {
        if (new URL(page.url()).pathname === '/checkout') await page.click('#buy');
      });
      const at = (re) => (u) => re.test(new URL(u).pathname);
      await page.waitForURL(at(/^\/(confirmation\/[^/]+|3ds)$/), { timeout: 60_000 });
      if (new URL(page.url()).pathname === '/3ds') {
        await ctx.await3ds(async () => {
          if (!/^\/confirmation\/[^/]+$/.test(new URL(page.url()).pathname)) return null;
          const id = (await page.textContent('#order'))?.trim();
          return id && ORDER_ID.test(id) ? { orderId: id } : null;
        }, { from: 'page:/confirmation (nach 3DS)' });
        return;
      }
      const orderId = (await page.textContent('#order'))?.trim();
      if (orderId && ORDER_ID.test(orderId)) {
        ctx.confirm({ orderId, source: 'site', from: `page:${new URL(page.url()).pathname}` });
      }
    },
  },

  /** Bestand für Watch – null = unklar (Block), nie Fehlalarm. */
  async stock(ctx, page) {
    const pid = ctx.def.input;
    const r = await fetchInPage(page, `${base(ctx)}/api/product/${encodeURIComponent(pid)}`);
    if (detectBlock(r.body) || r.status !== 200) return null;
    const j = JSON.parse(r.body);
    return j.available === true;
  },
};

module.exports = defineSite({
  key: 'testshop',
  name: 'Lokaler Test-Shop',
  defaultMode: 'preload',
  flow,
  modes: pick(flow, ['preload', 'watch', 'request', 'safe', 'testproxy']),
});
