'use strict';

const { EventEmitter } = require('node:events');
const { Task, STATUS } = require('./task');
const { poller } = require('../monitor/triggers');

/**
 * Task-Engine.
 *
 * Latenz-Grundsätze (bitte beim Erweitern beibehalten):
 *  1. Alles, was vor T0 geht, passiert in warm() – Browser, Anti-Bot-Cookies, Login, Profil, Token.
 *  2. trigger() startet alle passenden Tasks SOFORT und parallel –
 *     kein await zwischen den Tasks, kein Polling einer Datenbank, keine festen Sleeps.
 *     Tasks, die beim Trigger noch anwärmen, feuern direkt nach dem Anwärmen (Trigger geht nicht verloren).
 *  3. Jede Phase bekommt eine Zeitmarke (task.mark), damit wir messen statt raten.
 *
 * Ehrlichkeit: Ein Kauf-Modus endet nur mit SUCCESS, wenn der Seitenadapter einen
 * echten Bestellbeleg liefert (ctx.confirm). Endet fire() ohne Beleg → FAILED.
 *
 * Sicherheit: Pro Task höchstens EINE offene Übergabe. Nach Stop wird nichts mehr geklickt.
 */
class Engine extends EventEmitter {
  constructor({ sites, browsers = null, proxies = null, profiles = null, notifier = null, settings = {} }) {
    super();
    this.sites = sites;
    this.browsers = browsers;
    this.proxies = proxies;
    this.profiles = profiles;
    this.notifier = notifier;
    this.settings = {
      finalSubmit: 'auto',        // 'auto' = Bot klickt sofort (Standard), 'human' = OK vorher
      handoffTimeoutMs: 5 * 60_000,
      threeDsTimeoutMs: 5 * 60_000, // so lange wartet der Bot automatisch auf die 3DS-Freigabe in der Bank-App
      threeDsPollMs: 1500,
      maxConcurrentWarm: 4,       // Browser kosten 300 MB – 1 GB RAM
      ...settings,
    };
    this.tasks = new Map();
    this._handoffs = new Map();   // taskId -> { id, type, settle(bool) }
    this._armed = new Map();      // taskId -> resolve(payload)
    this._running = new Set();    // Tasks in run(): noch nicht getriggert
    this._handoffSeq = 0;
    this._warmSlots = this.settings.maxConcurrentWarm;
    this._warmQueue = [];
  }

  add(def) {
    const site = this.sites[def.site];
    if (!site) throw new Error(`Unbekannte Seite: ${def.site}`);
    const modeKey = def.mode || site.defaultMode;
    const mode = site.modes[modeKey];
    if (!mode) throw new Error(`Seite ${def.site} hat keinen Modus "${modeKey}" (verfügbar: ${Object.keys(site.modes).join(', ')})`);
    const task = new Task({ ...def, mode: modeKey });
    task.on('status', (s) => this.emit('status', task, s));
    task.on('phase', (p) => this.emit('phase', task, p));
    task.on('success', () => this._onSuccess(task));
    this.tasks.set(task.id, task);
    this.emit('added', task);
    return task;
  }

  /** Vollständiger Lauf: warm → auf Trigger warten → fire. */
  async run(task) {
    this._running.add(task.id);
    try {
      await this.warm(task);
      if (task.done) return task;
      const { mode } = this._resolve(task);
      let stopWatch = null;
      if (mode.watchCheck && task.t0 === null) {
        // Watch-Modus: Task fragt selbst höflich nach Bestand und löst sich beim Wechsel auf "verfügbar" aus
        const ctx = this._ctx(task);
        task.setStatus(STATUS.READY, 'Watch: wartet auf Bestand');
        stopWatch = poller(
          async () => {
            if (task.done) return null;
            try {
              return await mode.watchCheck(ctx);
            } catch (err) {
              task.fail(err);
              this.stop(task.id); // beendet das Warten, räumt Browser/Exit auf
              return null;
            }
          },
          () => this.trigger({ taskId: task.id }, { reason: 'watch' }),
          { intervalMs: Number(task.def.monitorDelayMs) || 3500, jitterMs: 500 },
        );
      }
      let payload;
      try {
        payload = await this._waitForTrigger(task);
      } finally {
        if (stopWatch) stopWatch();
      }
      if (task.done) return task;
      await this.fire(task, payload);
      return task;
    } finally {
      this._running.delete(task.id);
      this._armed.delete(task.id);
    }
  }

  async warm(task) {
    const { mode } = this._resolve(task);
    task.setStatus(STATUS.WARMING, mode.preload ? 'Preload: Sitzung wird vorbereitet' : 'bereite vor');
    task.mark('warm-start');
    const release = await this._acquireWarmSlot();
    try {
      if (task.done) return task; // während Warteschlange gestoppt → keine Ladevorgänge verschwenden
      const ctx = this._ctx(task);
      void ctx.profile; // Profil jetzt laden, nicht im heißen Pfad
      if (mode.warm) await mode.warm(ctx);
      task.mark('warm-done');
      if (!task.done) task.setStatus(STATUS.READY, 'bereit – wartet auf Trigger');
    } catch (err) {
      task.fail(err);
    } finally {
      release();
      if (task.done) await this._cleanup(task);
    }
    return task;
  }

  /**
   * Trigger (Monitor-Treffer, Uhrzeit, manuell). Feuert alle passenden Tasks aus run():
   * bereite sofort, noch anwärmende direkt nach dem Anwärmen. Gibt die Anzahl zurück.
   */
  trigger(match = {}, payload = {}) {
    let n = 0;
    for (const id of this._running) {
      const task = this.tasks.get(id);
      if (!task || task.done || task.t0 !== null) continue;
      if (match.site && task.def.site !== match.site) continue;
      if (match.input && task.def.input !== match.input) continue;
      if (match.taskId && task.id !== match.taskId) continue;
      task.markTrigger();
      const resolve = this._armed.get(id);
      if (resolve) {
        this._armed.delete(id);
        resolve(payload);
      } else {
        task._pendingPayload = payload; // wärmt noch → feuert, sobald bereit
      }
      n++;
    }
    return n;
  }

  async fire(task, payload = {}) {
    const { mode } = this._resolve(task);
    if (task.done) return task;
    if (task.t0 === null) task.markTrigger();
    task.setStatus(STATUS.RUNNING, 'läuft');
    const ctx = this._ctx(task, payload);
    try {
      const out = await mode.fire(ctx);
      if (!task.done) {
        if (mode.checkout) {
          // Kein Beleg = kein Erfolg. Niemals einen Checkout "annehmen".
          task.fail('Ablauf beendet ohne Bestellbestätigung der Seite');
        } else {
          task.complete(typeof out === 'string' ? out : 'fertig');
        }
      }
    } catch (err) {
      if (!task.done) task.fail(err);
    } finally {
      await this._cleanup(task);
    }
    return task;
  }

  /**
   * Mensch hat Challenge/3DS/Kauf erledigt → Task läuft weiter.
   * handoffId (optional, z. B. aus einem Discord-Button) muss zur offenen Übergabe passen.
   */
  resolveHandoff(taskId, value = true, handoffId = null) {
    const h = this._handoffs.get(taskId);
    if (!h) return false;
    if (handoffId !== null && handoffId !== h.id) return false;
    h.settle(value);
    return true;
  }

  pendingHandoff(taskId) {
    const h = this._handoffs.get(taskId);
    return h ? { id: h.id, type: h.type } : null;
  }

  stop(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const ok = task.stop();
    this.resolveHandoff(taskId, false);
    const resolve = this._armed.get(taskId);
    if (resolve) { this._armed.delete(taskId); resolve(null); }
    this._cleanup(task);
    return ok;
  }

  stopAll() {
    for (const id of this.tasks.keys()) this.stop(id);
  }

  // ---------------------------------------------------------------- intern

  _resolve(task) {
    const site = this.sites[task.def.site];
    return { site, mode: site.modes[task.def.mode] };
  }

  _waitForTrigger(task) {
    if (task._pendingPayload !== undefined) {
      const p = task._pendingPayload;
      delete task._pendingPayload;
      return Promise.resolve(p);
    }
    return new Promise((resolve) => this._armed.set(task.id, resolve));
  }

  async _acquireWarmSlot() {
    if (this._warmSlots > 0) {
      this._warmSlots--;
    } else {
      await new Promise((r) => this._warmQueue.push(r));
    }
    let released = false;
    return () => { if (!released) { released = true; this._releaseWarmSlot(); } };
  }

  _releaseWarmSlot() {
    const next = this._warmQueue.shift();
    if (next) next(); else this._warmSlots++;
  }

  _ctx(task, payload = {}) {
    if (task._ctx) {
      task._ctx.payload = payload;
      return task._ctx;
    }
    const engine = this;
    const { site, mode } = this._resolve(task);
    const state = {}; // Adapter-Zustand zwischen warm() und fire() (Token, Warenkorb-ID …)
    const alive = () => {
      if (task.done || task.abort.signal.aborted) throw new Error('Task ist beendet/gestoppt');
    };
    const ctx = {
      task,
      site,
      mode,
      def: task.def,
      state,
      payload,
      settings: this.settings,
      signal: task.abort.signal,
      /** Profil wird einmal (in warm) geladen und zwischengespeichert. */
      get profile() {
        if (state._profile === undefined) {
          state._profile = engine.profiles && task.def.profileId != null ? engine.profiles(task.def.profileId) : null;
        }
        return state._profile;
      },
      mark: (name) => task.mark(name),
      log: (msg) => engine.emit('log', task, msg),

      /** Proxy/Exit für diesen Task (sticky). */
      proxy() {
        if (!engine.proxies || !task.def.proxyList) return null;
        if (!state._proxy) {
          alive();
          state._proxy = engine.proxies.lease(task.def.proxyList, task.id, task.def.site);
        }
        return state._proxy;
      },

      /** Warme Browser-Seite für diesen Task (eigener Kontext, eigener Exit). */
      async page() {
        if (state._page) return state._page;
        alive();
        if (!engine.browsers) throw new Error('Kein Browser-Pool konfiguriert');
        const lease = await engine.browsers.newPage({
          proxy: ctx.proxy(),
          blockHeavyResources: mode.blockHeavyResources,
        });
        if (task.done) { await lease.close(); throw new Error('Task ist beendet/gestoppt'); }
        state._lease = lease;
        state._page = lease.page;
        return lease.page;
      },

      /** Exit wurde von der Seite geladen – zählt Richtung "verbrannt". */
      countLoad() {
        const p = state._proxy;
        if (p && engine.proxies) engine.proxies.countUse(p, task.def.site, site.burnAfter || null);
      },

      /** Exit ist geblockt → nie wieder vergeben. */
      burnExit() {
        const p = state._proxy;
        if (p && engine.proxies) engine.proxies.markBurned(p, task.def.site);
      },

      /** Gemessene Ladezeit des Exits für diese Seite merken (schnelle Exits zuerst vergeben). */
      setLatency(ms) {
        const p = state._proxy;
        if (p && engine.proxies) engine.proxies.setLatency(p, task.def.site, ms);
      },

      /** Übergabe an den Menschen (Challenge, 3DS, finale Bestätigung). Max. eine offene pro Task. */
      async handoff({ type, message }) {
        alive();
        if (engine._handoffs.has(task.id)) {
          throw new Error(`Übergabe "${type}" abgelehnt: es ist schon eine Übergabe offen`);
        }
        const id = `${task.id}-${++engine._handoffSeq}`;
        let settle;
        const ok = new Promise((resolve) => {
          const timer = setTimeout(() => settle(false), engine.settings.handoffTimeoutMs);
          settle = (v) => {
            clearTimeout(timer);
            if (engine._handoffs.get(task.id)?.id === id) engine._handoffs.delete(task.id);
            resolve(Boolean(v));
          };
        });
        engine._handoffs.set(task.id, { id, type, settle });
        task.setStatus(STATUS.HANDOFF, `${type}: ${message}`);
        task.mark(`handoff:${type}`);
        if (state._page) {
          try { await state._page.bringToFront(); } catch { /* Fenster evtl. schon zu */ }
        }
        if (engine.notifier) engine.notifier.handoff(task, type, message).catch(() => {});
        engine.emit('handoff', task, { id, type, message });
        const result = await ok;
        task.mark(`handoff-end:${type}`);
        if (!result) throw new Error(`Übergabe "${type}" nicht erledigt (Zeit abgelaufen oder gestoppt)`);
        alive();
        task.setStatus(STATUS.RUNNING, 'läuft weiter');
        return true;
      },

      /**
       * Finale Kaufbestätigung. settings.finalSubmit:
       *  'auto'  → clickFn wird sofort ausgeführt (schnellster Weg)
       *  'human' → Fenster nach vorne + Discord-Ping, der Nutzer gibt OK, DANN klickt der Bot.
       * Nach Stop wird nie geklickt.
       */
      async finalSubmit(clickFn) {
        alive();
        if (engine.settings.finalSubmit !== 'auto') {
          await ctx.handoff({ type: 'kauf', message: 'Alles ausgefüllt – OK für den Kauf?' });
        }
        alive();
        task.mark('submit');
        return clickFn();
      },

      confirm: (evidence) => task.confirmSuccess(evidence),

      /**
       * 3-D-Secure automatisch abwarten: der Nutzer bestätigt nur in der Bank-App, der Bot fragt
       * selbst regelmäßig bei der Seite nach (check → { orderId } | null) und bestätigt dann.
       * Kein OK im Bot nötig. Zeitablauf → FAILED (kein Fake-Erfolg).
       */
      async await3ds(check, { from = '3ds' } = {}) {
        alive();
        task.setStatus(STATUS.RUNNING, 'warte auf 3DS-Freigabe in der Bank-App');
        task.mark('3ds-start');
        if (engine.notifier) engine.notifier.info(task, '3DS: bitte in der Bank-App freigeben').catch(() => {});
        engine.emit('info', task, '3DS: bitte in der Bank-App freigeben');
        const deadline = Date.now() + engine.settings.threeDsTimeoutMs;
        while (Date.now() < deadline) {
          alive();
          const left = deadline - Date.now();
          let timer;
          const r = await Promise.race([
            check(),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); }),
          ]).finally(() => clearTimeout(timer));
          if (r && r.orderId) {
            task.mark('3ds-done');
            return ctx.confirm({ orderId: r.orderId, source: 'site', from });
          }
          await ctx.sleep(engine.settings.threeDsPollMs);
        }
        throw new Error('3DS nicht rechtzeitig freigegeben – Bestellstatus unklar, bitte im Shop-Konto prüfen');
      },

      /** Abbruchfähiges Warten – nur für konfigurierte Delays, nie im heißen Pfad "zur Sicherheit". */
      sleep(ms) {
        return new Promise((resolve, reject) => {
          const signal = task.abort.signal;
          if (signal.aborted) return reject(new Error('gestoppt'));
          const onAbort = () => { clearTimeout(t); reject(new Error('gestoppt')); };
          const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
    task._ctx = ctx;
    return ctx;
  }

  async _cleanup(task) {
    const ctx = task._ctx;
    if (!ctx || !task.done) return;
    const { state } = ctx;
    if (state._lease) {
      const lease = state._lease;
      state._lease = null;
      state._page = null;
      try { await lease.close(); } catch { /* schon zu */ }
    }
    if (state._proxy && this.proxies) {
      this.proxies.release(state._proxy, task.id);
      state._proxy = null;
    }
  }

  _onSuccess(task) {
    if (this.notifier) this.notifier.success(task).catch(() => {});
  }
}

module.exports = { Engine };
