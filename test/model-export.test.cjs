const assert = require("node:assert/strict");
const { test } = require("node:test");

const exporters = import("../src/model-export.mjs");
const model = { width: 4, height: 3 };
const track = { startFace: [[1, 0.8], [1, 1.4]], endFace: [[3, 0.8], [3, 1.4]] };
const plan = { width: 0.6, height: 0.36, pitch: 0.42, layers: [{ tracks: [track] }, { tracks: [track] }] };

test("binary STL has millimeter-scale closed strands with a real gap between layers", async () => {
  const { exportSTL } = await exporters;
  const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
  const data = await exportSTL(model, plan).arrayBuffer();
  const triangles = new DataView(data).getUint32(80, true);
  assert.equal(data.byteLength, 84 + triangles * 50);
  const geometry = new STLLoader().parse(data);
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  assert.ok(Math.abs(max.x - min.x - 2) < 1e-6);
  assert.ok(Math.abs(max.y - min.y - 0.6) < 1e-6);
  assert.ok(Math.abs(max.z - 0.78) < 1e-6);
  assert.equal(min.z, 0);
  const z = geometry.getAttribute("position").array.filter((_, i) => i % 3 === 2);
  assert.ok(z.every(height => height <= 0.360001 || height >= 0.419999));
});

test("3MF package contains a millimeter mesh with watertight outward-facing shells", async () => {
  const { export3MF } = await exporters;
  const { strFromU8, unzipSync } = await import("three/addons/libs/fflate.module.js");
  const zip = unzipSync(new Uint8Array(await export3MF(model, plan).arrayBuffer()));
  assert.deepEqual(Object.keys(zip).sort(), ["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
  assert.match(strFromU8(zip["_rels/.rels"]), /Target="\/3D\/3dmodel\.model"/);
  const xml = strFromU8(zip["3D/3dmodel.model"]);
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /<build><item objectid="1"\s*\//);
  const vertices = Array.from(xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g), entry => entry.slice(1).map(Number));
  const triangles = Array.from(xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g), entry => entry.slice(1).map(Number));
  assert.ok(vertices.length && triangles.length);
  const edges = new Map();
  const volumes = [0, 0];
  for (const [a, b, c] of triangles) {
    const [p, q, r] = [vertices[a], vertices[b], vertices[c]];
    const layer = p[2] > 0.4 ? 1 : 0;
    assert.ok([q, r].every(vertex => (vertex[2] > 0.4 ? 1 : 0) === layer));
    volumes[layer] += (p[0] * (q[1] * r[2] - q[2] * r[1]) +
      p[1] * (q[2] * r[0] - q[0] * r[2]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      const entry = edges.get(key) ?? [0, 0];
      entry[start < end ? 0 : 1]++;
      edges.set(key, entry);
    }
  }
  assert.ok(volumes.every(volume => volume > 0));
  assert.ok([...edges.values()].every(([one, other]) => one === 1 && other === 1));
});
