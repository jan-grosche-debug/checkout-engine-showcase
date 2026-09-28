'use strict';

/** Kleiner HTTP-Proxy mit Basic-Auth für Tests (leitet an den lokalen Test-Shop weiter). */
const http = require('node:http');

function startLocalProxy({ user = 'u', pass = 'p' } = {}) {
  const stats = { authed: 0, rejected: 0 };
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const server = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== expected) {
      stats.rejected++;
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    stats.authed++;
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const fwd = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    line: `127.0.0.1:${server.address().port}:${user}:${pass}`,
    stats,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

module.exports = { startLocalProxy };
