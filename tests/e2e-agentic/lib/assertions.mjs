// Deterministic assertion runner.
//
// The agent does not self-certify. After the agent loop ends, we
// re-evaluate each assertion's `expression` in the page and match it
// against its `predicate`. Predicates are intentionally limited so
// manifests stay readable.

export async function runAssertions(browser, assertions, { log = () => {} } = {}) {
  const results = [];
  for (const a of assertions) {
    const r = await browser.eval(a.expression, { timeoutMs: 5000 });
    if (!r.ok) {
      results.push({ name: a.name, ok: false, error: `eval failed: ${r.error}`, expression: a.expression });
      log(`[assert] ${a.name} ERROR ${r.error}`);
      continue;
    }
    const match = matchPredicate(r.value, a.predicate);
    results.push({
      name: a.name,
      ok: match.ok,
      actual: r.value,
      predicate: a.predicate,
      reason: match.reason,
      expression: a.expression,
    });
    log(`[assert] ${a.name} ${match.ok ? "pass" : "FAIL"}${match.reason ? " — " + match.reason : ""}`);
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

function matchPredicate(actual, predicate) {
  if (!predicate || typeof predicate !== "object") {
    return { ok: false, reason: "no predicate" };
  }
  const keys = Object.keys(predicate);
  if (keys.length !== 1) {
    return { ok: false, reason: `predicate must have exactly one key, got: ${keys.join(",")}` };
  }
  const [op] = keys;
  const expected = predicate[op];

  switch (op) {
    case "equals":
      return actual === expected
        ? { ok: true }
        : { ok: false, reason: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
    case "deepEquals":
      return deepEqual(actual, expected)
        ? { ok: true }
        : { ok: false, reason: `deepEquals failed — got ${JSON.stringify(actual)}` };
    case "in":
      if (!Array.isArray(expected)) return { ok: false, reason: "`in` expects an array" };
      return expected.includes(actual)
        ? { ok: true }
        : { ok: false, reason: `${JSON.stringify(actual)} not in ${JSON.stringify(expected)}` };
    case "contains":
      if (typeof actual === "string") {
        return actual.includes(String(expected))
          ? { ok: true }
          : { ok: false, reason: `string does not contain ${JSON.stringify(expected)}` };
      }
      if (Array.isArray(actual)) {
        return actual.some((v) => deepEqual(v, expected))
          ? { ok: true }
          : { ok: false, reason: `array does not contain ${JSON.stringify(expected)}` };
      }
      return { ok: false, reason: `contains: actual must be string or array, got ${typeof actual}` };
    case "gte":
      return typeof actual === "number" && actual >= expected
        ? { ok: true }
        : { ok: false, reason: `${actual} !>= ${expected}` };
    case "lte":
      return typeof actual === "number" && actual <= expected
        ? { ok: true }
        : { ok: false, reason: `${actual} !<= ${expected}` };
    case "gt":
      return typeof actual === "number" && actual > expected
        ? { ok: true }
        : { ok: false, reason: `${actual} !> ${expected}` };
    case "lt":
      return typeof actual === "number" && actual < expected
        ? { ok: true }
        : { ok: false, reason: `${actual} !< ${expected}` };
    case "matches":
      if (typeof actual !== "string") return { ok: false, reason: `matches: actual must be string, got ${typeof actual}` };
      try {
        const re = new RegExp(expected);
        return re.test(actual) ? { ok: true } : { ok: false, reason: `does not match /${expected}/` };
      } catch (e) {
        return { ok: false, reason: `invalid regex: ${e.message}` };
      }
    case "isArray":
      return Array.isArray(actual) === !!expected
        ? { ok: true }
        : { ok: false, reason: `isArray: expected ${!!expected}, got ${Array.isArray(actual)}` };
    default:
      return { ok: false, reason: `unknown predicate op: ${op}` };
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}
