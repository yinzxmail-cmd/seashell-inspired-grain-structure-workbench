import { insetGrain, lineSpan } from "./print-paths.mjs";

const STROKE_LIMIT = 250000;
const pointKey = point => point.map(value => Math.round(value * 1e6)).join(",");
const edgeKey = (a, b) => [pointKey(a), pointKey(b)].sort().join(":");

function shapeEdges(points) {
  return points.map((point, i) => [point, points[(i + 1) % points.length]]);
}

function grainInfill(points, angle, width) {
  if (points.length < 3) return [];
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = -Math.sin(radians);
  const local = points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
  const offsets = local.map(point => point[1]);
  const min = Math.min(...offsets), max = Math.max(...offsets);
  const count = Math.max(1, Math.ceil((max - min) / (width * 0.9)));
  const world = (u, v) => [u * cos - v * sin, u * sin + v * cos];
  const strokes = [];
  for (let i = 0; i < count; i++) {
    const offset = min + (max - min) * (i + 0.5) / count;
    const [start, end] = lineSpan(local, offset);
    if (end - start > 0.01) strokes.push([world(start, offset), world(end, offset)]);
  }
  return strokes;
}

export function* planGcodeLayer(cells, width) {
  const counts = new Map();
  const borders = cells.map(cell => shapeEdges(cell.points).map(([a, b]) => {
    const key = edgeKey(a, b);
    if (pointKey(a) !== pointKey(b)) counts.set(key, (counts.get(key) ?? 0) + 1);
    return key;
  }));
  for (const [i, cell] of cells.entries()) {
    const margins = borders[i].map(key => width * (counts.get(key) > 1 ? 0.38 : 0.5));
    const contour = insetGrain(cell.points, margins);
    if (contour.length < 3) {
      yield { cell, strokes: [] };
      continue;
    }
    const perimeter = shapeEdges(contour).filter(([a, b]) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01);
    const infill = insetGrain(cell.points, margins.map(distance => distance + width * 0.65));
    yield { cell, strokes: [...perimeter, ...grainInfill(infill, cell.angle, width)] };
  }
}

const format = value => Number(value.toFixed(5)).toString();

export function exportGcode(model, width, settings) {
  const { hotend, bed, filament, bedX, bedY, bedZ } = settings;
  if (![width, hotend, bed, filament, bedX, bedY, bedZ].every(Number.isFinite) ||
      width < 0.01 || filament < 1 || filament > 4 || hotend < 170 || hotend > 300 ||
      bed < 0 || bed > 120 || Math.min(bedX, bedY, bedZ) < 1) {
    throw Error("Check the filament diameter, temperatures, and printer build dimensions.");
  }
  const height = width / 2;
  const zHop = 0.3;
  const margin = 5;
  if (model.width + 2 * margin > bedX || model.height + 2 * margin > bedY ||
      model.grids.length * height + zHop > bedZ) throw Error("The specimen does not fit the configured build volume.");
  const extrusionArea = (width - height) * height + Math.PI * (height / 2) ** 2;
  const extrusionRatio = extrusionArea / (Math.PI * (filament / 2) ** 2);
  const extrusionSpeed = Math.max(1, Math.min(1500, Math.floor(180 / extrusionArea)));
  const xy = ([x, y]) => `X${format(x + margin)} Y${format(model.height - y + margin)}`;
  const code = ["; Grain Structure Workbench", "; Marlin-compatible, positive XY bed origin, single extruder",
    `; Width ${format(width)} mm; layer height ${format(height)} mm`,
    "G21", `M140 S${bed}`, "G28", "G90", "M83", "M200 D0", `M190 S${bed}`, `M109 S${hotend}`, "G92 E0"];
  let count = 0;
  for (let index = model.grids.length - 1; index >= 0; index--) {
    const layer = model.grids.length - index;
    const z = layer * height;
    const previousCount = count;
    code.push(`; LAYER ${layer} model-layer=${index + 1} Z=${format(z)}`);
    for (const { cell, strokes } of planGcodeLayer(model.grids[index], width)) {
      if (strokes.length === 0) continue;
      code.push(`; GRAIN group=${cell.group} slot=${cell.slot} angle=${cell.angle}`);
      for (const [a, b] of strokes) {
        if (count >= STROKE_LIMIT) throw Error("Too many G-code strokes. Reduce the specimen size or increase strand width.");
        const extrusion = Math.hypot(b[0] - a[0], b[1] - a[1]) * extrusionRatio;
        code.push("; STROKE", `G0 Z${format(z + zHop)} F600`, `G0 ${xy(a)} F4800`, `G0 Z${format(z)} F600`);
        if (count > 0) code.push("G1 E0.6 F1500");
        code.push(`G1 ${xy(b)} E${extrusion.toFixed(8)} F${extrusionSpeed}`, "G1 E-0.6 F1500");
        count++;
      }
    }
    if (count === previousCount) {
      throw Error(`Layer ${index + 1} has no full-width strokes. Restore grains on that layer or reduce the strand width.`);
    }
  }
  if (count === 0) throw Error("No full-width strokes fit. Reduce the strand width before exporting.");
  code.push(`G0 Z${format(model.grids.length * height + zHop)} F600`, "M400", "M104 S0", "M140 S0", "M107", "M84");
  return code.join("\n") + "\n";
}
