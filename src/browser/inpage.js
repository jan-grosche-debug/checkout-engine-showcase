'use strict';

/**
 * Request-Modus ohne eigenen TLS-Client:
 * fetch() läuft IM Seitenkontext des warmen Browsers. Dadurch
 *  - gleicher TLS-/HTTP2-Fingerprint wie der echte Browser,
 *  - gleiche Cookies (auch Anti-Bot-Cookies), gleicher Exit,
 *  - aber kein Rendern, kein Klicken, keine Animationen → deutlich schneller als DOM-Automatisierung.
 * Kosten: ein CDP-Roundtrip pro Aufruf (typisch 1–3 ms lokal).
 */
async function fetchInPage(page, url, init = {}) {
  return page.evaluate(
    async ({ url, init }) => {
      const r = await fetch(url, { credentials: 'include', ...init });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const body = await r.text();
      return { status: r.status, url: r.url, headers, body };
    },
    { url, init },
  );
}

/** Body als JSON lesen – wirft mit klarer Meldung, wenn eine Block-/HTML-Seite zurückkommt. */
function jsonOrThrow(res, what) {
  try {
    return JSON.parse(res.body);
  } catch {
    // Kein Body-Auszug in der Meldung – der könnte Adressdaten enthalten und landet in Discord.
    throw new Error(`${what}: keine JSON-Antwort (HTTP ${res.status}) – evtl. Block-Seite`);
  }
}

module.exports = { fetchInPage, jsonOrThrow };
