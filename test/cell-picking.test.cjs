const assert = require("node:assert/strict");
const { test } = require("node:test");

const picker = import("../src/cell-picking.mjs");
const square = (id, x) => ({ id, points: [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]] });
const layers = [[square("top-left", 0), square("top-right", 1)], [square("lower", 0)]];
const stack = { top: 2, pitch: 1, thickness: 0.8, active: 0, isolated: false };

test("picks the closest cell and skips faded or isolated layers", async () => {
  const { pickCell } = await picker;
  const ray = { origin: { x: 0.5, y: 5, z: 0.5 }, direction: { x: 0, y: -1, z: 0 } };
  assert.equal(pickCell(layers, ray, stack)?.id, "top-left");
  assert.equal(pickCell(layers, ray, { ...stack, active: 1 })?.id, "lower");
  ray.origin.x = 1.5;
  assert.equal(pickCell(layers, ray, stack)?.id, "top-right");
  assert.equal(pickCell(layers, ray, { ...stack, active: 1, isolated: true }), null);
});

test("selects the front cell from a side view and ignores clicks outside the specimen", async () => {
  const { pickCell } = await picker;
  const ray = { origin: { x: 4, y: 1.6, z: 0.5 }, direction: { x: -1, y: 0, z: 0 } };
  assert.equal(pickCell(layers, ray, stack)?.id, "top-right");
  ray.origin.z = 2;
  assert.equal(pickCell(layers, ray, stack), null);
});
