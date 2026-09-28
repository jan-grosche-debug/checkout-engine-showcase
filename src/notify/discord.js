'use strict';

const { STATUS, isValidEvidence } = require('../core/task');

/**
 * Discord-Meldungen per Webhook.
 *
 * REGEL: Erfolgs-Meldungen ("Checkout!") gehen NUR raus, wenn der Task wirklich
 * SUCCESS ist UND ein Bestellbeleg der Seite vorliegt. Warenkorb, Redirects, HTTP 200,
 * 3DS-Weiterleitungen sind KEIN Checkout und werden nie als Erfolg gemeldet.
 *
 * Nie im Embed: Kartendaten, Adressen, Proxy-Zugänge, E-Mail, Webhook-URL.
 */
class DiscordNotifier {
  constructor({ webhookUrl, fetchImpl } = {}) {
    this.webhookUrl = webhookUrl || '';
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async _send(payload) {
    if (!this.webhookUrl) return false;
    const res = await this.fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  }

  async success(task) {
    if (task.status !== STATUS.SUCCESS || !isValidEvidence(task.result)) {
      throw new Error('Erfolgs-Meldung verweigert: kein echter Checkout mit Bestellbeleg');
    }
    const s = task.summary();
    return this._send({
      embeds: [{
        title: '✅ Echter Checkout',
        color: 0x2ecc71,
        fields: [
          { name: 'Seite', value: s.site, inline: true },
          { name: 'Modus', value: s.mode, inline: true },
          { name: 'Produkt', value: String(s.input || '-').slice(0, 100), inline: false },
          { name: 'Bestellnummer', value: task.result.orderId, inline: true },
          { name: 'Beleg', value: task.result.from, inline: true },
          { name: 'T0 → Bestätigung', value: fmtMs(s.latency.triggerToConfirm), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }

  async handoff(task, type, message) {
    return this._send({
      content: `🟡 **Task ${task.id} braucht dich** (${type}): ${message}`,
    });
  }

  async info(task, message) {
    return this._send({ content: `ℹ️ Task ${task.id} (${task.def.site}): ${message}` });
  }

  async failed(task) {
    const s = task.summary();
    return this._send({
      embeds: [{
        title: '❌ Fehlgeschlagen',
        color: 0xe74c3c,
        fields: [
          { name: 'Seite', value: s.site, inline: true },
          { name: 'Modus', value: s.mode, inline: true },
          { name: 'Grund', value: String(s.detail).slice(0, 200) },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }
}

function fmtMs(v) {
  return v === null || v === undefined ? '–' : `${v} ms`;
}

module.exports = { DiscordNotifier };
