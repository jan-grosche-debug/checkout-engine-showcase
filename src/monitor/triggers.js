'use strict';

/**
 * Trigger-Quellen für engine.trigger():
 *  - atTime: feuert zu einer Uhrzeit (gegen die SERVER-Uhr der Seite korrigiert)
 *  - poller: fragt höflich in Intervallen, feuert beim Wechsel "nicht verfügbar → verfügbar"
 *  - (Phase 2) Discord-Kanal als Quelle
 */

/**
 * Server-Uhr-Versatz über den Date-Header (Auflösung 1 s → wir nehmen die Mitte des Roundtrips).
 * Mehrere Proben, bester (kürzester Roundtrip) gewinnt.
 */
async function serverClockOffset(url, { samples = 3, fetchImpl = globalThis.fetch } = {}) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t1 = Date.now();
    const res = await fetchImpl(url, { method: 'HEAD' });
    const t2 = Date.now();
    const d = res.headers.get('date');
    if (!d) continue;
    const server = new Date(d).getTime() + 500; // Header ist auf Sekunden abgeschnitten
    const rtt = t2 - t1;
    const offset = server - (t1 + rtt / 2);
    if (!best || rtt < best.rtt) best = { offset, rtt };
  }
  return best ? best.offset : 0;
}

/**
 * Feuert fn() zur Zeit `when` (Date|ms) + offset. Grob mit setTimeout, die letzten
 * ~20 ms mit setImmediate-Schleife, damit wir nicht um ein Timer-Tick zu spät sind.
 */
function atTime(when, fn, { offsetMs = 0, leadMs = 0 } = {}) {
  const target = (when instanceof Date ? when.getTime() : when) - offsetMs - leadMs;
  let cancelled = false;
  const spin = () => {
    if (cancelled) return;
    if (Date.now() >= target) return fn();
    setImmediate(spin);
  };
  const wait = target - Date.now() - 20;
  const t = setTimeout(spin, Math.max(0, wait));
  return () => { cancelled = true; clearTimeout(t); };
}

/**
 * Höflicher Poller. check() → true | false | null (null = weiß nicht, z. B. Block → kein Alarm).
 * Feuert onAvailable nur beim Übergang auf true.
 */
function poller(check, onAvailable, { intervalMs = 5000, jitterMs = 1000 } = {}) {
  let last = false;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    let now = null;
    try { now = await check(); } catch { now = null; }
    if (now === true && last !== true) onAvailable();
    if (now !== null) last = now;
    if (!stopped) timer = setTimeout(tick, intervalMs + Math.random() * jitterMs);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { serverClockOffset, atTime, poller };
