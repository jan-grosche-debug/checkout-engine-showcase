# Checkout Engine Showcase

[![tests](https://github.com/jan-grosche-debug/checkout-engine-showcase/actions/workflows/test.yml/badge.svg)](https://github.com/jan-grosche-debug/checkout-engine-showcase/actions/workflows/test.yml)

The core of a checkout automation engine for limited retail drops, built from scratch in Node.js with Playwright. This public version includes the full engine, a **local test shop**, and a test suite with 49 tests, including browser end-to-end tests.

> **Scope of this repository:** It contains the engine only. Adapters for real online shops, live recording tools and proxy lists are private and not included. You can run the complete flow against the bundled test shop.

## Why it's interesting

- **Success means a confirmed order, nothing else.** A task only reaches `success` through `Task.confirmSuccess()`, which requires an order number from the shop's confirmation page or order API. A filled cart, an HTTP 200, a redirect or a 3-D Secure page is *not* success. The status cannot be set from outside the task.
- **Mode library + per-site flows.** Reusable building blocks (`preload`, `watch`, `request`, `safe`, `testproxy`) live in `src/core/library.js`. A site only describes its flow and picks the blocks it can support. The library checks at load time that the flow actually supports each block.
- **Latency is measured, not guessed.** Every phase is timed (trigger → cart → submit → confirmation) and written to the log, the database and the Discord notification. Against the local test shop: about **30 ms** in preload mode and about **380 ms** in click-through "safe" mode.
- **No fixed sleeps in the hot path.** One trigger fires all matching tasks in parallel. Tasks that are still warming up fire as soon as they are ready, so no trigger is lost.
- **Request mode without a custom TLS client.** `fetch()` runs inside the warmed-up browser page, so requests carry the browser's real fingerprint and cookies but skip rendering.
- **3-D Secure handled properly.** The engine detects the bank redirect, notifies the user and polls the order status until the order is confirmed or a timeout is reached.
- **Proxy pool with per-site "burn" tracking.** Each exit IP is counted separately per site. It is retired after N page loads or one block, and stays usable for other sites. The state survives restarts, and proxy credentials never appear in logs.
- **Privacy by design.** Payment profiles stay in a local SQLite database (`node:sqlite`) and are never logged. `tools/redact.js` removes personal fields from recorded traffic, with its own tests.
- **Deliberately not built:** mass account creation and address or identity "jigging". Payment approval and captchas always stay with the human user.

## Structure

```
src/
  core/      engine.js (scheduler, triggers, handoffs) · task.js (state machine) · library.js · modes.js
  browser/   pool.js (one context + proxy per task) · inpage.js (fetch inside the page)
  net/       proxies.js (pool, per-site burn counter)
  monitor/   triggers.js (scheduled triggers, server clock offset, polling)
  notify/    discord.js (webhook embeds, only for confirmed checkouts)
  data/      store.js (SQLite: tasks, profiles, results)
  sites/     testshop.js (reference adapter) · common.js (block detection)
test/        engine, store, proxies, redaction + end-to-end browser tests against a local shop
tools/       redact.js
```

## Try it

```bash
npm install
npm test                         # 49 tests, incl. Chromium end-to-end against the local test shop
node src/index.js modes          # list the available modes per site
```

Requires Node.js ≥ 22.13 (for `node:sqlite`).

Code comments and log messages are in German.

## License

MIT
