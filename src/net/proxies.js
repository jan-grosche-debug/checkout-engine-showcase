'use strict';

const crypto = require('node:crypto');

/**
 * Proxy-Pool mit "Verbrennungs"-Zähler PRO SEITE.
 * Gelernt (Drop-Protokoll): ein Exit verbrennt bei manchen Shops nach wenigen Ladevorgängen –
 * für andere Seiten kann derselbe Exit (z. B. ISP) aber noch sauber sein. Deshalb zählt der Pool
 * Ladevorgänge und Blocks je (Exit, Seite). Die Grenze setzt die Seite (site.burnAfter).
 *
 * Zugangsdaten verlassen dieses Modul nur als Playwright-Proxy-Objekt – nie in Logs (label() = host:port).
 */

function parseProxyLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (/^[a-z0-9]+:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: Number(u.port),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  }
  const parts = s.split(':');
  if (parts.length === 2 || parts.length === 4) {
    const [host, port, username = '', password = ''] = parts;
    if (!host || !/^\d+$/.test(port)) return null;
    return { protocol: 'http', host, port: Number(port), username, password };
  }
  return null;
}

class ProxyPool {
  constructor() {
    this.lists = new Map(); // name -> [proxy]
  }

  addList(name, lines) {
    const arr = (Array.isArray(lines) ? lines : String(lines).split(/\r?\n/))
      .map(parseProxyLine)
      .filter(Boolean)
      .map((p) => ({ ...p, list: name, leasedBy: null, sites: {} }));
    this.lists.set(name, arr);
    return arr.length;
  }

  /** Zustand eines Exits für eine Seite. */
  siteState(proxy, site) {
    if (!proxy.sites[site]) proxy.sites[site] = { uses: 0, burned: false, latencyMs: null };
    return proxy.sites[site];
  }

  /** Frischesten freien Exit für die Seite vergeben (wenigste Ladevorgänge, dann schnellste Latenz). */
  lease(listName, taskId, site) {
    const list = this.lists.get(listName);
    if (!list) throw new Error(`Proxy-Liste "${listName}" unbekannt`);
    const free = list.filter((p) => !p.leasedBy && !this.siteState(p, site).burned);
    if (free.length === 0) throw new Error(`Proxy-Liste "${listName}": kein frischer Exit mehr frei für ${site}`);
    free.sort((a, b) => {
      const sa = this.siteState(a, site); const sb = this.siteState(b, site);
      return sa.uses - sb.uses || (sa.latencyMs ?? 1e9) - (sb.latencyMs ?? 1e9);
    });
    const p = free[0];
    p.leasedBy = taskId;
    return p;
  }

  release(proxy, taskId) {
    if (proxy && proxy.leasedBy === taskId) proxy.leasedBy = null;
  }

  /** Ein Ladevorgang auf der Seite. burnAfter = Grenze der Seite (null = keine bekannte Grenze). */
  countUse(proxy, site, burnAfter = null) {
    const st = this.siteState(proxy, site);
    st.uses += 1;
    if (burnAfter && st.uses >= burnAfter) st.burned = true;
  }

  markBurned(proxy, site) {
    this.siteState(proxy, site).burned = true;
  }

  setLatency(proxy, site, ms) {
    this.siteState(proxy, site).latencyMs = ms;
  }

  /** Nutzungsstand ohne Zugangsdaten – gespeichert in data/proxy-state.json, damit "verbrannt" über Neustarts hält. */
  exportState() {
    const out = {};
    for (const [name, list] of this.lists) {
      for (const p of list) {
        for (const [site, st] of Object.entries(p.sites)) {
          if (st.uses || st.burned || st.latencyMs != null) out[`${name}|${stateKey(p)}|${site}`] = { ...st };
        }
      }
    }
    return out;
  }

  importState(state = {}) {
    for (const [name, list] of this.lists) {
      for (const p of list) {
        for (const [key, st] of Object.entries(state)) {
          const [n, hp, site] = key.split('|');
          if (n === name && hp === stateKey(p) && site) {
            p.sites[site] = { uses: st.uses || 0, burned: Boolean(st.burned), latencyMs: st.latencyMs ?? null };
          }
        }
      }
    }
  }

  stats(listName, site) {
    const list = this.lists.get(listName) || [];
    const st = (p) => (site ? this.siteState(p, site) : { uses: 0, burned: false });
    return {
      total: list.length,
      fresh: list.filter((p) => !st(p).burned && st(p).uses === 0).length,
      usable: list.filter((p) => !st(p).burned).length,
      burned: list.filter((p) => st(p).burned).length,
    };
  }
}

/**
 * Schlüssel für den gespeicherten Zustand: host:port + kurzer Hash des Benutzernamens
 * (Residential-Gateways: gleicher host:port, andere Sitzung je Benutzername). Nie Klartext.
 */
function stateKey(p) {
  const h = p.username ? crypto.createHash('sha256').update(p.username).digest('hex').slice(0, 8) : '-';
  return `${p.host}:${p.port}#${h}`;
}

/** Nur host:port – niemals Zugangsdaten ausgeben. */
function label(p) {
  return p ? `${p.host}:${p.port}` : 'lokal';
}

/** Playwright-Format. */
function toPlaywright(p) {
  if (!p) return undefined;
  const out = { server: `${p.protocol}://${p.host}:${p.port}` };
  if (p.username) out.username = p.username;
  if (p.password) out.password = p.password;
  return out;
}

module.exports = { ProxyPool, parseProxyLine, label, toPlaywright, stateKey };
