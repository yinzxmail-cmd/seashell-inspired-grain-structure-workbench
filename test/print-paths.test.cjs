const assert = require("node:assert/strict");
const { test } = require("node:test");

const planner = import("../src/print-paths.mjs");
const polygon = [[0, 0], [5, 0], [5, 3], [0, 3]];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${actual} is not near ${expected}`);

function inside([x, y], vertices) {
  return vertices.every(([ax, ay], i) => {
    const [bx, by] = vertices[(i + 1) % vertices.length];
    return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= -1e-8;
  });
}

test("full-width strands retain the three fixed printing angles within a clipped grain", async () => {
  const { placeStrands } = await planner;
  const clipped = [[0.1, 0.2], [4.8, 0.2], [4.8, 1.9], [2.1, 3], [0.1, 2]];
  const diameter = 0.6;
  for (const angle of [30, 90, 150]) {
    const { tracks, gaps } = placeStrands(clipped, angle, diameter, 2);
    assert.ok(tracks.length >= 3);
    assert.ok(gaps.length > 0);
    for (const { start, end, startFace, endFace } of tracks) {
      const dx = end[0] - start[0], dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      close(dx / length, Math.cos(angle * Math.PI / 180));
      close(dy / length, -Math.sin(angle * Math.PI / 180));
      for (const [a, b] of [startFace, endFace]) {
        assert.ok(inside(a, clipped) && inside(b, clipped));
        close((dx * (b[1] - a[1]) - dy * (b[0] - a[0])) / length, diameter);
      }
    }
    for (const [a, b] of gaps) {
      for (const t of [0.1, 0.5, 0.9]) {
        const point = a.map((n, i) => n + (b[i] - n) * t);
        for (const track of tracks) {
          const [a, b] = track.startFace, [c, d] = track.endFace;
          assert.ok(!inside(point, [a, c, d, b]), "gap marks stay outside the strand");
        }
      }
    }
  }
});

test("centers complete tracks in a grain and emits gaps where no full-width track fits", async () => {
  const { placeStrands } = await planner;
  const tracks = placeStrands(polygon, 90, 2, 2).tracks;
  assert.equal(tracks.length, 2);
  close(tracks[0].start[0], 1.4);
  close(tracks[1].start[0], 3.6);
  close(tracks[1].startFace[0][0] - tracks[0].startFace[1][0], 0.2);
  for (const track of tracks) {
    close(track.start[1], 2.9);
    close(track.end[1], 0.1);
  }
  const narrow = [[0, 0], [0.4, 0], [0.4, 3], [0, 3]];
  const { tracks: rejected, gaps } = placeStrands(narrow, 90, 0.6, 2);
  assert.equal(rejected.length, 0);
  assert.ok(gaps.length >= 2);
});

test("a narrow grain fits one full-width strand when both clearances fit", async () => {
  const { placeStrands } = await planner;
  const exact = [[0, 0], [0.66, 0], [0.66, 3], [0, 3]];
  const { tracks } = placeStrands(exact, 90, 0.6, 2);
  assert.equal(tracks.length, 1);
  close(tracks[0].start[0], 0.33);
  close(tracks[0].start[1], 2.97);
  close(tracks[0].end[1], 0.03);
  assert.equal(placeStrands([[0, 0], [0.6, 0], [0.6, 3], [0, 3]], 90, 0.6, 2).tracks.length, 0);
});

test("end faces follow a sloping boundary at a setback without narrowing the strand", async () => {
  const { placeStrands } = await planner;
  const wall = [[0, 0], [4.5, 0], [4.5, 1.75], [0, 4]];
  const { tracks } = placeStrands(wall, 90, 1, 2);
  assert.equal(tracks.length, 4);
  for (const { startFace: [a, b], endFace: [c, d] } of tracks) {
    close(b[0] - a[0], 1);
    close(a[1] + a[0] / 2, 4 - 0.05 * Math.sqrt(1.25));
    close(b[1] + b[0] / 2, 4 - 0.05 * Math.sqrt(1.25));
    close(c[1], 0.05);
    close(d[1], 0.05);
  }
});

test("strands stop short of a shared boundary and cannot touch end to end", async () => {
  const { placeStrands } = await planner;
  const above = polygon.map(([x, y]) => [x, y + 3]);
  const bottom = placeStrands(polygon, 90, 0.6, 2).tracks;
  const top = placeStrands(above, 90, 0.6, 2).tracks;
  assert.ok(bottom.length && top.length);
  close(Math.min(...top.map(track => track.end[1])) -
    Math.max(...bottom.map(track => track.start[1])), 0.06);
});

test("the rendered layers have a positive vertical gap between strand meshes", async () => {
  const { planPrint } = await planner;
  const { addPrintLayers, printShadowMaterial } = await import("../src/print-mesh.mjs");
  const { Group, LineBasicMaterial, MeshBasicMaterial } = await import("three");
  const group = new Group();
  const cells = [{ points: polygon, angle: 90 }];
  const model = { width: 5, height: 3, edge: 2, grids: [cells, cells] };
  const plan = planPrint(model, 0.6);
  const materials = { road: [new MeshBasicMaterial()], gap: [new LineBasicMaterial()], shadow: [printShadowMaterial()] };
  addPrintLayers(group, plan, model, 1, materials);
  const [top, bottom] = group.children.map(layer => layer.children[0]?.geometry);
  top.computeBoundingBox();
  bottom.computeBoundingBox();
  close(top.boundingBox.min.y - bottom.boundingBox.max.y, 0.06);
});
