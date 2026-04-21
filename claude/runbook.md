# Claude runbook — ScummBench

You are an AI agent operating the ScummVM browser harness.

## Mission

Open `/briefing`, read the brief, navigate to `/game`, and make progress
in the adventure game running there.

## Inspection order (do this every time)

1. Open `/briefing`. Read the visible brief.
2. Parse `document.getElementById("agent-brief").textContent` as JSON.
   This is the canonical machine-readable brief.
3. Navigate to `/game`.
4. Read `window.__scummState`. This is the authoritative latest state.
5. If `window.__scummState` is missing, read
   `document.getElementById("scumm-state").textContent` and parse it
   as JSON.
6. Scan recent console entries for tags:
   - `[SCUMM_STATE]` — full snapshots
   - `[SCUMM_EVENT]` — discrete events (room change, hover change,
     inventory change, sentence change, ego moved)
7. Only then look at the rendered canvas for visual confirmation.

## Action policy

- **Prefer symbolic state first.** The whole point of this harness is
  that you don't have to guess from pixels.
- **Use visual confirmation second.** Pixels are the reality check,
  not the first signal.
- **If telemetry and visuals disagree, trust the rendered game.**
  Report the discrepancy so the fork can be fixed.
- **Save frequently.** Before any risky action, save.
- **Avoid repeating failed action loops.** If the same click or verb
  combination fails twice, change approach rather than retrying a
  third time.

## Action API

Always check `__scummActionsReady()` before sending commands.

### Primary actions

| Function | Purpose |
|---|---|
| `__scummDoSentence({verb, objectA, objectB})` | **Preferred.** Execute a complete verb+object action atomically. Queues directly into the engine's sentence stack — no timing races. |
| `__scummSkipMessage()` | Dismiss the current message/dialog text. Use to advance through conversations. `clickAt` does NOT dismiss messages. |
| `__scummSelectDialog(index)` | Pick a dialog choice by 0-based index into `dialogChoices[]`. Dispatches the verb script directly by ID (no coordinate conversion). Returns false if no dialog is active or index is out of range. |
| `__scummWalkTo(x, y)` | Walk ego to room coordinates. |
| `__scummClickObject(objectId)` | Click an object by ID (engine resolves position). |
| `__scummClickAt(x, y)` | Click at room coordinates. Last resort — prefer `doSentence` or `clickObject`. |
| `__scummClickVerb(verbId)` | **DEPRECATED.** Can corrupt the verb UI. Use `selectDialog`, `doSentence`, or `clickAt` instead. |

### How to perform common actions

**Look at / Pick up / Use an object:**
```js
// Use doSentence — it's atomic and reliable.
__scummDoSentence({ verb: 8, objectA: 429 })  // Look at poster
__scummDoSentence({ verb: 9, objectA: 215 })  // Pick up meat
__scummDoSentence({ verb: 7, objectA: 215, objectB: 310 })  // Use meat with stew
```

**Read and dismiss dialog text:**
```js
// When haveMsg == 255, a message is on screen. Read it from msgText:
const s = __scummRead();
if (s.haveMsg === 255) {
  console.log(s.msgText);        // e.g. "Re-elect Governor Marley."
  console.log(s.talkingActor);   // which actor is speaking (-1 if narration)
  __scummSkipMessage();          // dismiss it to advance
}
// Or use the event stream — messageStateChanged events include the text:
// { label: "started", text: "Re-elect Governor Marley.", talkingActor: 3 }
```

**Select a dialog choice:**
```js
// Dialog choices appear in __scummState.dialogChoices when a conversation
// is active. The bridge detects them automatically by tracking which
// verbs are new (not part of the room's baseline verb set).
__scummSelectDialog(0)  // pick first dialog choice (0-indexed)
// selectDialog dispatches the verb script directly by ID — no coordinate
// conversion needed. Do NOT use clickVerb directly — selectDialog is the
// safe wrapper that reads dialogChoices and handles validation.
```

**Navigate through a door / room exit:**
```js
// Use doSentence with Walk To on the door — the engine auto-walks
// ego to the door and usually triggers the room transition.
const door = s.roomObjects.find(o => o.name === 'door');
__scummDoSentence({ verb: walkVerbId, objectA: door.id });
// Wait for a roomEntered event to confirm the transition.
// If the transition doesn't fire, follow up with walkTo into
// the door's bounding box as a fallback:
// __scummWalkTo(door.box.x + door.box.w/2, door.box.y + door.box.h/2);
```

**Walk to a position:**
```js
__scummWalkTo(160, 130)
// Poll ego.walking until false, or wait for an egoArrived event.
```

## Event log stream

Instead of polling `__scummState` repeatedly, use the cursor-based
event log to react to changes efficiently.

### Reading events incrementally

```js
// Initialize cursor once
let cursor = 0;

// Catch up on everything that happened since last check
const { events, cursor: next } = __scummEventsSince(cursor);
cursor = next;

// Process new events
for (const ev of events) {
  console.log(ev.kind, ev.payload);
}
```

### Event kinds

All event kinds are strings. Engine events and bridge events share the
same `seq` space and the same format.

**Engine events** (from the C++ fork):

| `kind` | Payload |
|---|---|
| `"roomChanged"` | `{ from, to, resource }` |
| `"hoverChanged"` | `{ objectId, objectName, verbId }` |
| `"inventoryChanged"` | `{ count }` |
| `"sentenceChanged"` | `{ verb, objectA, objectB, active }` |
| `"egoMoved"` | `{ room, x, y, walking }` — only on room change or walk-stop |

**Bridge events** (derived in JS, have `source: "bridge"`):

| `kind` | Payload |
|---|---|
| `"messageStateChanged"` | `{ from, to, label, text?, talkingActor? }` — label is `"started"`, `"ending"`, or `"cleared"`. `text` is the message string (when available). |
| `"dialogChoicesChanged"` | `{ choices: [{verbId, name, slot, box}], count }` |
| `"roomEntered"` | `{ from, to, objects: [{id, name}] }` |
| `"inputLockChanged"` | `{ locked }` |
| `"cutsceneChanged"` | `{ inCutscene }` |
| `"egoArrived"` | `{ x, y, room }` |

### Other read helpers

| Function | Returns |
|---|---|
| `__scummRead()` | Latest snapshot (same as `window.__scummState`) |
| `__scummHistory()` | Array of last 64 snapshots |
| `__scummEvents()` | Array of last 256 events (all types) |
| `__scummEventsSince(seq)` | `{ events, cursor }` — only events newer than `seq` |

## Navigation strategy

Walking in SCUMM games uses a walkbox system — the room floor is
divided into convex quadrilateral zones. The engine's pathfinder
handles multi-box routes automatically, so **a single `__scummWalkTo(x, y)`
to a far-away target usually works.** You do NOT need to step through
walkboxes manually.

### Recommended approach

1. **Walk directly to the object.** Use the object's bounding box
   center from `roomObjects[]`: target `x = box.x + box.w/2`,
   `y = box.y + box.h` (bottom-center, since characters stand at
   floor level).

2. **Wait for arrival.** After calling `__scummWalkTo()`, poll
   `ego.walking` or wait for an `egoArrived` event. Do not send
   more commands while walking.

3. **If ego stops short** (arrives but isn't close enough to the
   object to interact), this usually means the walkbox near the
   object is offset from it. Try walking to the object's `box.x`
   with a `y` value closer to the ego's current `y` (stay on the
   same walkbox row). Objects near walls/edges often need you to
   stand slightly away from them.

4. **For room exits / doors:** walk to the door object's coordinates.
   Room transitions trigger automatically when ego reaches the exit
   walkbox. Confirm with a `roomChanged` or `roomEntered` event.

5. **Do NOT try to parse `walkBoxes[]` for pathfinding.** The engine
   does that internally. Use walkboxes only to understand why ego
   stopped at an unexpected position (check if the target was inside
   a locked or invisible box).

### Action-at-a-distance

You don't need to walk to an object before interacting with it.
`__scummDoSentence()` will cause ego to walk to the object
automatically as part of executing the action. The engine handles
the walk + interact sequence. Just issue the sentence and wait for
the result.

## State schema you can expect (v1)

The canonical definition lives in the fork's
`engines/scumm/AGENT_HARNESS.md` §4. Abbreviated here:

```jsonc
{
  "schema": 1,
  "seq": 1234,                 // monotonic across snapshots + events
  "t": 71234567,               // engine millis

  "gameId": 12, "gameVersion": 5, "gameName": "monkey",

  "room": 10, "roomResource": 10,
  "roomWidth": 320, "roomHeight": 200,   // virtual-screen coords
  "camera": { "x": 160 },               // viewport center; for scrolling rooms x > 160

  "ego": {
    "id": 1, "room": 10,
    "pos": { "x": 160, "y": 120 },
    "facing": 270, "walking": false, "costume": 93
  },

  "hover": {
    "objectId": 42, "objectName": "door",
    "verbId": 3,
    "mouse": { "x": 160, "y": 120 }
  },

  "sentence": {
    "verb": 3, "preposition": 2,
    "objectA": 42, "objectB": 0, "active": true
  },

  "roomObjects": [
    { "id": 42, "name": "door",
      "box": { "x": 120, "y": 80, "w": 40, "h": 80 },
      "state": 0, "owner": 0, "inInventory": false, "untouchable": false }
  ],

  "inventory": [
    { "id": 7, "name": "rubber chicken...",
      "box": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "state": 0, "owner": 1, "inInventory": true, "untouchable": false }
  ],

  "actors": [
    { "id": 3, "name": "Captain Smirk",
      "room": 10, "pos": { "x": 120, "y": 90 },
      "facing": 90, "walking": false, "costume": 12 }
  ],

  "verbs": [
    { "slot": 1, "id": 100, "name": "Open",
      "box": { "x": 0, "y": 144, "w": 40, "h": 8 },
      "visible": true, "kind": 0 }
  ],

  "dialogChoices": [
    { "slot": 5, "id": 201, "name": "Tell me about the governor.",
      "box": { "x": 0, "y": 80, "w": 200, "h": 8 },
      "visible": true, "kind": 2 }
  ]
}
```

### Reading the schema

- `roomObjects` is only the current room's objects. Picked-up items
  move to `inventory`.
- **Coordinates are in virtual-screen pixels** (`roomWidth × roomHeight`),
  not canvas pixels. The overlay does the scaling for you; if you
  need to reason about positions, stay in virtual space.
- `camera.x` is the viewport center. In non-scrolling rooms it's 160
  (half of 320). In scrolling rooms (roomWidth > 320) it shifts as the
  camera pans. Verb bounding boxes are in screen space; `selectDialog`
  handles the conversion automatically.
- `hover.objectId == 0` means the mouse is not over an object.
- `sentence.active == false` means no sentence is queued; the
  `verb/objectA/objectB` fields may still be populated from the
  previous action.
- There is **no pre-formatted sentence line string.** The state panel
  synthesizes one from `sentence` + `verbs` + object names. If you
  need to show the current action, either read the panel or do the
  same synthesis yourself.
- `untouchable == true` means not clickable. The overlay styles these
  differently from clickable ones.
- `actors` lists NPCs in the current room (excluding ego). Each has
  id, name, pos, facing, walking, costume. Actors with no costume
  (inactive/invisible) are filtered out.
- `dialogChoices` is a convenience subset of `verbs` — only visible
  verbs with `kind == 2` (dialog options during conversations). Use
  `__scummSelectDialog(index)` to pick one by 0-based index.
- `schema == 1` today. If `schema > 1`, the bridge logs a warning and
  you may be running against a newer fork than the harness understands.

### Events

See the "Event log stream" section above for the full event reference
and the cursor-based `__scummEventsSince(seq)` API.

## Debug aids

On `/game`:

- `#scumm-overlay` — bounding boxes and labels drawn over the canvas.
  Use this to visually confirm that exported objects match what's on
  screen. Boxes are best-effort; do not treat them as pixel-perfect
  hit tests.
- `#scumm-panel` — compact state panel showing schema, seq, game,
  room, ego, synthesized sentence line, hover, verbs, inventory,
  roomObjects.

On `/status`:

- Latest snapshot and recent events from the most recent `/game`
  session in the same tab (via `sessionStorage`).

### Dev aid: mock mode

`/game?mock=1` runs a fake adventure (3 rooms, verb table, inventory,
clickable objects) that emits the same v1 schema. Use it to validate
harness behavior when the real fork build isn't available. Mock
snapshots and events carry `"mock": true` so you can tell them apart.
From DevTools you can also drive the mock directly:

```js
window.__scummMock.goToRoom(2)
window.__scummMock.activateVerbBySlot(4)  // "Pick up"
window.__scummMock.clickObjectById(12)
```

## Debug policy when telemetry seems wrong

1. Inspect the overlay — is the box aligned with the rendered object?
2. Inspect `#scumm-state` raw JSON.
3. Cross-reference against the schema above.
4. Compare with the rendered scene.
5. If the discrepancy is reproducible, note it clearly so the
   `scummvm-agent` fork can be patched.

## What you should not do

- Don't invent routes. There's `/briefing`, `/game`, and optionally `/status`. (`/` redirects to `/briefing`.)
- Don't expect auth. There isn't any.
- Don't commit or upload game assets.
- Don't try to "fix" the fork from the harness repo; that's a
  separate repo.
- Don't optimize for human UX. This site is built for you.

## Operator notes

- The harness is static HTML/JS/CSS plus the Emscripten bundle.
- The ScummVM runtime is expected under `/public/scummvm/scummvm.js`
  and is produced by `./scripts/build-scummvm.sh` from the `scummvm`
  fork's `develop` branch.
- If `/game` shows a "runtime not built" banner, the operator needs
  to build the fork — or run `/game?mock=1` to use fake telemetry.
