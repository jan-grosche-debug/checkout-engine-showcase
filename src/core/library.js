'use strict';

/**
 * Modus-Bibliothek. Wie bei gängigen Checkout-Tools wiederholen sich viele Modi über die Seiten hinweg
 * (Safe, Preload, Request/Fast, Watch/Monitor, TestProxy). Jede Seite beschreibt nur
 * IHREN Ablauf (flow) und wählt, welche Bausteine bei ihr Sinn ergeben. Spezial-Modi
 * einer Seite (Wallet-Wege, Raffle, Queue …) definiert die Seite selbst dazu.
 *
 * flow (von der Seite geliefert):
 *   home(ctx)               → Start-URL (für Anwärmen, Anti-Bot-Cookies, TestProxy)
 *   browser.run(ctx, page)  → kompletter Ablauf per Klick/DOM (für safe)
 *   api.prepare(ctx, page)  → optional: vor T0 vorbereiten (Token, Login-Check …)
 *   api.run(ctx, page)      → Kaufweg per API-Aufrufen im Seitenkontext (für preload/request/watch)
 *   stock(ctx, page)        → true | false | null (für watch; null = unklar, kein Alarm)
 *
 * Jeder Ablauf endet nur über ctx.confirm(Beleg) mit Erfolg.
 */
const { ensureClear, loadAndCheck, recordProbe } = require('../sites/common');

const BUILDERS = {
  safe: (flow) => ({
    label: 'Safe',
    transport: 'browser',
    why: 'Voller Ablauf per Klick im sichtbaren Browser – am wenigsten auffällig, am langsamsten. Fallback, wenn API-Wege blocken.',
    async fire(ctx) {
      const page = await ctx.page();
      await ensureClear(ctx, page, flow.home(ctx));
      await flow.browser.run(ctx, page);
    },
  }),

  preload: (flow) => ({
    label: 'Preload',
    transport: 'request',
    preload: true,
    why: 'Browser, Exit, Anti-Bot-Cookies (und Vorbereitung der Seite) VOR dem Drop fertig; bei T0 nur noch API-Aufrufe. Standard für Drops mit Uhrzeit.',
    async warm(ctx) {
      const page = await ctx.page();
      await ensureClear(ctx, page, flow.home(ctx));
      if (flow.api.prepare) await flow.api.prepare(ctx, page);
    },
    async fire(ctx) {
      await flow.api.run(ctx, await ctx.page());
    },
  }),

  request: (flow) => ({
    label: 'Request',
    transport: 'request',
    why: 'API-Aufrufe ohne Rendern, Seite wird erst beim Trigger geöffnet – für spontane Restocks ohne Vorlauf.',
    async fire(ctx) {
      const page = await ctx.page();
      await ensureClear(ctx, page, flow.home(ctx));
      await flow.api.run(ctx, page);
    },
  }),

  watch: (flow) => ({
    label: 'Watch',
    transport: 'request',
    preload: true,
    why: 'Wie Preload, aber der Task wartet selbst auf Bestand (eigene, höfliche Abfrage im warmen Browser) und kauft sofort beim Wechsel auf verfügbar.',
    async warm(ctx) {
      const page = await ctx.page();
      await ensureClear(ctx, page, flow.home(ctx));
      if (flow.api.prepare) await flow.api.prepare(ctx, page);
    },
    // Jede Abfrage zählt auf den Exit. 3× hintereinander unklar (Block) → Exit verbrennen, Task scheitert.
    watchCheck: async (ctx) => {
      const r = await flow.stock(ctx, await ctx.page());
      ctx.countLoad();
      if (r === null) {
        ctx.state._unclear = (ctx.state._unclear || 0) + 1;
        if (ctx.state._unclear >= 3) {
          ctx.burnExit();
          throw new Error('Bestandsabfrage 3× blockiert/unklar – Exit verbrannt, Watch beendet');
        }
      } else ctx.state._unclear = 0;
      return r;
    },
    async fire(ctx) {
      await flow.api.run(ctx, await ctx.page());
    },
  }),

  testproxy: (flow) => ({
    label: 'TestProxy',
    transport: 'browser',
    checkout: false,
    why: 'Ein Ladevorgang gegen die Seite: Ladezeit + Block ja/nein. Geblockte Exits werden verbrannt. Zählt selbst als Ladevorgang!',
    async fire(ctx) {
      const page = await ctx.page();
      return recordProbe(ctx, await loadAndCheck(ctx, page, flow.home(ctx)));
    },
  }),
};

/** Bausteine für eine Seite erzeugen: pick(flow, ['preload', 'safe', …]). Prüft, ob der flow sie tragen kann. */
function pick(flow, keys) {
  const out = {};
  for (const k of keys) {
    const b = BUILDERS[k];
    if (!b) throw new Error(`Unbekannter Baustein "${k}" (verfügbar: ${Object.keys(BUILDERS).join(', ')})`);
    if (typeof flow.home !== 'function') throw new Error('flow.home fehlt');
    if (k === 'safe' && !flow.browser?.run) throw new Error('Baustein safe braucht flow.browser.run');
    if (['preload', 'request', 'watch'].includes(k) && !flow.api?.run) throw new Error(`Baustein ${k} braucht flow.api.run`);
    if (k === 'watch' && typeof flow.stock !== 'function') throw new Error('Baustein watch braucht flow.stock');
    out[k] = b(flow);
  }
  return out;
}

module.exports = { pick, BUILDERS };
