// bridge.js
//
// Receives SCUMM state from the wasm runtime and normalizes it into
// the public surfaces agents read:
//
//   - window.__scummState       (latest authoritative snapshot)
//   - #scumm-state              (JSON mirror in the DOM)
//   - console.debug("[SCUMM_STATE]", ...)
//   - console.debug("[SCUMM_EVENT]", ...)
//   - CustomEvents on window    ("scumm:state", "scumm:event")
//
// The scummvm-agent fork publishes state by calling
// window.__scummPublish(snapshotObject). It should also call
// window.__scummEmit(eventObject) for immediate event messages
// (room/hover/sentence/inventory/ego-moved, see fork's AGENT_HARNESS.md).
//
// Keep this file small — all schema knowledge lives in the fork. The
// harness tolerates unknown top-level keys so additive changes to the
// snapshot don't require bridge changes. A schema version bump (any
// field removed or renamed) logs a loud warning once so the operator
// knows the harness may be rendering stale assumptions.

const HISTORY_CAP = 64;

// Bump this when the consumers (overlay/panel/runbook) are updated for
// a new snapshot schema. Must match the fork's Agent::kSchemaVersion.
const SUPPORTED_SCHEMA = 1;
let schemaWarned = false;

const state = {
  latest: null,
  history: [],
  events: [],
};

function nowIso() {
  return new Date().toISOString();
}

function writeDomMirror(snapshot) {
  const node = document.getElementById("scumm-state");
  if (!node) return;
  try {
    node.textContent = JSON.stringify(snapshot, null, 2);
  } catch (e) {
    node.textContent = "{}";
    console.warn("[SCUMM_BRIDGE] failed to stringify snapshot", e);
  }
}

function persistForStatus() {
  try {
    sessionStorage.setItem(
      "scummLatestSnapshot",
      JSON.stringify(state.latest ?? null)
    );
    sessionStorage.setItem(
      "scummRecentEvents",
      JSON.stringify(state.events.slice(-HISTORY_CAP))
    );
  } catch (_e) {
    // sessionStorage may be disabled; /status will just show empty.
  }
}

function publish(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  if (typeof snapshot.schema === "number" && snapshot.schema > SUPPORTED_SCHEMA && !schemaWarned) {
    schemaWarned = true;
    console.warn(
      "[SCUMM_BRIDGE] snapshot schema " +
        snapshot.schema +
        " is newer than harness-supported schema " +
        SUPPORTED_SCHEMA +
        ". Rendering may be stale; update the harness."
    );
  }

  const normalized = {
    receivedAt: nowIso(),
    ...snapshot,
  };

  state.latest = normalized;
  state.history.push(normalized);
  if (state.history.length > HISTORY_CAP) {
    state.history.splice(0, state.history.length - HISTORY_CAP);
  }

  window.__scummState = normalized;
  writeDomMirror(normalized);
  persistForStatus();

  console.debug("[SCUMM_STATE]", normalized);
  window.dispatchEvent(
    new CustomEvent("scumm:state", { detail: normalized })
  );
}

function emit(event) {
  if (!event || typeof event !== "object") return;
  const normalized = { receivedAt: nowIso(), ...event };
  state.events.push(normalized);
  if (state.events.length > HISTORY_CAP) {
    state.events.splice(0, state.events.length - HISTORY_CAP);
  }
  persistForStatus();

  console.debug("[SCUMM_EVENT]", normalized);
  window.dispatchEvent(
    new CustomEvent("scumm:event", { detail: normalized })
  );
}

// Install the bridge before the wasm runtime loads so the fork can
// simply call these functions from its Emscripten EM_JS code.
window.__scummPublish = publish;
window.__scummEmit = emit;

// Expose a tiny read helper that agents may prefer over poking the
// globals directly.
window.__scummRead = function readScummState() {
  return state.latest;
};

window.__scummHistory = function readScummHistory() {
  return state.history.slice();
};

window.__scummEvents = function readScummEvents() {
  return state.events.slice();
};

// --------------------------------------------------------------------------
// Action API — commands from agent to engine
// --------------------------------------------------------------------------
// These functions call into the WASM module's exported agent_* functions.
// The Module object must be available (WASM loaded) for these to work.

/**
 * Click a verb by its ID. Works for both action verbs and dialog choices.
 * @param {number} verbId - The verb ID from verbs[].id in the snapshot
 * @returns {boolean} - true if the command was sent, false if Module not ready
 */
window.__scummClickVerb = function clickVerb(verbId) {
  if (typeof Module === "undefined" || !Module._agent_click_verb) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickVerb");
    return false;
  }
  Module._agent_click_verb(verbId);
  console.debug("[SCUMM_CMD] clickVerb", verbId);
  return true;
};

/**
 * Click at a position in room/virtual-screen coordinates.
 * @param {number} x - X coordinate in room space
 * @param {number} y - Y coordinate in room space
 * @returns {boolean} - true if the command was sent
 */
window.__scummClickAt = function clickAt(x, y) {
  if (typeof Module === "undefined" || !Module._agent_click_at) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickAt");
    return false;
  }
  Module._agent_click_at(x, y);
  console.debug("[SCUMM_CMD] clickAt", x, y);
  return true;
};

/**
 * Walk ego to a position in room coordinates.
 * @param {number} x - X coordinate in room space
 * @param {number} y - Y coordinate in room space
 * @returns {boolean} - true if the command was sent
 */
window.__scummWalkTo = function walkTo(x, y) {
  if (typeof Module === "undefined" || !Module._agent_walk_to) {
    console.warn("[SCUMM_BRIDGE] Module not ready for walkTo");
    return false;
  }
  Module._agent_walk_to(x, y);
  console.debug("[SCUMM_CMD] walkTo", x, y);
  return true;
};

/**
 * Click on an object by its ID. This is the preferred method for agents
 * since it bypasses coordinate space conversions entirely - the engine
 * looks up the object position and handles the click internally.
 * @param {number} objectId - The object ID from roomObjects[].id in the snapshot
 * @returns {boolean} - true if the command was sent
 */
window.__scummClickObject = function clickObject(objectId) {
  if (typeof Module === "undefined" || !Module._agent_click_object) {
    console.warn("[SCUMM_BRIDGE] Module not ready for clickObject");
    return false;
  }
  Module._agent_click_object(objectId);
  console.debug("[SCUMM_CMD] clickObject", objectId);
  return true;
};

/**
 * Execute a complete sentence: verb + object(s).
 * This is a convenience wrapper that clicks the verb, then the object(s).
 *
 * @param {Object} options
 * @param {number} options.verb - Verb ID to use
 * @param {number} [options.objectA] - First object ID (optional)
 * @param {number} [options.objectB] - Second object ID (optional, for two-object verbs)
 * @returns {boolean} - true if commands were sent
 *
 * Note: This queues the actions but doesn't wait for them to complete.
 * Use the snapshot's ego.walking and sentence fields to track progress.
 */
window.__scummDoSentence = function doSentence({ verb, objectA, objectB }) {
  if (!window.__scummActionsReady()) {
    console.warn("[SCUMM_BRIDGE] Module not ready for doSentence");
    return false;
  }

  // Click the verb first
  Module._agent_click_verb(verb);

  // Click first object if provided (with slight delay to let verb register)
  if (objectA && Module._agent_click_object) {
    setTimeout(() => Module._agent_click_object(objectA), 50);
  }

  // Click second object if provided (for USE x WITH y)
  if (objectB && Module._agent_click_object) {
    setTimeout(() => Module._agent_click_object(objectB), 100);
  }

  console.debug("[SCUMM_CMD] doSentence", { verb, objectA, objectB });
  return true;
};

/**
 * Check if the action API is available (Module loaded with agent functions).
 * @returns {boolean}
 */
window.__scummActionsReady = function actionsReady() {
  return (
    typeof Module !== "undefined" &&
    typeof Module._agent_click_verb === "function" &&
    typeof Module._agent_click_at === "function" &&
    typeof Module._agent_walk_to === "function" &&
    typeof Module._agent_click_object === "function"
  );
};

// In the absence of a fork build we still want the page to be useful
// for development. Mirror any initial JSON in #scumm-state into
// window.__scummState so overlay/panel/tests have something to chew on.
(function hydrateFromDom() {
  const node = document.getElementById("scumm-state");
  if (!node) return;
  try {
    const initial = JSON.parse(node.textContent || "{}");
    if (initial && typeof initial === "object") {
      window.__scummState = initial;
    }
  } catch (_e) {}
})();
