const assert = require("node:assert/strict");
const { test } = require("node:test");

const a = { points: [[0, 0], [2, 0], [2, 3], [0, 3]], angle: 30, group: 1, slot: "a" };
const b = { points: [[2, 0], [4, 0], [4, 3], [2, 3]], angle: 90, group: 2, slot: "b" };
const model = { width: 4, height: 3, grids: [[a, b], [a, b]] };
const settings = { filament: 1.75, hotend: 210, bed: 60, bedX: 200, bedY: 200, bedZ: 200 };

test("adjacent grains overlap their original oriented strands with no perimeter strokes", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const { placeStrands } = await import("../src/print-paths.mjs");
  const [left, right] = planGcodeLayer([a, b], 0.6);
  for (const entry of [left, right]) {
    const { angle, points } = entry.cell;
    assert.equal(entry.tracks.length, placeStrands(points, angle, 0.6, 2).tracks.length);
    const [original] = planGcodeLayer([entry.cell],0.6);
    assert.deepEqual(entry.tracks.map(track=>track.volume),original.tracks.map(track=>track.volume));
    for (const track of entry.tracks) {
      assert.ok(Math.abs(track.angle-angle)<1e-7);
      assert.ok([...track.startFace,...track.endFace].every(([x,y]) => x>=-1e-7 && x<=4+1e-7 && y>=-1e-7 && y<=3+1e-7));
    }
  }
  assert.ok(left.tracks.some(first => right.tracks.some(second => beadOverlap(first,second))));
});

function beadOverlap(first,second){
  const footprint=track=>[track.startFace[0],track.endFace[0],track.endFace[1],track.startFace[1]];
  const polygons=[footprint(first),footprint(second)];
  return polygons.every(points=>points.every(([x,y],i)=>{
    const [nextX,nextY]=points[(i+1)%points.length];
    const projections=polygons.map(polygon=>polygon.map(([u,v])=>(nextY-y)*u-(nextX-x)*v));
    return Math.max(Math.min(...projections[0]),Math.min(...projections[1])) <
      Math.min(Math.max(...projections[0]),Math.max(...projections[1]))-1e-7;
  }));
}

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

test("one merged extrusion spans each aligned row across an adjacent equal-angle pair", async () => {
  const { exportGcode, planDeposits } = await import("../src/gcode.mjs");
  const specimen = { ...model, grids: [[{ ...a, angle: 0 }, { ...b, angle: 0 }]] };
  const baseline = planDeposits(specimen,0.6).layers[0].tracks;
  const merged = planDeposits({...specimen,merge:true},0.6).layers[0].tracks;
  assert.ok(merged.length > 1 && merged.length < baseline.length);
  assert.ok(merged.every(road => road.start[0] < 0.1 && road.end[0] > 3.9));
  const material = tracks => tracks.reduce((sum,road) => sum + road.volume,0);
  assert.ok(Math.abs(material(merged)-material(baseline))<1e-10);
  const code = exportGcode({...specimen,merge:true},0.6,settings);
  const extrusions = [...code.matchAll(/^G1 X([\d.]+) Y[\d.]+ E[\d.]+ F/gm)];
  assert.equal(extrusions.length,merged.length);
  assert.ok(extrusions.every(move => +move[1]>8.9));
});

test("G-code finishes each orientation group before changing angles within a layer", async () => {
  const { exportGcode } = await import("../src/gcode.mjs");
  const c = { ...a, group:3, points:a.points.map(([x,y])=>[x+4,y]) };
  const layer=[a,b,c];
  const code=exportGcode({...model,width:6,grids:[layer,layer]},0.6,settings);
  for (const block of code.split(/^; LAYER /m).slice(1)) {
    assert.deepEqual([...block.matchAll(/^; ORIENTATION angle=(\d+)/gm)].map(match=>+match[1]),[30,90]);
    assert.deepEqual([...block.matchAll(/^; GRAIN .* angle=(\d+)/gm)].map(match=>+match[1]),[30,30,90]);
  }
});

test("G-code planning can stop after a grain without generating later grains' strokes", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  let plannedLaterGrain = false;
  const later = { ...b, points:b.points.map(([x,y])=>[x+10,y]), get angle() { plannedLaterGrain = true; return b.angle; } };
  for (const { cell } of planGcodeLayer([a, b, later], 0.6)) {
    assert.equal(cell, a);
    break;
  }
  assert.equal(plannedLaterGrain, false);
});

test("the deposited preview uses the exact adjusted oriented strokes and bead widths", async () => {
  const { planDeposits, planGcodeLayer } = await import("../src/gcode.mjs");
  const plan = planDeposits(model, 0.6);
  assert.equal(plan.pitch, 0.3);
  const paths = [...planGcodeLayer([a, b], 0.6)].flatMap(entry => entry.tracks);
  assert.deepEqual(plan.layers[0].tracks, paths);
  for (const track of paths) {
    const length=Math.hypot(track.end[0]-track.start[0],track.end[1]-track.start[1]);
    const area=(track.width-0.3)*0.3+Math.PI*0.15**2;
    assert.ok(Math.abs(track.volume-length*area)<1e-7);
  }
});

test("0 and 180 degrees join, with preview colors changing at the original grain edge", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const left = { ...a, angle: 0, color: "#ffffff" };
  const right = { ...b, angle: 180, color: "#000000" };
  const merged=[...planGcodeLayer([left,right],0.6,true)];
  assert.equal(merged.length,1);
  const [{ tracks, joinedStrokes }]=merged;
  assert.ok(joinedStrokes>0);
  for(const track of tracks){
    const [white,black]=track.colorParts;
    assert.equal(track.angle,0);
    assert.deepEqual([white.color,black.color],[left.color,right.color]);
    assert.deepEqual(white.start,track.start);
    assert.deepEqual(black.end,track.end);
    assert.deepEqual(white.end,black.start);
    assert.equal(white.end[0],2);
  }
});

test("a parallel shared edge does not introduce off-angle connections", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const cells = [{ ...a, angle: 90 }, b];
  const before = [...planGcodeLayer(cells, 0.6)];
  const after = [...planGcodeLayer(cells, 0.6, true)];
  assert.equal(after.length,1);
  assert.equal(after[0].matchingEdges,1);
  assert.equal(after[0].joinedStrokes,0);
  assert.ok(after[0].tracks.every(track => Math.abs(track.end[0]-track.start[0]) < 1e-8));
  const volume=entries=>entries.flatMap(entry=>entry.tracks).reduce((total,track)=>total+track.volume,0);
  assert.ok(Math.abs(volume(after)-volume(before))<1e-8);
});

test("matching layers with staggered rows use common lanes across a shared edge", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const grains = [
    { ...a, angle:0 },
    { ...b, angle:0, points:[[2,0],[4,0],[4,2.43],[2,3]] },
  ];
  const before = [...planGcodeLayer(grains,0.6)];
  const after = [...planGcodeLayer(grains,0.6,true)];
  const matchingLanes = ([left,right]) => left.tracks.filter(one => right.tracks.some(other =>
    Math.abs(one.start[1]-other.start[1])<1e-6 && one.end[0]>2 && other.start[0]<2)).length;
  assert.equal(matchingLanes(before),0);
  assert.equal(after.length,1);
  const [{tracks, joinedStrokes}]=after;
  assert.ok(joinedStrokes>=2);
  assert.equal(tracks.filter(track=>track.start[0]<2&&track.end[0]>2).length,joinedStrokes);
  for(let i=1;i<tracks.length;i++){
    assert.ok(tracks[i].start[1]-tracks[i-1].start[1]>(tracks[i].width+tracks[i-1].width)/2);
  }
});

test("joined roads stay separated across a missing grain even within one connected region", async () => {
  const { planGcodeLayer } = await import("../src/gcode.mjs");
  const offset = (x, y) => ({ ...a, angle:0, points:a.points.map(([u,v])=>[u+x,v+y]) });
  const cells = [offset(0,0),offset(4,0),offset(0,3),offset(2,3),offset(4,3)];
  const [region,...others]=planGcodeLayer(cells,0.6,true);
  assert.equal(others.length,0);
  assert.ok(region.joinedStrokes>0);
  const bottom=region.tracks.filter(track=>track.start[1]<3);
  assert.ok(bottom.some(track=>track.start[0]<1));
  assert.ok(bottom.some(track=>track.end[0]>5));
  assert.ok(bottom.every(track=>track.end[0]<=2+1e-8||track.start[0]>=4-1e-8));
});
