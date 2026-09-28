'use strict';

const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

/**
 * Zustände eines Tasks. "success" ist NUR über confirmSuccess() mit Beleg erreichbar.
 */
const STATUS = Object.freeze({
  IDLE: 'idle',
  WARMING: 'warming',     // Browser/Session/Warenkorb werden vor T0 vorbereitet
  READY: 'ready',         // warm, wartet auf Trigger (Monitor, Uhrzeit, manuell)
  RUNNING: 'running',     // heißer Pfad läuft
  HANDOFF: 'handoff',     // wartet auf Mensch (Challenge, 3DS, finale Bestätigung)
  SUCCESS: 'success',     // echte Bestellbestätigung der Seite liegt vor
  DONE: 'done',           // Nicht-Kauf-Modus fertig (z. B. Proxy-Test) – zählt NIE als Checkout
  FAILED: 'failed',
  STOPPED: 'stopped',
});

const TERMINAL = new Set([STATUS.SUCCESS, STATUS.DONE, STATUS.FAILED, STATUS.STOPPED]);

class Task extends EventEmitter {
  // Privat: Status und Ergebnis sind von außen nur lesbar (kein task.status = 'success').
  #status = STATUS.IDLE;
  #result = null;

  /**
   * @param {object} def  Task-Definition (site, mode, input, size, profileId, proxyList, delays …)
   */
  constructor(def) {
    super();
    if (!def || !def.site || !def.mode) throw new Error('Task braucht mindestens site und mode');
    this.id = def.id || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.def = { ...def };
    this.detail = '';
    this.phases = [];            // [{ name, t }] in ms seit Task-Start (performance.now)
    this.t0 = null;              // Trigger-Zeitpunkt
    this.failure = null;
    this.abort = new AbortController();
    this._start = performance.now();
  }

  get status() { return this.#status; }
  /** { orderId, source, from } – nur bei SUCCESS, eingefroren. */
  get result() { return this.#result; }

  /** Zeitmarke für eine Phase – Grundlage der Latenz-Auswertung. */
  mark(name) {
    const t = performance.now() - this._start;
    this.phases.push({ name, t });
    this.emit('phase', { name, t });
    return t;
  }

  /** Millisekunden vom Trigger (T0) bis zur Phase `name`, oder null. */
  sinceTrigger(name) {
    if (this.t0 === null) return null;
    const p = this.phases.find((x) => x.name === name);
    return p ? p.t - this.t0 : null;
  }

  markTrigger() {
    this.t0 = this.mark('trigger');
  }

  setStatus(status, detail = '') {
    if (TERMINAL.has(this.#status)) return false; // Endzustände sind endgültig
    if (status === STATUS.SUCCESS) {
      throw new Error('SUCCESS nur über confirmSuccess() mit Bestellbeleg');
    }
    this.#status = status;
    this.detail = detail;
    this.emit('status', { status, detail });
    return true;
  }

  /**
   * Einziger Weg zu SUCCESS. Der Beleg muss von der Seite stammen
   * (Bestätigungsseite / Bestell-API), nicht aus einem Redirect oder HTTP 200.
   */
  confirmSuccess(evidence) {
    if (TERMINAL.has(this.#status)) return false;
    if (!isValidEvidence(evidence)) {
      throw new Error('Kein gültiger Bestellbeleg – Checkout wird nicht als Erfolg gezählt');
    }
    this.mark('confirmed');
    this.#status = STATUS.SUCCESS;
    this.detail = `Bestellung ${evidence.orderId}`;
    this.#result = Object.freeze({ orderId: evidence.orderId, source: evidence.source, from: evidence.from });
    this.emit('status', { status: this.#status, detail: this.detail });
    this.emit('success', this.#result);
    return true;
  }

  fail(reason) {
    if (TERMINAL.has(this.#status)) return false;
    this.#status = STATUS.FAILED;
    this.failure = String(reason && reason.message ? reason.message : reason);
    this.detail = this.failure;
    this.mark('failed');
    this.emit('status', { status: this.#status, detail: this.detail });
    this.emit('failed', this.failure);
    return true;
  }

  /** Abschluss für Modi ohne Kauf (Proxy-Test). Engine erlaubt das nur bei checkout:false. */
  complete(note = '') {
    if (TERMINAL.has(this.#status)) return false;
    this.mark('done');
    this.#status = STATUS.DONE;
    this.detail = note;
    this.emit('status', { status: this.#status, detail: this.detail });
    return true;
  }

  stop() {
    if (TERMINAL.has(this.#status)) return false;
    this.abort.abort();
    this.#status = STATUS.STOPPED;
    this.detail = 'gestoppt';
    this.emit('status', { status: this.#status, detail: this.detail });
    return true;
  }

  get done() {
    return TERMINAL.has(this.#status);
  }

  /** Kompakte, geheimnisfreie Zusammenfassung (für Logs/Discord). */
  summary() {
    return {
      id: this.id,
      site: this.def.site,
      mode: this.def.mode,
      input: this.def.input,
      status: this.status,
      detail: this.detail,
      latency: {
        triggerToCart: round(this.sinceTrigger('cart')),
        triggerToSubmit: round(this.sinceTrigger('submit')),
        triggerToConfirm: round(this.sinceTrigger('confirmed')),
      },
    };
  }
}

/** Beleg = Bestellnummer + Quelle "site" + woher sie gelesen wurde. */
function isValidEvidence(e) {
  return Boolean(
    e &&
      typeof e.orderId === 'string' &&
      e.orderId.trim().length >= 3 &&
      e.source === 'site' &&
      typeof e.from === 'string' &&
      e.from.length > 0,
  );
}

function round(v) {
  return v === null ? null : Math.round(v);
}

module.exports = { Task, STATUS, TERMINAL, isValidEvidence };
