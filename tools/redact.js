'use strict';

/**
 * Schwärzung für Aufzeichnungen – ALLOWLIST statt Blocklist:
 * Behalten werden nur die STRUKTUR (Schlüsselnamen, Verschachtelung) und Werte, deren Schlüssel
 * auf der Liste harmloser Ablauf-Felder steht (Links, Typen, Status, Mengen, Preise …).
 * Alles andere wird zu "<text:N>" / "<zahl>" – egal wie das Feld heißt.
 */
const SAFE_STRING_KEYS = /^(href|uri|rel|type|status|state|code|currency|method|action|kind|name_?space|self|next|prev|messages?|severity|step|stage|mode|sku|variant|variantid|productid|pid|handle|slug|quantity|qty|available|availability|instock|in_stock|stock|price|amount|total|subtotal|display|format|locale|country|countrycode|shippingmethod|deliverymethod|id|_\w+)$/i;
const SAFE_NUMBER_KEYS = /^(quantity|qty|count|amount|price|total|subtotal|tax|shipping|stock|available|limit|max|min|position|index|status|code|version)$/i;
const LOOKS_PERSONAL = /@|\d{6,}|\b(str(\.|asse)?|weg|platz|allee)\b/i;

function redactValue(v, key) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return SAFE_NUMBER_KEYS.test(key) && Math.abs(v) < 1e7 ? v : '<zahl>';
  if (typeof v === 'string') {
    if (SAFE_STRING_KEYS.test(key) && v.length <= 300 && !LOOKS_PERSONAL.test(v.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, ''))) {
      return /^https?:\/\//.test(v) ? v.replace(/[?#].*$/, '') : v; // Links ohne Query (kann Token enthalten)
    }
    return `<text:${v.length}>`;
  }
  return '<?>';
}

function redact(v, key = '') {
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = redact(x, k);
    return o;
  }
  return redactValue(v, key);
}

/** Body beliebigen Typs schwärzen: JSON (auch ohne Content-Type), Formular, HTML, sonstiges. */
function redactBody(text, contentType = '') {
  if (!text) return null;
  const t = String(text).trim();
  if (/json/i.test(contentType) || /^[[{]/.test(t)) {
    try { return redact(JSON.parse(t)); } catch { /* kein JSON */ }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.[\]%-]+=[^&]*(&[\w.[\]%-]+=[^&]*)*$/.test(t)) {
    const o = {};
    for (const [k, v] of new URLSearchParams(t)) o[k] = redactValue(v, k);
    return { form: o };
  }
  if (/html/i.test(contentType) || /^<!doctype|^<html/i.test(t)) return `<html:${t.length}>`;
  return `<daten:${t.length}>`;
}

/** URL ohne Query/Fragment; Query nur als Schlüsselnamen. */
function cleanUrl(u) {
  try {
    const x = new URL(u);
    return { url: `${x.origin}${x.pathname}`, query: [...x.searchParams.keys()] };
  } catch {
    return { url: String(u).replace(/[?#].*$/, ''), query: [] };
  }
}

module.exports = { redact, redactBody, cleanUrl };
