// Deterministic pretest executor.
//
// A pretest is an array of steps that get the game to the starting state
// of a test. No LLM involved. Each step kind is small and composable —
// if you need new behavior, add a kind here rather than embedding
// cleverness in a test manifest.

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 250;

export async function runPretest(browser, steps, { log = () => {} } = {}) {
  const trace = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const startedAt = Date.now();
    const entry = { index: i, kind: step.kind, step, startedAt };
    try {
      switch (step.kind) {
        case "navigate": {
          const url = await browser.navigate(step.path);
          entry.url = url;
          break;
        }
        case "waitFor": {
          const result = await waitFor(browser, step.expression, {
            timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
            pollMs: step.pollMs ?? DEFAULT_WAIT_POLL_MS,
          });
          entry.pollAttempts = result.attempts;
          entry.value = result.value;
          if (!result.ok) {
            entry.ok = false;
            entry.error = result.error || `timed out after ${step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS}ms waiting for: ${step.expression}`;
            entry.durationMs = Date.now() - startedAt;
            trace.push(entry);
            return { ok: false, trace, failedAt: i };
          }
          break;
        }
        case "eval": {
          const r = await browser.eval(step.expression, { timeoutMs: step.timeoutMs });
          entry.value = r.value;
          if (!r.ok) {
            entry.ok = false;
            entry.error = r.error;
            entry.durationMs = Date.now() - startedAt;
            trace.push(entry);
            return { ok: false, trace, failedAt: i };
          }
          break;
        }
        case "sleep": {
          await new Promise((r) => setTimeout(r, step.ms));
          break;
        }
        default:
          entry.ok = false;
          entry.error = `unknown pretest step kind: ${step.kind}`;
          entry.durationMs = Date.now() - startedAt;
          trace.push(entry);
          return { ok: false, trace, failedAt: i };
      }
      entry.ok = true;
      entry.durationMs = Date.now() - startedAt;
      trace.push(entry);
      log(`[pretest] ${i} ${step.kind} ok (${entry.durationMs}ms)`);
    } catch (e) {
      entry.ok = false;
      entry.error = String(e && e.message || e);
      entry.durationMs = Date.now() - startedAt;
      trace.push(entry);
      return { ok: false, trace, failedAt: i };
    }
  }
  return { ok: true, trace };
}

async function waitFor(browser, expression, { timeoutMs, pollMs }) {
  const start = Date.now();
  let attempts = 0;
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const r = await browser.eval(expression, { timeoutMs: Math.min(pollMs * 20, 5000) });
    if (r.ok && r.value) return { ok: true, attempts, value: r.value };
    if (!r.ok) lastError = r.error;
    await new Promise((rs) => setTimeout(rs, pollMs));
  }
  return { ok: false, attempts, error: lastError };
}
