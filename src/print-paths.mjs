const EPS = 1e-9;
const MAX_TRACKS = 90000;
const MAX_DASHES = 360000;
const strandGap = width => width * 0.1;
const angles = new Map([30, 90, 150].map(angle => {
  const rad = angle * Math.PI / 180;
  return [angle, [Math.cos(rad), -Math.sin(rad)]];
}));

export function lineSpan(polygon, offset) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [x, y] = polygon[i], [nextX, nextY] = polygon[(i + 1) % polygon.length];
    if (Math.abs(y - offset) < EPS) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    if ((y < offset && offset < nextY) || (nextY < offset && offset < y)) {
      const cross = x + (nextX - x) * (offset - y) / (nextY - y);
      min = Math.min(min, cross);
      max = Math.max(max, cross);
    }
  }
  return [min, max];
}

export function insetGrain(polygon, margin) {
  let inset = polygon;
  for (let i = 0; i < polygon.length && inset.length; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length];
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < EPS) continue;
    const insetDistance = Array.isArray(margin) ? margin[i] : margin;
    const distance = ([x, y]) => (dx * (y - ay) - dy * (x - ax)) / length - insetDistance;
    const clipped = [];
    let before = inset.at(-1), prev = distance(before);
    for (const point of inset) {
      const next = distance(point);
      if ((prev >= 0) !== (next >= 0)) {
        const t = prev / (prev - next);
        clipped.push([before[0] + t * (point[0] - before[0]), before[1] + t * (point[1] - before[1])]);
      }
      if (next >= 0) clipped.push(point);
      before = point;
      prev = next;
    }
    inset = clipped;
  }
  return inset;
}

function bestTracks(polygon, width, gap) {
  if (!polygon.length) return [];
  const offsets = polygon.map(point => point[1]);
  const min = Math.min(...offsets), span = Math.max(...offsets) - min;
  if (span < width - EPS) return [];
  const radius = width / 2;
  const available = Math.max(0, span - width);
  const pitch = width + gap;
  const count = Math.floor((available + EPS) / pitch) + 1;
  let best = [], area = 0;
  // Test centered and shifted rows, including one fewer row where clipping would
  // leave very short runs at both ends of the available cross section.
  for (let rows = count; rows >= Math.max(1, count - 1); rows--) {
    const slack = Math.max(0, available - (rows - 1) * pitch);
    const phases = slack < EPS ? [0.5] : [0.5, 0.25, 0.75, 0, 1];
    for (const phase of phases) {
      const tracks = [];
      let total = 0;
      for (let row = 0; row < rows; row++) {
        const offset = min + radius + slack * phase + row * pitch;
        const low = offset - radius, high = offset + radius;
        const [startLow, endLow] = lineSpan(polygon, low);
        const [startHigh, endHigh] = lineSpan(polygon, high);
        const lowRun = endLow - startLow, highRun = endHigh - startHigh;
        if (Math.min(lowRun, highRun) <= EPS) continue;
        // Chords between points inside a convex grain remain inside the grain.
        // Extruding between these ends keeps the entire transverse profile.
        tracks.push({ startLow, startHigh, endLow, endHigh, low, high });
        total += (lowRun + highRun) / 2 * width;
      }
      if (total > area + EPS) {
        best = tracks;
        area = total;
      }
    }
  }
  return best;
}

export function placeStrands(points, angle, width, edge, guideDensity = 1) {
  const radians = angle * Math.PI / 180;
  const [cos, sin] = angles.get(angle) ?? [Math.cos(radians), -Math.sin(radians)];
  const polygon = points.map(([x, y]) => [x * cos + y * sin, -x * sin + y * cos]);
  const world = (u, v) => [u * cos - v * sin, u * sin + v * cos];
  const offsets = polygon.map(point => point[1]);
  const min = Math.min(...offsets), span = Math.max(...offsets) - min;
  const gap = strandGap(width);
  // Each side of a shared grain boundary supplies half of the minimum gap.
  const tracks = bestTracks(insetGrain(polygon, gap / 2), width, gap);
  const rowSpacing = Math.min(edge * 0.38, Math.max(width * 0.58, edge * 0.22));
  const rows = guideDensity ? Math.max(1, Math.ceil(span * guideDensity / rowSpacing)) : 0;
  const dash = Math.min(edge * 0.19, Math.max(edge * 0.12, width * 0.55));
  const gaps = [];
  function addDashes(a, b, offset) {
    if (b - a < edge * 0.026) return;
    const count = Math.max(1, Math.ceil((b - a) * guideDensity / (dash * 1.8)));
    const step = (b - a) / count, half = Math.min(dash, step * 0.68) / 2;
    for (let i = 0; i < count; i++) {
      const center = a + (i + 0.5) * step;
      gaps.push([world(center - half, offset), world(center + half, offset)]);
    }
  }
  for (let row = 0; row < rows; row++) {
    const offset = min + span * (row + 0.5) / rows;
    const [start, end] = lineSpan(polygon, offset);
    const covered = [];
    for (const { low, high, startLow, startHigh, endLow, endHigh } of tracks) {
      if (offset < low - EPS || offset > high + EPS) continue;
      const t = Math.max(0, Math.min(1, (offset - low) / width));
      covered.push([startLow + (startHigh - startLow) * t, endLow + (endHigh - endLow) * t]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    let cursor = start;
    for (const [a, b] of covered) {
      addDashes(cursor, Math.min(end, a), offset);
      cursor = Math.max(cursor, b);
    }
    addDashes(cursor, end, offset);
  }
  return {
    tracks: tracks.map(({ startLow, startHigh, endLow, endHigh, low, high }) => ({
      angle,
      start: world((startLow + startHigh) / 2, (low + high) / 2),
      end: world((endLow + endHigh) / 2, (low + high) / 2),
      startFace: [world(startLow, low), world(startHigh, high)],
      endFace: [world(endLow, low), world(endHigh, high)],
    })),
    gaps,
  };
}

export function planPrint(model, width) {
  let trackCount = 0, dashCount = 0;
  const cellsTotal = model.grids.reduce((sum, cells) => sum + cells.length, 0);
  const guideDensity = Math.min(1, Math.sqrt(5000 / cellsTotal));
  const layers = [];
  for (const cells of model.grids) {
    const tracks = [], gaps = [];
    for (const { points, angle } of cells) {
      const grain = placeStrands(points, angle, width, model.edge, guideDensity);
      trackCount += grain.tracks.length;
      dashCount += grain.gaps.length;
      if (trackCount > MAX_TRACKS || dashCount > MAX_DASHES) return null;
      tracks.push(...grain.tracks);
      gaps.push(...grain.gaps);
    }
    layers.push({ tracks, gaps });
  }
  const height = width / 2;
  const gap = strandGap(width);
  const pitch = height;
  const stackHeight = height + (layers.length - 1) * pitch;
  if (!Number.isFinite(stackHeight)) return null;
  return { width, height, gap, pitch, stackHeight, layers };
}
