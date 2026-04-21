// Claude agent loop for E2E tests.
//
// Uses the Anthropic SDK directly (not the Agent SDK) — we want a tiny,
// auditable loop. One tool: `browser_eval`. The agent's job is to drive
// the test to completion; verdict is decided separately by assertions.mjs
// against the final browser state.
//
// Prompt caching: the briefing JSON is large and identical across every
// turn inside a test run, so we cache it on the system block.

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_TOKENS = 4096;

export async function runAgent({
  browser,
  task,
  briefing,
  maxTurns = DEFAULT_MAX_TURNS,
  model = DEFAULT_MODEL,
  log = () => {},
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  const systemBlocks = [
    {
      type: "text",
      text:
        "You are driving a headless browser to execute an automated end-to-end test on a running ScummBench deployment. " +
        "You have ONE tool: `browser_eval`, which evaluates a JavaScript expression in the loaded page and returns the result. " +
        "All game interaction is through `window.__scumm*` globals — see the briefing below for the full API. " +
        "The page is already navigated to /game and the pretest has completed; the game is ready at the test's starting state. " +
        "Hard rules: NEVER write an unbounded polling loop in your eval. Always bracket with `Date.now() - start > N` or prefer `setTimeout` + `__scummRecordSummary()`. " +
        "When you believe the test is done, stop calling tools and write a brief final summary — the runner will then verify assertions against the final state.",
    },
    {
      type: "text",
      text: "=== BRIEFING ===\n" + briefing,
      cache_control: { type: "ephemeral" },
    },
  ];

  const tools = [
    {
      name: "browser_eval",
      description:
        "Evaluate a JavaScript expression in the test page. Returns `{ ok, value }` on success or `{ ok: false, error }` on failure. " +
        "Use this for ALL game interaction: `__scummRead()`, `__scummDoSentence(...)`, `__scummRecordSummary()`, etc. " +
        "Expression can be an async IIFE for multi-step operations.",
      input_schema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "JavaScript expression to evaluate in the page. Will be wrapped in a try/catch.",
          },
          timeoutMs: {
            type: "integer",
            description: "Eval timeout in ms (default 15000). Keep individual evals under 15s.",
          },
        },
        required: ["expression"],
      },
    },
  ];

  const messages = [{ role: "user", content: task }];
  const toolCallLog = [];
  let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await client.messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemBlocks,
      tools,
      messages,
    });

    usage.input_tokens += resp.usage?.input_tokens ?? 0;
    usage.output_tokens += resp.usage?.output_tokens ?? 0;
    usage.cache_creation_input_tokens += resp.usage?.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += resp.usage?.cache_read_input_tokens ?? 0;

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    const textBlocks = resp.content.filter((b) => b.type === "text");
    const summaryText = textBlocks.map((b) => b.text).join("\n").trim();
    if (summaryText) log(`[agent turn ${turn}] ${summaryText.slice(0, 200)}${summaryText.length > 200 ? "…" : ""}`);

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason === "end_turn" || toolUses.length === 0) {
      return {
        ok: true,
        stopReason: resp.stop_reason,
        turns: turn + 1,
        finalMessage: summaryText,
        toolCallLog,
        usage,
      };
    }

    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name !== "browser_eval") {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `unknown tool: ${tu.name}` });
        continue;
      }
      const { expression, timeoutMs } = tu.input || {};
      log(`[agent turn ${turn}] eval: ${String(expression).slice(0, 160)}${String(expression).length > 160 ? "…" : ""}`);
      const r = await browser.eval(String(expression), { timeoutMs });
      toolCallLog.push({ turn, expression, result: r });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(r).slice(0, 20_000), // hard cap per-result payload
        is_error: !r.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    ok: false,
    error: `agent did not stop within ${maxTurns} turns`,
    turns: maxTurns,
    toolCallLog,
    usage,
  };
}

export async function fetchBriefing(browser, baseUrl) {
  // Fetch the briefing JSON from the deployment so the agent's system
  // prompt reflects the exact API surface it's being tested against.
  await browser.navigate("/briefing");
  const r = await browser.eval(
    `(() => {
       const el = document.getElementById("agent-brief");
       return el ? el.textContent.trim() : null;
     })()`,
    { timeoutMs: 5000 },
  );
  if (!r.ok || !r.value) throw new Error(`failed to read briefing: ${r.error || "not found"}`);
  return r.value;
}
