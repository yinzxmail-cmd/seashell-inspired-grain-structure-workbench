const EPS = 1e-9;

function intersectFootprint(points, ray, near, far) {
  const { origin, direction } = ray;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length];
    const dx = bx - ax, dz = bz - az;
    const side = dx * (origin.z - az) - dz * (origin.x - ax);
    const speed = dx * direction.z - dz * direction.x;
    if (Math.abs(speed) < EPS) {
      if (side < -EPS) return Infinity;
      continue;
    }
    const crossing = -side / speed;
    if (speed > 0) near = Math.max(near, crossing);
    else far = Math.min(far, crossing);
    if (near > far + EPS) return Infinity;
  }
  return near;
}

export function pickCell(grids, ray, { top, pitch, thickness, active, isolated }) {
  let best = null, distance = Infinity;
  const last = isolated ? active : grids.length - 1;
  for (let index = active; index <= last; index++) {
    const ceiling = top - index * pitch, floor = ceiling - thickness;
    const y = ray.origin.y, dy = ray.direction.y;
    let near = 0, far = distance;
    if (Math.abs(dy) < EPS) {
      if (y < floor - EPS || y > ceiling + EPS) continue;
    } else {
      const a = (ceiling - y) / dy, b = (floor - y) / dy;
      near = Math.max(0, Math.min(a, b));
      far = Math.min(distance, Math.max(a, b));
      if (near > far + EPS) continue;
    }
    for (const cell of grids[index]) {
      const hit = intersectFootprint(cell.points, ray, near, Math.min(far, distance));
      if (hit < distance) {
        best = cell;
        distance = hit;
      }
    }
  }
  return best;
}
