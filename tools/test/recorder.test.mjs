// Tests for the __scummRecord* API in web/shared/bridge.js.
//
// Uses Node's built-in test runner (no dependencies) so this runs in CI
// with just `node --test`. Written in describe/it style so it ports
// cleanly to vitest when we migrate.
//
// Bridge.js is a plain script (not a module) that mutates `window`, so
// we load it into a stubbed vm context and drive the recorder by
// publishing snapshots and manually invoking the stubbed setInterval
// callback — deterministic, no real timers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const BRIDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/shared/bridge.js"
);
const SRC = readFileSync(BRIDGE_PATH, "utf8");

function loadBridge() {
  let scheduledFn = null;
  const win = { dispatchEvent: () => {} };
  const ctx = {
    window: win,
    document: { getElementById: () => null },
    console: { debug: () => {}, warn: () => {}, log: () => {} },
    CustomEvent: class { constructor() {} },
    setInterval: (fn) => { scheduledFn = fn; return 1; },
    clearInterval: () => { scheduledFn = null; },
    sessionStorage: { setItem: () => {} },
    Date,
  };
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    win,
    tick: () => { if (scheduledFn) scheduledFn(); },
    isScheduled: () => scheduledFn !== null,
  };
}

// Objects coming out of the vm context have Array/Object prototypes from
// that context, which fail strict deepEqual against literals built here.
// Normalize through JSON before comparing.
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

describe("deep diff — scalars and nested objects", () => {
  it("records nothing when nothing meaningful changes", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 5 });
    tick();
    assert.equal(win.__scummRecordRead().total, 0);
  });

  it("ignores high-churn top-level keys (receivedAt, seq, t, tick, schema)", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 2, seq: 99, tick: 77, room: 5 });
    tick();
    assert.equal(win.__scummRecordRead().total, 0);
  });

  it("records a scalar change at the correct path", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 6 });
    tick();
    const { entries } = win.__scummRecordRead();
    assert.equal(entries.length, 1);
    assert.deepEqual(plain(entries[0].diff), [{ path: ["room"], from: 5, to: 6 }]);
  });

  it("records nested-object changes with a full path", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, ego: { pos: { x: 0, y: 0 } } });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, ego: { pos: { x: 5, y: 0 } } });
    tick();
    const { entries } = win.__scummRecordRead();
    assert.equal(entries.length, 1);
    assert.deepEqual(plain(entries[0].diff), [
      { path: ["ego", "pos", "x"], from: 0, to: 5 },
    ]);
  });
});

describe("id-keyed array diffing", () => {
  it("tracks a known object's motion by id, not index", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [{ id: 10, name: "bird", box: { x: 20, y: 30 } }],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [{ id: 10, name: "bird", box: { x: 40, y: 20 } }],
    });
    tick();
    const { entries } = win.__scummRecordRead();
    assert.equal(entries.length, 1);
    assert.deepEqual(plain(entries[0].diff), [
      { path: ["roomObjects", { id: 10 }, "box", "x"], from: 20, to: 40 },
      { path: ["roomObjects", { id: 10 }, "box", "y"], from: 30, to: 20 },
    ]);
  });

  it("does not generate false diffs when array is reordered", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [{ id: 10, name: "bird", box: { x: 20, y: 30 } }],
    });
    win.__scummRecordStart();
    tick();
    // New item inserted at the front — bird shifts from index 0 to 1,
    // but its fields are unchanged.
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [
        { id: 99, name: "log", box: { x: 5, y: 5 } },
        { id: 10, name: "bird", box: { x: 20, y: 30 } },
      ],
    });
    tick();
    const { entries } = win.__scummRecordRead();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].diff.length, 1);
    assert.equal(entries[0].diff[0].op, "add");
    assert.deepEqual(plain(entries[0].diff[0].path), ["roomObjects", { id: 99 }]);
    assert.equal(entries[0].diff[0].to.name, "log");
  });

  it("emits a remove op when an id-keyed item disappears", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [
        { id: 10, name: "bird" },
        { id: 99, name: "log" },
      ],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [{ id: 99, name: "log" }],
    });
    tick();
    const { entries } = win.__scummRecordRead();
    const removes = entries[0].diff.filter((d) => d.op === "remove");
    assert.equal(removes.length, 1);
    assert.deepEqual(plain(removes[0].path), ["roomObjects", { id: 10 }]);
    assert.equal(removes[0].from.name, "bird");
  });

  it("falls back to index-based diffing for unknown arrays", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, misc: [1, 2, 3] });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, misc: [1, 2, 9] });
    tick();
    const { entries } = win.__scummRecordRead();
    assert.deepEqual(plain(entries[0].diff), [
      { path: ["misc", 2], from: 3, to: 9 },
    ]);
  });
});

describe("summary collapses per-tick noise to net change", () => {
  it("drops oscillating paths by default (SCUMM animation frames)", () => {
    const { win, tick } = loadBridge();
    // Object 300 toggles state 0/1 every tick — classic animation.
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [{ id: 300, name: "torch", state: 0 }],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [{ id: 300, name: "torch", state: 1 }],
    });
    tick();
    win.__scummPublish({
      schema: 1, seq: 3,
      roomObjects: [{ id: 300, name: "torch", state: 0 }],
    });
    tick();
    const summary = win.__scummRecordSummary();
    assert.equal(summary.changes.length, 0);
    assert.equal(summary.filteredAnimationPaths, 1);
    // Raw log still has the flips for forensic use.
    assert.equal(win.__scummRecordRead().total, 2);
  });

  it("keeps monotonic change that never revisits a prior value", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [{ id: 10, name: "bird", box: { x: 20, y: 30 } }],
    });
    win.__scummRecordStart();
    tick();
    for (const x of [30, 45, 60]) {
      win.__scummPublish({
        schema: 1, seq: 1,
        roomObjects: [{ id: 10, name: "bird", box: { x, y: 30 } }],
      });
      tick();
    }
    const summary = win.__scummRecordSummary();
    assert.equal(summary.changes.length, 1);
    const c = summary.changes[0];
    assert.deepEqual(plain(c.path), ["roomObjects", { id: 10 }, "box", "x"]);
    assert.equal(c.from, 20);
    assert.equal(c.to, 60);
    assert.equal(c.ticks, 3);
    assert.equal(c.oscillated, false);
  });

  it("keeps real signal even when animation is also happening", () => {
    const { win, tick } = loadBridge();
    // One animating torch (oscillates) + one bird that actually moves.
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [
        { id: 300, name: "torch", state: 0 },
        { id: 10, name: "bird", box: { x: 20, y: 30 } },
      ],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [
        { id: 300, name: "torch", state: 1 },
        { id: 10, name: "bird", box: { x: 40, y: 30 } },
      ],
    });
    tick();
    win.__scummPublish({
      schema: 1, seq: 3,
      roomObjects: [
        { id: 300, name: "torch", state: 0 },
        { id: 10, name: "bird", box: { x: 60, y: 30 } },
      ],
    });
    tick();
    const summary = win.__scummRecordSummary();
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.filteredAnimationPaths, 1);
    assert.deepEqual(plain(summary.changes[0].path), [
      "roomObjects", { id: 10 }, "box", "x",
    ]);
  });

  it("includeAnimation:true surfaces the oscillating paths too", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [{ id: 300, name: "torch", state: 0 }],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [{ id: 300, name: "torch", state: 1 }],
    });
    tick();
    win.__scummPublish({
      schema: 1, seq: 3,
      roomObjects: [{ id: 300, name: "torch", state: 0 }],
    });
    tick();
    const summary = win.__scummRecordSummary({ includeAnimation: true });
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].oscillated, true);
    assert.equal(summary.changes[0].ticks, 2);
  });

  it("non-oscillating changes are sorted before oscillating ones", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({
      schema: 1, seq: 1,
      roomObjects: [
        { id: 10, name: "bird", box: { x: 20, y: 30 } },
        { id: 300, name: "torch", state: 0 },
      ],
    });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({
      schema: 1, seq: 2,
      roomObjects: [
        { id: 10, name: "bird", box: { x: 40, y: 30 } },
        { id: 300, name: "torch", state: 1 },
      ],
    });
    tick();
    win.__scummPublish({
      schema: 1, seq: 3,
      roomObjects: [
        { id: 10, name: "bird", box: { x: 60, y: 30 } },
        { id: 300, name: "torch", state: 0 },
      ],
    });
    tick();
    const summary = win.__scummRecordSummary({ includeAnimation: true });
    assert.equal(summary.changes[0].oscillated, false);
    assert.equal(summary.changes[1].oscillated, true);
  });
});

describe("recorder lifecycle", () => {
  it("start and stop toggle the running flag and the scheduled timer", () => {
    const { win, isScheduled } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    assert.equal(win.__scummRecordStatus().running, false);
    win.__scummRecordStart();
    assert.equal(win.__scummRecordStatus().running, true);
    assert.equal(isScheduled(), true);
    win.__scummRecordStop();
    assert.equal(win.__scummRecordStatus().running, false);
    assert.equal(isScheduled(), false);
  });

  it("clear empties the entry buffer", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 6 });
    tick();
    assert.equal(win.__scummRecordRead().total, 1);
    win.__scummRecordClear();
    assert.equal(win.__scummRecordRead().total, 0);
  });

  it("sinceIndex returns only entries at or after the cursor", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 6 });
    tick();
    win.__scummPublish({ schema: 1, seq: 3, room: 7 });
    tick();
    const first = win.__scummRecordRead();
    assert.equal(first.total, 2);
    assert.equal(first.entries.length, 2);
    const next = win.__scummRecordRead(first.nextIndex);
    assert.equal(next.entries.length, 0);
    assert.equal(next.nextIndex, 2);
  });

  it("entries are compact: {dt, diff} only, with startedAt on the response", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 6 });
    tick();
    const read = win.__scummRecordRead();
    assert.equal(typeof read.startedAt, "string");
    assert.match(read.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(read.entries.length, 1);
    const entry = read.entries[0];
    assert.equal(typeof entry.dt, "number");
    assert.ok(entry.dt >= 0);
    // No absolute timestamps in entries — they're derivable from startedAt + dt.
    assert.equal(entry.t, undefined);
    assert.equal(entry.ms, undefined);
    // Only dt and diff should be present.
    assert.deepEqual(Object.keys(entry).sort(), ["diff", "dt"]);
  });

  it("clamps intervalMs to the minimum", () => {
    const { win } = loadBridge();
    const info = win.__scummRecordStart({ intervalMs: 10 });
    assert.equal(info.intervalMs, 50);
  });

  it("preserves prior entries when started with clear:false", () => {
    const { win, tick } = loadBridge();
    win.__scummPublish({ schema: 1, seq: 1, room: 5 });
    win.__scummRecordStart();
    tick();
    win.__scummPublish({ schema: 1, seq: 2, room: 6 });
    tick();
    win.__scummRecordStop();
    assert.equal(win.__scummRecordRead().total, 1);
    win.__scummRecordStart({ clear: false });
    assert.equal(win.__scummRecordRead().total, 1);
  });
});
