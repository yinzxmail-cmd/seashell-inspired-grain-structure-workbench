const assert = require("node:assert/strict");
const { test } = require("node:test");

test("the three stacking positions are different cosets with cyclic center-to-vertex alignment", async () => {
  const { stackOffset } = await import("../src/programming.mjs");
  const edge = 2;
  const h = Math.sqrt(3) * edge / 2;
  const close = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]) < 1e-8;
  assert.deepEqual(stackOffset("α",edge),[0,0]);
  for (const [upper,lower,side] of [["α","β",1],["β","γ",-1],["γ","α",1]]) {
    const u = stackOffset(upper,edge), l = stackOffset(lower,edge);
    const candidates = [];
    for (let q=-2;q<=2;q++) for (let r=-2;r<=2;r++) {
      candidates.push([u[0]-l[0]+2*h*q+h*r,u[1]-l[1]+1.5*edge*r]);
    }
    assert.ok(candidates.some(point => close(point,[side*h,edge/2])));
    assert.ok(!candidates.some(point => close(point,[0,0])));
  }
});

test("line family indices follow lattice axes and weaving uses parity for every direction pair", async () => {
  const { lineIndex, weaveFamily, lineDirections } = await import("../src/programming.mjs");
  for (const [angle,[q,r]] of Object.entries(lineDirections)) {
    assert.equal(lineIndex(+angle,q*4,r*4),0);
    assert.notEqual(lineIndex(+angle,q+r,r-q),0);
  }
  const directions=Object.keys(lineDirections).map(Number);
  for (const first of directions) for (const second of directions) {
    if(first===second) continue;
    assert.equal(weaveFamily(first,second,0,0),1);
    const [q,r]=lineDirections[first];
    const [s,t]=lineDirections[second];
    assert.equal(weaveFamily(first,second,q,r),0);
    assert.equal(weaveFamily(first,second,s,t),0);
    assert.equal(weaveFamily(first,second,q+s,r+t),1);
  }
});
