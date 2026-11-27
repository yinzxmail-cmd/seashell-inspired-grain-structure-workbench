const assert = require("node:assert/strict");
const { test } = require("node:test");

const a = { points: [[0, 0], [2, 0], [2, 3], [0, 3]], angle: 30, group: 1, slot: "a" };
const b = { points: [[2, 0], [4, 0], [4, 3], [2, 3]], angle: 90, group: 2, slot: "b" };
const model = { width: 4, height: 3, grids: [[a, b], [a, b]] };
const settings = { filament: 1.75, hotend: 210, bed: 60, bedX: 200, bedY: 200, bedZ: 200 };

test("adjacent grains receive independent boundary strokes with positive bead overlap", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const [left, right] = planGcodeLayer([a, b], 0.6);
  const edge = (cell, x) => cell.strokes.find(([p, q]) =>
    Math.abs(p[0] - x) < 1e-8 && Math.abs(q[0] - x) < 1e-8);
  assert.ok(edge(left, 2 - 0.6 * 0.38));
  assert.ok(edge(right, 2 + 0.6 * 0.38));
  assert.ok(edge(left, 0.3), "the exterior bead stays within the specimen");
});

test("G-code steps by half the width and lifts, travels, extrudes and retracts every stroke", async () => {
  const { exportGcode } = await import("../src/gcode.mjs");
  const code = exportGcode(model, 0.6, settings);
  assert.match(code, /\bM83\b/);
  assert.match(code, /; LAYER 1 .*Z=0\.3\b/);
  assert.match(code, /; LAYER 2 .*Z=0\.6\b/);
  const strokes = code.split("; STROKE\n").slice(1);
  assert.ok(strokes.length > 10);
  for (const stroke of strokes) {
    assert.match(stroke, /^G0 Z[\d.]+ F\d+\nG0 X[\d.]+ Y[\d.]+ F\d+\nG0 Z[\d.]+ F\d+\n(?:G1 E[\d.]+ F\d+\n)?G1 X[\d.]+ Y[\d.]+ E[\d.]+ F\d+\nG1 E-/);
    assert.equal((stroke.match(/^G1 X/gm) ?? []).length, 1);
  }
  assert.throws(() => exportGcode(model, 0.6, { ...settings, bedX: 2 }), /build volume/);
});

test("a nominal layer without printable strokes cannot silently create an air gap", async () => {
  const { exportGcode } = await import("../src/gcode.mjs");
  assert.throws(() => exportGcode({ ...model, grids: [[a, b], []] }, 0.6, settings), /Layer 2.*no full-width strokes/i);
});

test("G-code planning can stop after a grain without generating later grains' strokes", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  let plannedLaterGrain = false;
  const later = { ...b, get angle() { plannedLaterGrain = true; return b.angle; } };
  for (const { cell } of planGcodeLayer([a, later], 0.6)) {
    assert.equal(cell, a);
    break;
  }
  assert.equal(plannedLaterGrain, false);
});
