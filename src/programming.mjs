export function stackOffset(letter, edge) {
  if (letter === "β") return [-Math.sqrt(3) * edge / 2, -edge / 2];
  if (letter === "γ") return [0, -edge];
  return [0, 0];
}

// Axial columns and rows, with Cartesian positive Y pointing upwards.
export const lineDirections = { 0: [1, 0], 60: [1, -1], 90: [1, -2], 120: [0, -1] };

export function lineIndex(direction, q, r) {
  const [dq, dr] = lineDirections[direction];
  return dq * r - dr * q;
}

export function weaveFamily(first, second, q, r) {
  const [aq, ar] = lineDirections[first];
  const [bq, br] = lineDirections[second];
  const determinant = aq * br - ar * bq;
  const a = (q * br - r * bq) / determinant;
  const b = (aq * r - ar * q) / determinant;
  // For the perpendicular pair a and b can both be half-integers, yet their sum is integral.
  return Math.abs(Math.round(a + b) % 2) === 1 ? 0 : 1;
}
