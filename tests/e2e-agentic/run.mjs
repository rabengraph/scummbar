#!/usr/bin/env node
// E2E agentic test runner — runs ONE test manifest against a base URL.
//
// Usage:
//   node tests/e2e-agentic/run.mjs --test=<name> --base-url=<url> [--headed] [--out=<dir>]
//
// Exits 0 on pass, 1 on fail. Writes a JSON report to <out>/<name>.report.json.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { launch } from "./lib/browser.mjs";
import { runPretest } from "./lib/pretest.mjs";
import { runAssertions } from "./lib/assertions.mjs";
import { runAgent, fetchBriefing } from "./lib/agent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const testName = args.test;
  const baseUrl = args["base-url"] || process.env.SCUMMBENCH_BASE_URL;
  const outDir = args.out ? resolve(args.out) : resolve(HERE, "reports");
  const headed = !!args.headed;

  if (!testName) fail("missing --test=<name>");
  if (!baseUrl) fail("missing --base-url=<url> (or SCUMMBENCH_BASE_URL env)");

  const manifestPath = resolve(HERE, "tests", `${testName}.json`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (e) {
    fail(`failed to load manifest ${manifestPath}: ${e.message}`);
  }

  const log = (m) => process.stderr.write(m + "\n");
  log(`[run] test=${manifest.name} baseUrl=${baseUrl} model=${manifest.agent?.model ?? "default"}`);

  const browser = await launch({ baseUrl, headless: !headed });
  const report = {
    name: manifest.name,
    feature: manifest.feature,
    baseUrl,
    startedAt: new Date().toISOString(),
    pretest: null,
    agent: null,
    assertions: null,
    ok: false,
  };

  try {
    // 1. Load briefing (also used as the agent's system-prompt cache).
    const briefing = await fetchBriefing(browser, baseUrl);
    log(`[run] briefing loaded (${briefing.length} chars)`);

    // 2. Pretest — deterministic bootstrap to the test's starting state.
    const pretestResult = await runPretest(browser, manifest.pretest || [], { log });
    report.pretest = pretestResult;
    if (!pretestResult.ok) {
      log(`[run] pretest FAILED at step ${pretestResult.failedAt}`);
      await saveScreenshot(browser, outDir, `${manifest.name}.pretest-fail.png`, report);
      return await finish(browser, outDir, manifest.name, report);
    }

    // 3. Agent loop.
    const agentResult = await runAgent({
      browser,
      task: manifest.agent?.task || "",
      briefing,
      maxTurns: manifest.agent?.maxTurns,
      model: manifest.agent?.model,
      log,
    });
    report.agent = {
      ok: agentResult.ok,
      turns: agentResult.turns,
      stopReason: agentResult.stopReason,
      finalMessage: agentResult.finalMessage,
      usage: agentResult.usage,
      toolCallCount: agentResult.toolCallLog?.length ?? 0,
      toolCalls: agentResult.toolCallLog,
      error: agentResult.error,
    };
    if (!agentResult.ok) {
      log(`[run] agent loop failed: ${agentResult.error}`);
    }

    // 4. Assertions — evaluated against the final browser state by the runner.
    const assertionsResult = await runAssertions(browser, manifest.assertions || [], { log });
    report.assertions = assertionsResult;

    report.ok = pretestResult.ok && assertionsResult.ok;
    if (!report.ok) await saveScreenshot(browser, outDir, `${manifest.name}.failure.png`, report);

    return await finish(browser, outDir, manifest.name, report);
  } catch (e) {
    report.error = String(e && e.stack || e);
    report.ok = false;
    log(`[run] ERROR ${report.error}`);
    await saveScreenshot(browser, outDir, `${manifest.name}.error.png`, report).catch(() => {});
    return await finish(browser, outDir, manifest.name, report);
  }
}

async function saveScreenshot(browser, outDir, name, report) {
  await mkdir(outDir, { recursive: true });
  const p = join(outDir, name);
  await browser.screenshot(p);
  report.screenshot = p;
}

async function finish(browser, outDir, name, report) {
  report.finishedAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `${name}.report.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stderr.write(`[run] report: ${reportPath}\n`);
  process.stdout.write(JSON.stringify({
    ok: report.ok,
    name: report.name,
    assertions: report.assertions?.results?.map((r) => ({ name: r.name, ok: r.ok, reason: r.reason })) ?? [],
    reportPath,
  }, null, 2) + "\n");
  await browser.close();
  process.exit(report.ok ? 0 : 1);
}

function fail(msg) {
  process.stderr.write(`[run] ${msg}\n`);
  process.stderr.write(`
Usage: node tests/e2e-agentic/run.mjs --test=<name> --base-url=<url> [--headed] [--out=<dir>]

  --test=<name>      Manifest file tests/e2e-agentic/tests/<name>.json
  --base-url=<url>   Deployment to test against (e.g. http://127.0.0.1:5173 or a Vercel preview)
  --headed           Launch a visible browser (default: headless)
  --out=<dir>        Report output directory (default: tests/e2e-agentic/reports)

Env: ANTHROPIC_API_KEY required for the agent loop.
`);
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`[run] unhandled: ${e && e.stack || e}\n`);
  process.exit(1);
});
