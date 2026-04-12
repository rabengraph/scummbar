# Benchmark test — Enter the SCUMM Bar and talk to the Important-Looking Pirates

A focused test to validate that the agent can enter the SCUMM Bar from
the lookout area, find the "important-looking pirates", have a
conversation with them (picking 1–2 dialog choices), end the
conversation, and summarize what was said — all through the symbolic
API, with zero screenshots.

## Preconditions

- Game is running at `/game` with Monkey Island loaded.
- Agent is at the lookout point (room 33). This is the starting room
  after the intro cutscene finishes.
- `__scummActionsReady()` returns true.

## Room layout (what the agent needs to know)

Room 33 is the lookout/cliffside area. Its `roomObjects` include a
`"door"` (object id 428). Walking through that door takes you into the
SCUMM Bar, which is **room 28**.

Room 28 (SCUMM Bar) contains many objects. The key target is
`"important-looking pirates"` (object id 322). There are also
individual `"pirate"` objects, a `"dog"`, a `"curtain"`, a
`"fireplace"`, and two `"door"` objects.

## Test steps

### 1. Orient — read state, initialize event cursor

```js
const s = __scummRead();
let cursor = 0;
// Confirm: s.room === 33 (lookout)
// Note the roomObjects — look for the "door" object.
```

### 2. Enter the SCUMM Bar

The door in room 33 leads to the SCUMM Bar. Use `doSentence` with
the Walk To verb on the door object. The engine auto-walks Guybrush
to the door and triggers the room transition.

```js
const door = s.roomObjects.find(o => o.name === 'door');
const walkVerb = s.verbs.find(v => v.name.toLowerCase().includes('walk'));
__scummDoSentence({ verb: walkVerb.id, objectA: door.id });
```

Wait for a `roomEntered` event confirming arrival in room 28. This
may take several seconds as Guybrush walks across room 33.

```js
// Poll until room change:
const { events, cursor: next } = __scummEventsSince(cursor);
cursor = next;
// Look for: { kind: "roomEntered", payload: { to: 28 } }
```

**Note:** If `doSentence` walks Guybrush to the door but doesn't
trigger the transition, follow up with `__scummWalkTo` into the
door's bounding box center as a fallback.

### 3. Confirm you're in the SCUMM Bar

Read the new room state and verify:

```js
const s = __scummRead();
// s.room === 28
// s.roomObjects should contain { id: 322, name: "important-looking pirates" }
```

The `roomEntered` event for room 28 will list objects including
`"important-looking pirates"` (id 322), several `"pirate"` objects,
a `"dog"`, a `"curtain"`, and a `"fireplace"`.

### 4. Talk to the important-looking pirates

Use the "Talk to" verb on the important-looking pirates object:

```js
const talkVerb = s.verbs.find(v => v.name.toLowerCase().includes('talk'));
const pirates = s.roomObjects.find(o => o.name === 'important-looking pirates');
__scummDoSentence({ verb: talkVerb.id, objectA: pirates.id });
```

The engine auto-walks Guybrush to the pirates. After he arrives, a
cutscene begins — the lead pirate (talkingActor 3) will say something
like "What be ye wantin', boy?". This will arrive as a
`messageStateChanged` event with `label: "ending"` and `text` set.

**Important flow detail:** the first part of this conversation is a
cutscene (`inputLocked: true`, `cutsceneChanged: { inCutscene: true }`).
During the cutscene the agent cannot interact — just collect the dialog
lines. When the cutscene ends (`inputLocked: false`), dialog choices
will appear.

### 5. Navigate the dialog — pick 1–2 choices

Once input unlocks and dialog choices appear, read them:

```js
const s = __scummRead();
// s.dialogChoices[] — array of available dialog options with text
// Each has: { slot, id, name, visible, kind: 2 }
```

Alternatively watch for `dialogChoicesChanged` events, or poll
`__scummRead()` until `dialogChoices` is non-empty.

**Pick 1 or 2 choices total.** Don't exhaust every option — this test
is about proving the dialog mechanics work, not mapping the full tree.
Use `selectDialog`:

```js
__scummSelectDialog(0); // pick the first available choice
```

After selecting a choice:

1. **Collect dialog lines.** Watch for `messageStateChanged` events.
   Lines with `label: "ending"` contain the full text in `text` and
   the speaker in `talkingActor`. Actor 1 = Guybrush, actor 3 = the
   lead pirate, actor 255 = narrator / group voice.
2. **Advance through lines.** Use `__scummSkipMessage()` to dismiss
   each line. Do NOT use `clickAt` — it won't dismiss messages.
3. **Wait for the next choice round.** After the pirates respond, new
   dialog choices may appear. Read `dialogChoices[]` again.
4. **Pick a second choice if available**, or choose an exit option
   (e.g. "I'll just be running along now") to end the conversation.

### 6. Handle cutscene sequences

Parts of the conversation are scripted cutscenes. When `inputLocked`
is `true`, the agent should just collect `messageStateChanged` events
and wait. Don't try to `skipMessage` or `selectDialog` during a
cutscene — it won't work. Wait for `inputLockChanged: { locked: false }`
before acting.

The first conversation with the important-looking pirates includes a
long cutscene section where they explain "The Three Trials" (swordplay,
thievery, treasure hunting). During this part, just record the lines.

### 7. End the conversation

The conversation ends when:
- Guybrush says a farewell line ("I'll just be running along now")
- The pirate dismisses him ("Leave us to our grog")
- `inputLocked` goes back to `false` and `dialogChoices` is empty
- `haveMsg` returns to 0

Confirm the conversation is over by reading the state:

```js
const s = __scummRead();
// s.haveMsg === 0
// s.dialogChoices.length === 0
```

### 8. Summarize the conversation

Produce a summary that includes:

- **Who you talked to** — object name and how you identified them
  (e.g. "important-looking pirates", object id 322 in room 28)
- **Dialog choices you made** — which options you picked (by text)
  and in what order
- **Key dialog lines** — what the pirates said in response, attributed
  by talkingActor (actor 3 = lead pirate, actor 1 = Guybrush)
- **Information learned** — any quest hints, character names, or
  game mechanics revealed in the conversation

This summary is the primary output of the test.

## Expected conversation flow (from manual testing)

This is what a typical first conversation looks like, based on real
event logs. The agent doesn't need to follow this exactly — it's here
so the benchmark can be verified.

1. Guybrush approaches the pirates. Lead pirate (actor 3):
   *"What be ye wantin', boy?"*
2. Dialog choices appear (e.g. "I want to be a pirate",
   "I want to be a fireman", etc.)
3. If the agent picks "I want to be a pirate":
   - Pirate: *"So what?"* → *"Why bother us?"* → *"So?"*
   - Pirate explains the grog situation
   - Pirate: *"Do you have any special skills?"*
   - Guybrush: *"I can hold my breath for ten minutes!"*
   - Cutscene: pirates explain The Three Trials (swordplay, thievery,
     treasure hunting / "treasurehuntery")
   - Pirate: *"And then ye must drink grog with us!!"*
4. Conversation ends. Guybrush: *"I'll just be running along now."*
   Pirate: *"Leave us to our grog."*

If you talk to them again, the pirate says *"Well, if it isn't the
boy who wants to be a pirate. How do you fare on your quests?"* and
new dialog choices appear (e.g. about swordplay, thievery, treasure
hunting).

## Success criteria

- All steps completed with **zero screenshots**
- Agent entered the SCUMM Bar (room 28) from room 33
- Agent found the "important-looking pirates" via `roomObjects`
- Agent initiated a conversation using `doSentence` with Talk To verb
- Agent picked 1–2 dialog choices via `selectDialog` or `clickVerb`
- Agent collected dialog lines from `messageStateChanged` events,
  correctly attributing speakers by `talkingActor`
- Agent handled cutscene/inputLock periods by waiting
- Agent ended the conversation (or let it end naturally)
- Agent produced a coherent summary of the conversation content

## What this validates

| Capability | Method | Screenshot? |
|---|---|---|
| Room transition | `doSentence(Walk to, doorId)` + `roomEntered` event | No |
| Object discovery | `roomObjects[]` in new room | No |
| Starting a conversation | `doSentence` with Talk To verb + object id | No |
| Reading dialog choices | `dialogChoices[]` or `dialogChoicesChanged` | No |
| Selecting dialog options | `__scummSelectDialog(index)` | No |
| Reading dialog lines | `messageStateChanged` events with `text` + `talkingActor` | No |
| Advancing dialog | `__scummSkipMessage()` | No |
| Handling cutscenes | Detecting `inputLockChanged` / `cutsceneChanged` | No |
| Conversation comprehension | Summary output with attributed dialog | No |

## Notes for the agent

- `dialogChoices[]` is populated by the bridge (not the engine). It
  tracks which verbs are "baseline" (present at room entry) and
  classifies new verbs as dialog choices. Empty when no dialog active.
- `selectDialog(index)` is 0-indexed into `dialogChoices[]`. It
  dispatches the verb script directly by ID (no coordinate conversion
  needed). Returns false if no dialog is active or index out of range.
- Do NOT use `__scummClickVerb()` directly — use `selectDialog` for
  dialog choices. It handles validation and is the safe wrapper.
- Dialog lines arrive as `messageStateChanged` events. The `text`
  field has the line content, `talkingActor` tells you who said it.
  Actor 1 = Guybrush (ego), actor 3 = lead pirate, actor 255 =
  narrator or all pirates speaking together.
- Text may contain minor artifacts: `^` (line continuation), leading
  spaces, occasional encoding quirks. These are cosmetic — the content
  is readable.
- Call `__scummSkipMessage()` to dismiss each line. Do NOT use
  `clickAt` — it does not dismiss messages.
- During cutscenes (`inputLocked: true`), don't try to interact. Just
  collect the `messageStateChanged` events and wait for input to
  unlock.
- Door transitions usually work with a single
  `doSentence(Walk to, doorId)`. If the transition doesn't fire,
  follow up with `walkTo` into the door's bounding box as a fallback.
- The door in room 33 (object id 428, name "door") is the entrance to
  the SCUMM Bar. It's the only room transition needed for this test.
- The "important-looking pirates" are a single clickable room object
  (id 322), not individual actor entries. Use this object id with
  `doSentence`.
