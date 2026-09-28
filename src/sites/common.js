'use strict';

/**
 * Erkennt typische Block-/Challenge-Seiten – auch wenn sie mit HTTP 200 kommen (Imperva macht das).
 * Gibt den Typ zurück oder null.
 */
function detectBlock(html) {
  const b = String(html || '').toLowerCase();
  if (b.includes('incapsula') || b.includes('_incapsula_resource') || b.includes('request unsuccessful')) return 'imperva';
  if (b.includes('captcha-delivery.com') || b.includes('datadome')) return 'datadome';
  if (b.includes('challenges.cloudflare.com') || b.includes('cf-chl-') || b.includes('just a moment')) return 'cloudflare';
  if (b.includes('hcaptcha.com')) return 'hcaptcha';
  return null;
}

/**
 * Seite laden, als Ladevorgang auf den Exit zählen, auswerten.
 *  block: Anti-Bot-Seite oder 403/429 → Exit ist für diese Seite geblockt
 *  error: andere HTTP-Fehler (404, 5xx, Wartung) → unklar, Exit NICHT verbrennen
 */
async function loadAndCheck(ctx, page, url, { timeout = 30_000 } = {}) {
  const t = Date.now();
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  ctx.countLoad();
  const ms = Date.now() - t;
  const status = res ? res.status() : 0;
  const block = detectBlock(await page.content()) || (status === 403 || status === 429 ? `http-${status}` : null);
  const error = !block && status >= 400 ? `http-${status}` : null;
  return { ms, block, error, status };
}

/** Bei Block: Mensch löst im sichtbaren Fenster, danach erneut prüfen. */
async function ensureClear(ctx, page, url) {
  const first = await loadAndCheck(ctx, page, url);
  if (first.error) throw new Error(`Seite antwortet mit ${first.error} – unklar (Wartung/falsche URL?), Exit nicht verbrannt`);
  if (!first.block) return first;
  await ctx.handoff({ type: 'challenge', message: `${first.block}-Block auf ${new URL(url).host} – bitte im Fenster lösen` });
  const again = await loadAndCheck(ctx, page, url);
  if (again.block) {
    ctx.burnExit();
    throw new Error(`Weiter blockiert (${again.block}) – Exit als verbrannt markiert, frischen Exit nehmen`);
  }
  if (again.error) throw new Error(`Seite antwortet mit ${again.error} – unklar, Exit nicht verbrannt`);
  return again;
}

/** Proxy-Test-Auswertung: Block → Exit verbrennen; Fehler → unklar; sonst Ladezeit am Exit speichern. */
function recordProbe(ctx, r) {
  ctx.proxy();
  if (r.block) {
    ctx.burnExit();
    return `blockiert (${r.block}) nach ${r.ms} ms – Exit verbrannt`;
  }
  if (r.error) return `unklar (${r.error}) nach ${r.ms} ms – nicht verbrannt`;
  ctx.setLatency(r.ms);
  return `ok, ${r.ms} ms`;
}

module.exports = { detectBlock, loadAndCheck, ensureClear, recordProbe };
