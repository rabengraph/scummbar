// Headless Playwright wrapper used by the E2E agentic runner.
//
// Deliberately small: one page, one eval helper, a console-log buffer, and
// a screenshot-on-demand. Everything the agent does goes through `eval`.
//
// We wrap every evaluation in a try/catch + hard timeout so a bad
// expression from the agent can never hang the test.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_EVAL_TIMEOUT_MS = 15_000;

export async function launch({ baseUrl, headless = true, slowMo = 0 } = {}) {
  if (!baseUrl) throw new Error("launch: baseUrl required");

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const consoleLog = [];
  page.on("console", (msg) => {
    consoleLog.push({
      t: Date.now(),
      type: msg.type(),
      text: msg.text(),
    });
    // Keep the buffer bounded — SCUMM emits a lot.
    if (consoleLog.length > 2000) consoleLog.splice(0, consoleLog.length - 2000);
  });
  page.on("pageerror", (err) => {
    consoleLog.push({ t: Date.now(), type: "pageerror", text: String(err) });
  });

  async function evalInPage(expression, { timeoutMs = DEFAULT_EVAL_TIMEOUT_MS } = {}) {
    // Wrap so we always return structured data and never throw across the boundary.
    const wrapped = `(async () => {
      try {
        const __v = await Promise.resolve(eval(${JSON.stringify(expression)}));
        return { ok: true, value: __v === undefined ? null : __v };
      } catch (e) {
        return { ok: false, error: String(e && e.stack || e) };
      }
    })()`;

    try {
      const r = await Promise.race([
        page.evaluate(wrapped),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`eval timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      return r;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  async function navigate(path) {
    const url = path.startsWith("http") ? path : baseUrl.replace(/\/$/, "") + path;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return url;
  }

  async function screenshot(filePath) {
    await mkdir(dirname(filePath), { recursive: true });
    const buf = await page.screenshot({ type: "png", fullPage: false });
    await writeFile(filePath, buf);
    return filePath;
  }

  function takeConsole({ since = 0 } = {}) {
    return consoleLog.filter((e) => e.t >= since);
  }

  async function close() {
    try { await page.close(); } catch (_e) {}
    try { await context.close(); } catch (_e) {}
    try { await browser.close(); } catch (_e) {}
  }

  return {
    baseUrl,
    page,
    eval: evalInPage,
    navigate,
    screenshot,
    takeConsole,
    close,
  };
}
