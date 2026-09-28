'use strict';

/**
 * Modi = Strategien je Seite. Es gibt sie aus gutem Grund: jede Seite hat einen
 * anderen Tausch zwischen Tempo und Block-Risiko. Ein Modus sagt deshalb offen,
 * womit er arbeitet und was er dafür in Kauf nimmt.
 *
 * transport:
 *   'browser'  – echter (sichtbarer) Browser, voller Seitenablauf. Robust, langsamer.
 *   'request'  – API-Aufrufe ohne Rendern. Hier: fetch() IM Seitenkontext eines
 *                warmen Browsers → gleicher TLS-Fingerprint, gleiche Cookies wie der
 *                Browser, aber ohne Rendern/Klicken. Schnellster Weg ohne eigenen TLS-Client.
 *   'none'     – kein Checkout (z. B. Proxy-Test).
 *
 * preload: true = alles, was vor T0 geht (Browser, Anti-Bot-Cookies, Login,
 *   Warenkorb/Token), passiert in warm(); fire() macht nur noch den heißen Rest.
 */
const TRANSPORTS = new Set(['browser', 'request', 'none']);

function defineMode(key, spec) {
  if (!TRANSPORTS.has(spec.transport)) throw new Error(`Modus ${key}: unbekannter transport ${spec.transport}`);
  if (typeof spec.fire !== 'function') throw new Error(`Modus ${key}: fire() fehlt`);
  if (!spec.why) throw new Error(`Modus ${key}: bitte begründen (why), wofür der Modus da ist`);
  return Object.freeze({
    key,
    label: spec.label || key,
    transport: spec.transport,
    preload: Boolean(spec.preload),
    why: spec.why,
    checkout: spec.checkout !== false, // TestProxy & Co. kaufen nicht
    blockHeavyResources: Boolean(spec.blockHeavyResources),
    warm: spec.warm || null,
    watchCheck: spec.watchCheck || null, // Watch-Modi: eigene Bestandsabfrage, löst den Task selbst aus
    fire: spec.fire,
  });
}

function defineSite(spec) {
  if (!spec.key || !spec.modes) throw new Error('Seite braucht key und modes');
  const modes = {};
  for (const [k, m] of Object.entries(spec.modes)) modes[k] = defineMode(k, m);
  const defaultMode = spec.defaultMode || Object.keys(modes)[0];
  if (!modes[defaultMode]) throw new Error(`Seite ${spec.key}: defaultMode ${defaultMode} existiert nicht`);
  return Object.freeze({ ...spec, modes, defaultMode });
}

module.exports = { defineMode, defineSite, TRANSPORTS };
