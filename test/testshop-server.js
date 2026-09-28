'use strict';

/**
 * Lokaler Test-Shop – bildet die typischen Stolperfallen echter Shops nach:
 *  - Anti-Bot-Cookie muss erst per Seitenaufruf "verdient" werden (wie Imperva/DataDome)
 *  - Block-Seite mit HTTP 200 (wie Imperva) statt Fehlercode
 *  - Produkt erst ab "Drop" verfügbar
 *  - optional 3DS-Weiterleitung statt Bestellung
 * Keine echte Seite wird angesprochen.
 */
const http = require('node:http');

function startTestShop({ blockApi = false, require3ds = false, threeDsApproves = false } = {}) {
  const state = { available: false, orders: [], pending: new Map(), carts: new Map(), checkouts: new Map(), n: 0, pageLoads: 0 };

  const page = (title, body) =>
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const hasClearance = (req) => /(?:^|;\s*)clearance=ok/.test(req.headers.cookie || '');
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const html = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
  const blockPage = (res) => html(res, 200, page('Request unsuccessful', '<p>Request unsuccessful. Incapsula incident ID: 123</p>'));

  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') {
      state.pageLoads++;
      return html(res, 200, page('Testshop', '<a href="/product/p1">Produkt</a>'), { 'set-cookie': 'clearance=ok; Path=/' });
    }
    if (req.method === 'GET' && p.startsWith('/product/')) {
      state.pageLoads++;
      if (!hasClearance(req)) return blockPage(res);
      return html(res, 200, page('Produkt', `
        <h1 id="title">Test-Booster</h1>
        <button id="atc" ${state.available ? '' : 'disabled'}>In den Warenkorb</button>
        <script>
          document.getElementById('atc').onclick = async () => {
            const r = await fetch('/api/cart', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({pid:'p1'})});
            const j = await r.json(); location.href = '/checkout?cart=' + j.cartId;
          };
        </script>`));
    }
    if (req.method === 'GET' && p === '/checkout') {
      return html(res, 200, page('Kasse', `
        <form id="f"><input id="name" name="name"><input id="zip" name="zip">
        <button id="buy" type="submit">Jetzt kaufen</button></form>
        <script>
          document.getElementById('f').onsubmit = async (e) => {
            e.preventDefault();
            const cartId = new URL(location.href).searchParams.get('cart');
            const c = await (await fetch('/api/checkout', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({cartId, name: name.value, zip: zip.value})})).json();
            const r = await fetch('/api/purchase', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({checkoutId: c.checkoutId})});
            const j = await r.json();
            location.href = j.orderId ? '/confirmation/' + j.orderId : '/3ds';
          };
        </script>`));
    }
    if (req.method === 'GET' && p.startsWith('/forbidden')) return html(res, 403, page('403', 'Zugriff verweigert'));
    if (req.method === 'GET' && p.startsWith('/confirmation/')) {
      const id = p.split('/')[2];
      if (!state.orders.includes(id)) return html(res, 404, page('?', 'unbekannt'));
      return html(res, 200, page('Danke', `<h1>Danke!</h1><p>Bestellnummer: <span id="order">${id}</span></p>`));
    }
    if (req.method === 'GET' && p === '/3ds') {
      return html(res, 200, page('3-D Secure', '<p id="3ds">Bitte in der Bank-App bestätigen</p>'));
    }

    // ---- API
    if (p.startsWith('/api/')) {
      if (blockApi || !hasClearance(req)) return blockPage(res);
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.method === 'GET' && p === '/api/order') {
        const id = state.pending.get(url.searchParams.get('checkoutId'));
        if (!id) return json(res, 200, { status: 'pending' });
        if (!state.orders.includes(id)) state.orders.push(id);
        return json(res, 200, { status: 'confirmed', orderId: id });
      }
      if (req.method === 'GET' && p === '/api/product/p1') return json(res, 200, { pid: 'p1', available: state.available });
      if (req.method === 'POST' && p === '/api/cart') {
        if (!state.available) return json(res, 409, { error: 'out_of_stock' });
        const cartId = `c${++state.n}`;
        state.carts.set(cartId, body.pid);
        return json(res, 200, { cartId });
      }
      if (req.method === 'POST' && p === '/api/checkout') {
        if (!state.carts.has(body.cartId)) return json(res, 400, { error: 'cart' });
        const checkoutId = `k${++state.n}`;
        state.checkouts.set(checkoutId, body.cartId);
        return json(res, 200, { checkoutId });
      }
      if (req.method === 'POST' && p === '/api/purchase') {
        if (!state.checkouts.has(body.checkoutId)) return json(res, 400, { error: 'checkout' });
        if (require3ds) {
          if (threeDsApproves) state.pending.set(body.checkoutId, `ORD${1000 + (++state.n)}`);
          return json(res, 200, { redirect: '/3ds' });
        }
        const orderId = `ORD${1000 + (++state.n)}`;
        state.orders.push(orderId);
        return json(res, 200, { orderId, status: 'confirmed' });
      }
    }
    html(res, 404, page('404', 'nicht gefunden'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        drop: () => { state.available = true; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startTestShop };
