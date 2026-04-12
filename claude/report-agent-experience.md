# Agent experience report — Symbolic API playthrough

**Date:** 2026-04-12
**Session:** Benchmark test (poster) + freeplay exploration through Melee Island
**Rooms visited:** 33 (lookout) → 35 (town center) → 63 (map close-up) → 34 (Governor's mansion area) → 32 (dark alley)

## What works well

### `__scummRead()` — room and object discovery

This is excellent. Getting the full room state in one call — room number, ego position, all objects with IDs, names, bounding boxes, and `untouchable` flags — gives me everything I need to understand the scene without a screenshot. I could find the poster, identify the "Men of Low Moral Fiber (pirates)", spot the "deadly piranha poodles", and plan interactions purely from the object list.

The cleaned object names (no `@` padding) make string matching trivial. `roomObjects.find(o => o.name.includes('poster'))` just works.

### `__scummDoSentence()` — action execution

The atomic action API is the single biggest improvement over raw clicking. Passing `{ verb: 8, objectA: 429 }` to look at the poster is precise, unambiguous, and handles pathfinding automatically — ego walks to the object and executes the verb without me needing to coordinate walk-then-interact. The boolean return value (`true` = queued) gives immediate feedback.

Using this for "Walk to" (verb 11) with object IDs also works well for navigating between rooms — walking to the archway (id 451) took me from room 35 to room 34 cleanly.

### `__scummEventsSince()` — event stream

This is the API that made the benchmark test possible with zero screenshots. The key events I relied on:

- **`egoArrived`** — confirms ego reached a destination, gives exact coordinates
- **`messageStateChanged`** with `label: "started"` — delivers the full text of game messages, which eliminated the need for a screenshot entirely
- **`roomEntered`** — notifies of room transitions and lists objects in the new room

The cursor-based design is clean. Get a cursor, do an action, poll with that cursor, get only new events.

### `__scummActionsReady()` — initialization check

Simple and effective. One call confirms the bridge is live before doing anything else.

## What's missing or problematic

### Dialog trees have no API (biggest gap)

This was my single biggest friction point during gameplay. When I talked to the Men of Low Moral Fiber (pirates), the game presented five dialog choices:

1. "Hey, nice rat!"
2. "How can you stand to be near this vermin?"
3. "Do you know where I can find a treasure map around here?"
4. "Say, are you guys pirates?"
5. "I'll just be running along, now."

**I had no way to detect these through the symbolic API.** The `__scummRead()` state didn't surface dialog choices. The event stream didn't emit them. I had to take a screenshot, visually read the options, and click on pixel coordinates to select one.

This breaks the zero-screenshot promise of the symbolic API for any conversation-heavy gameplay — which is most of Monkey Island.

**What I'd want:**

1. **`dialogChoices` in `__scummRead()` or as an event** — an array of `{ index, text, verbId }` objects when the game is presenting dialog options
2. **`__scummSelectDialog(index)` or reuse `__scummDoSentence()`** — a way to pick a choice by index rather than clicking pixel coordinates
3. **Dialog lines in the event stream** — every line spoken (by any actor) should appear as a `messageStateChanged` event with the actor name/ID attached. Currently I got some NPC lines but the flow was unreliable. A conversation should produce a clean sequence like:
   ```
   dialogChoicesPresented: [{ index: 0, text: "Hey, nice rat!" }, ...]
   dialogChoiceSelected: { index: 3, text: "Say, are you guys pirates?" }
   messageStateChanged: { actor: "Guybrush", text: "Say, are you guys pirates?" }
   messageStateChanged: { actor: "Pirate", text: "No, we're a wandering circus troupe." }
   messageStateChanged: { actor: "Pirate", text: "But this rat scared away the elephant." }
   dialogChoicesPresented: [...]  // next round of choices
   ```

This would make conversational gameplay fully automatable through the symbolic API.

### Walking is slow with no fast-travel or speed control

Walking across the wide town room (480px, room 35) took 30+ seconds of real time. I spent more time waiting for Guybrush to walk than on any actual decision-making. For an agent that's paying per-API-call, this is expensive dead time.

**Options that would help:**

- A `__scummTeleport(x, y)` debug command (even if it's flagged as a cheat/debug tool)
- A game speed multiplier while ego is walking
- Or at minimum, an `egoWalking` event so I know to set a longer wait instead of polling repeatedly

### Event cursor inconsistency

I ran into confusion with the event cursor. At one point `__scummEventsSince(0)` returned a cursor of `1000015`, but later `__scummEventsSince(0)` returned `449`. The two cursor spaces seem to represent different things (possibly raw sequence numbers vs. wrapped offsets). I never fully understood the cursor semantics, which led to getting stale/duplicate messages mixed in with fresh ones.

**Suggestion:** Document the cursor contract clearly — is it monotonically increasing? Does it reset? What's the difference between the 400-range and 1000000-range cursors?

### No actor list for the current room

`__scummRead()` returns `roomObjects` but I couldn't reliably get a list of actors (NPCs) in the current room. When I tried to access `s.actors`, it came back undefined or empty. Knowing "there's a pirate captain NPC at position (120, 90) named 'Captain Smirk'" would help me decide who to talk to without a screenshot.

### `messageStateChanged` text encoding

The text field has formatting artifacts: `�` characters (likely encoding issues), backtick delimiters around sub-strings, and `^` as line-continuation markers. For example:

```
"Re-elect Governor Marley.�`When there's only one candidate, there's only one choice.`"
```

This is parseable but messy. A cleaned `plainText` field alongside the raw text would be nice.

### No room name or description

`__scummRead()` gives me `room: 35` but not "Melee Island Town Center." I had to infer room identities from context (object names like "Governor's mansion" or "Men of Low Moral Fiber"). A `roomName` field would help with orientation and logging.

## Summary scorecard

| Capability | Status | Notes |
|---|---|---|
| Room/object discovery | **Great** | Complete, reliable, clean names |
| Action execution | **Great** | Atomic, auto-walks, boolean feedback |
| Event stream (non-dialog) | **Great** | Text delivery, arrival detection, room changes |
| Game text reading | **Great** | `messageStateChanged.text` eliminates screenshots |
| Dialog tree interaction | **Missing** | No detection, no selection API, forced screenshots |
| Actor discovery | **Weak** | No reliable actor list for current room |
| Navigation efficiency | **Slow** | No speed control, long waits for walking |
| Event cursor semantics | **Confusing** | Dual cursor ranges, unclear contract |
| Text encoding | **Messy** | Artifacts in message text (`�`, backticks, `^`) |
| Room identification | **Missing** | No room name, only numeric ID |

## Priority recommendation

**Ship dialog tree support first.** Monkey Island is a dialog-driven game. Without it, the agent falls back to screenshots + pixel clicking for every conversation, which undermines the entire symbolic API approach. The three pieces needed:

1. Emit `dialogChoicesPresented` events with choice text and indices
2. Provide `__scummSelectDialog(index)` (or accept dialog selection via `doSentence`)
3. Emit each dialog line as a `messageStateChanged` event with actor attribution
