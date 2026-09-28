'use strict';

const { toPlaywright } = require('../net/proxies');

/**
 * Browser-Pool auf Playwright-Basis.
 *  - EIN Browser-Prozess, pro Task ein eigener Kontext (eigene Cookies, eigener Exit).
 *  - Der Browser wird beim ersten Warm-up gestartet und bleibt offen → kein Kaltstart zum Drop.
 *  - headful (sichtbar) als Standard: viele Shops blocken headless.
 *  - Browser: Microsoft Edge (channel 'msedge').  Jeder Task = eigener Kontext
 *    mit EIGENEM Proxy.
 */
class BrowserPool {
  constructor({ headless = false, executablePath, channel, launcher, args } = {}) {
    this.opts = { headless, executablePath, channel, args };
    this._launcher = launcher || null;
    this._browser = null;
    this._starting = null;
  }

  async _getBrowser() {
    if (this._browser && this._browser.isConnected()) return this._browser;
    if (!this._starting) {
      this._starting = (async () => {
        const launcher = this._launcher || require('playwright').chromium;
        const launchOpts = { headless: this.opts.headless };
        if (this.opts.executablePath) launchOpts.executablePath = this.opts.executablePath;
        if (this.opts.channel) launchOpts.channel = this.opts.channel;
        if (this.opts.args) launchOpts.args = this.opts.args;
        this._browser = await launcher.launch(launchOpts);
        return this._browser;
      })().finally(() => { this._starting = null; });
    }
    return this._starting;
  }

  /** Browser vorab starten (z. B. Minuten vor dem Drop). */
  async prewarm() {
    await this._getBrowser();
  }

  async newPage({ proxy = null, blockHeavyResources = false } = {}) {
    const browser = await this._getBrowser();
    const context = await browser.newContext({
      proxy: toPlaywright(proxy),
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: null,
    });
    if (blockHeavyResources) {
      // Nur Bilder/Medien/Fonts – nie Skripte (die rendern Preise und Anti-Bot-Checks).
      await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
      });
    }
    const page = await context.newPage();
    return {
      page,
      context,
      close: async () => {
        try { await context.close(); } catch { /* bereits zu */ }
      },
    };
  }

  async close() {
    if (this._browser) {
      const b = this._browser;
      this._browser = null;
      try { await b.close(); } catch { /* bereits zu */ }
    }
  }
}

module.exports = { BrowserPool };
