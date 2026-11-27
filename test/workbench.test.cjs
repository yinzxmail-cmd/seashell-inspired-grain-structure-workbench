const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright");

const entry = process.env.GRAIN_TEST_ENTRY
  ? path.resolve(process.env.GRAIN_TEST_ENTRY)
  : path.resolve(__dirname, "../index.html");
const url = pathToFileURL(entry).href;
const viewport = { width: 1280, height: 800 };
let browser;

before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.GRAIN_TEST_CHROMIUM || undefined,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
});
after(async () => browser?.close());

async function openWorkbench(t, options = {}) {
  const { webglUnavailable = false, ...pageOptions } = options;
  const page = await browser.newPage({ viewport, acceptDownloads: true, ...pageOptions });
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(unavailable => {
    const proto = WebGL2RenderingContext.prototype;
    const getContext = HTMLCanvasElement.prototype.getContext;
    const create = proto.createBuffer;
    const remove = proto.deleteBuffer;
    const buffers = new WeakMap();
    window.gpu = {
      draws: 0,
      allocated: 0,
      liveBuffers: gl => buffers.get(gl)?.size ?? 0,
      unavailable,
      failNextDraw: false,
    };
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === "webgl2" && window.gpu.unavailable) return null;
      return getContext.call(this, type, ...args);
    };
    for (const name of ["drawElements", "drawElementsInstanced", "drawArrays"]) {
      const draw = proto[name];
      proto[name] = function (...args) {
        if (window.gpu.failNextDraw) {
          window.gpu.failNextDraw = false;
          throw Error("Injected draw failure");
        }
        window.gpu.draws++;
        return draw.apply(this, args);
      };
    }
    proto.createBuffer = function () {
      const buffer = create.call(this);
      if (!buffers.has(this)) buffers.set(this, new Set());
      if (buffer) {
        buffers.get(this).add(buffer);
        window.gpu.allocated++;
      }
      return buffer;
    };
    proto.deleteBuffer = function (buffer) {
      buffers.get(this)?.delete(buffer);
      return remove.call(this, buffer);
    };
  }, webglUnavailable);
  return page;
}

async function ready(page) {
  await page.locator('#interactive[data-status="ready"] canvas').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => window.gpu.draws > 0, null, { timeout: 5000 });
}

async function nextDraw(page, action) {
  const before = await page.evaluate(() => window.gpu.draws);
  await action();
  await page.waitForFunction(previous => window.gpu.draws > previous, before, { timeout: 10000 });
}

async function snapshot(page) {
  // GPU draw calls can be observed before Chromium presents the frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const { x, y, width, height } = await page.locator("#interactive canvas").boundingBox();
  const header = await page.locator(".viewer-head").boundingBox();
  const toolbar = await page.locator(".tools").boundingBox();
  const top = Math.max(y + 100, header.y + header.height + 12);
  const bottom = Math.min(y + height - 120, toolbar.y - 10);
  // Exclude the controls and the parameter panel from pixel comparisons.
  const pixels = await page.screenshot({ clip: { x: x + 25, y: top,
    width: width - 100, height: bottom - top } });
  return createHash("sha256").update(pixels).digest("hex");
}

async function download(page, id) {
  if (await page.locator("#exportMenu").getAttribute("open") === null) {
    await page.locator("#exportMenu summary").click();
  }
  const [result] = await Promise.all([page.waitForEvent("download"), page.locator(id).click()]);
  return fs.readFile(await result.path(), "utf8");
}

async function grainRows(page) {
  return (await download(page, "#csv")).split("\r\n").slice(1).map(row => {
    const [layer, sequence, layout, , group, style, slot, angle, x, y] = row.split(",");
    return { layer: +layer, sequence: +sequence, layout, group, style, slot, angle: +angle, x: +x, y: +y };
  });
}

function centerGroup(rows, layer) {
  const groups = new Map();
  for (const cell of rows.filter(cell => cell.layer === layer)) {
    if (!groups.has(cell.group)) groups.set(cell.group, []);
    groups.get(cell.group).push(cell);
  }
  const distance = cells => Math.hypot(cells.reduce((sum, cell) => sum + cell.x / 3, -17.5),
    cells.reduce((sum, cell) => sum + cell.y / 3, -12));
  return [...groups.values()].filter(cells => cells.length === 3).sort((a, b) => distance(a) - distance(b))[0];
}

test("a selected grain can be removed from a layer and restored without changing its neighbors", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const before = await grainRows(page);
  const box = await page.locator("#interactive canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Delete selected grain", exact: true }).click({ timeout: 4000 });
  const deleted = await grainRows(page);
  assert.equal(deleted.length, before.length - 1);
  assert.deepEqual(deleted.filter(cell => cell.layer !== 1), before.filter(cell => cell.layer !== 1));
  const remaining = new Set(deleted.map(cell => `${cell.layer}:${cell.x}:${cell.y}`));
  assert.deepEqual(deleted, before.filter(cell => remaining.has(`${cell.layer}:${cell.x}:${cell.y}`)));
  await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
  assert.deepEqual(await grainRows(page), before);

  await nextDraw(page, () => page.getByRole("button", { name: "Line Programming", exact: true }).click());
  const lineBefore = await grainRows(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Delete selected grain", exact: true }).click();
  const lineAfter = await grainRows(page);
  assert.equal(lineAfter.length, lineBefore.length - 1);
  await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
  assert.deepEqual(await grainRows(page), lineBefore);
});

test("deleting a selected grain in plane programming removes the corresponding position in every layer", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await nextDraw(page, () => page.getByRole("button", { name: "Plane Programming", exact: true }).click());
  const before = await grainRows(page);
  const box = await page.locator("#interactive canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole("button", { name: "Delete selected grain from all layers", exact: true }).click({ timeout: 4000 });
  const deleted = await grainRows(page);
  for (const layer of [1, 2, 3]) {
    assert.equal(deleted.filter(cell => cell.layer === layer).length,
      before.filter(cell => cell.layer === layer).length - 1);
  }
  await page.getByRole("button", { name: "Undo deletion", exact: true }).click();
  assert.deepEqual(await grainRows(page), before);
});

test("line programming applies one angle per column and retains independent and repeating layer edits", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Line Programming", exact: true }).click({ timeout: 5000 });
  const before = await grainRows(page);
  const byColumn = new Map();
  for (const cell of before) {
    const key = `${cell.layer}:${cell.x}`;
    if (!byColumn.has(key)) byColumn.set(key, cell.angle);
    assert.equal(cell.angle, byColumn.get(key));
  }
  await page.getByLabel("Column layer").selectOption("1");
  const angle = page.getByRole("combobox", { name: "Column angle", exact: true });
  const old = await angle.inputValue();
  const next = old === "150" ? "30" : "150";
  await angle.selectOption(next);
  const edited = await grainRows(page);
  const changed = edited.filter((cell, i) => cell.angle !== before[i].angle);
  assert.ok(changed.length > 1);
  assert.deepEqual(new Set(changed.map(cell => cell.layer)), new Set([2]));
  assert.equal(new Set(changed.map(cell => cell.x)).size, 1);

  await page.locator("#totalLayers").fill("4");
  await page.locator("#lineRepeat").click();
  await page.getByLabel("Column templates per cycle").fill("2");
  await page.locator("#tab-interlayer").click();
  await page.locator('[data-preset=""]').click();
  await page.locator("#stackCycle").click();
  await page.locator("#stackCount").fill("2");
  await page.locator("#stackOrder").fill("α β");
  const beforeRepeatEdit = await grainRows(page);
  await page.locator("#tab-intralayer").click();
  await page.getByLabel("Column layer").selectOption("1");
  await angle.selectOption((await angle.inputValue()) === "150" ? "90" : "150");
  const repeated = await grainRows(page);
  assert.deepEqual([...new Set(repeated.map(cell => `${cell.layer}:${cell.layout}:${cell.sequence}`))],
    ["1:α:1", "2:β:2", "3:α:1", "4:β:2"]);
  const repeatedEdit = repeated.filter((cell, i) => cell.angle !== beforeRepeatEdit[i].angle);
  assert.ok(repeatedEdit.length > 2);
  assert.deepEqual(new Set(repeatedEdit.map(cell => cell.layer)), new Set([2, 4]));
  assert.deepEqual(repeated.filter(cell => cell.layer === 2).map(cell => cell.angle),
    repeated.filter(cell => cell.layer === 4).map(cell => cell.angle));

  await page.getByRole("button", { name: "Point Programming", exact: true }).click();
  if (await page.locator("#switchDialog").isVisible()) {
    const [file] = await Promise.all([page.waitForEvent("download"), page.locator("#saveAndStay").click()]);
    assert.equal(file.suggestedFilename(), "grain-workbench-project.json");
    await page.getByRole("button", { name: "Point Programming", exact: true }).click();
  }
  assert.equal(await page.locator("#totalLayers").inputValue(), "3");
  await page.getByRole("button", { name: "Line Programming", exact: true }).click();
  assert.equal(await page.locator("#totalLayers").inputValue(), "4");
  assert.deepEqual(await grainRows(page), repeated);
});

test("face programming reuses a first-layer pattern across staggered layers", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Plane Programming", exact: true }).click({ timeout: 5000 });
  await page.locator("#totalLayers").fill("4");
  await page.getByLabel("First-layer pattern sequence").fill("1 3 2");
  await page.locator("#tab-interlayer").click();
  await page.locator('[data-preset=""]').click();
  await page.locator("#stackOrder").fill("α β γ β");
  const rows = await grainRows(page);
  assert.deepEqual([...new Set(rows.map(cell => `${cell.layer}:${cell.layout}:${cell.sequence}`))],
    ["1:α:1", "2:β:1", "3:γ:1", "4:β:1"]);
  const lattice = ({ x, y, layout }) => {
    const shift = { α: 0, β: 1, γ: -1 }[layout];
    return `${Math.round(x / Math.sqrt(3)) - shift}:${Math.round((y - (shift ? 1 : 0) - 2) / 3)}`;
  };
  const first = new Map(rows.filter(cell => cell.layer === 1).map(cell => [lattice(cell), cell]));
  const styles = new Set();
  let common = 0;
  for (const cell of rows.filter(cell => cell.layer > 1)) {
    const reference = first.get(lattice(cell));
    if (!reference) continue;
    common++;
    styles.add(cell.style);
    assert.equal(cell.angle, reference.angle);
    assert.equal(cell.style, reference.style);
  }
  assert.ok(common > 150);
  assert.deepEqual(styles, new Set(["1", "2", "3"]));
  const anchors = new Map(rows.filter(cell => cell.layer === 1 && cell.slot === "a").map(cell => {
    const row = Math.round((cell.y - 2) / 3);
    const col = (Math.round(cell.x / Math.sqrt(3)) - row - 1) / 2;
    return [`${row}:${col}`, cell.style];
  }));
  for (const [dr, dc] of [[2, -1], [1, 1], [-1, 2]]) {
    const runs = [...anchors.keys()].map(key => {
      const [row, col] = key.split(":").map(Number);
      return Array.from({ length: 4 }, (_, i) => anchors.get(`${row + i * dr}:${col + i * dc}`));
    }).filter(run => run.every(Boolean));
    assert.ok(runs.length > 0);
    for (const run of runs) {
      assert.equal(new Set(run.slice(0, 3)).size, 3);
      assert.equal(run[0], run[3]);
    }
  }
  assert.deepEqual(rows.filter(cell => cell.layer === 2).map(cell => cell.angle),
    rows.filter(cell => cell.layer === 4).map(cell => cell.angle));
  await page.locator("#tab-intralayer").click();
  await page.getByLabel("First-layer pattern sequence").fill("2");
  assert.deepEqual(new Set((await grainRows(page)).map(cell => cell.style)), new Set(["2"]));
});

test("point and face programming switch between repeating units and custom grain angles", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const box = await page.locator("#interactive canvas").boundingBox();
  const clickGrain = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator("#tab-intralayer").click();
  await page.locator("#pointUnitCycle").click({ timeout: 4000 });
  await clickGrain();
  await page.locator("#cellAngle").waitFor();
  await page.locator("#pointUnitCustom").click();
  await clickGrain();
  await page.locator("#cellAngle").waitFor();

  await download(page, "#export-project");
  await page.getByRole("button", { name: "Plane Programming", exact: true }).click();
  await page.locator("#faceUnitCustom").click({ timeout: 4000 });
  await page.getByLabel("Custom unit order").fill("2 3");
  const before = await grainRows(page);
  const firstLayer = before.filter(cell => cell.layer === 1);
  const unitStyles = [...new Map(firstLayer.map(cell => [cell.group, cell.style])).values()];
  assert.deepEqual(unitStyles.slice(0, 4), ["2", "3", "1", "1"]);
  assert.ok(unitStyles.slice(2).every(style => style === "1"));
  await clickGrain();
  const angle = page.locator("#cellAngle");
  await angle.selectOption((await angle.inputValue()) === "150" ? "30" : "150");
  const after = await grainRows(page);
  const changed = after.filter((cell, i) => cell.angle !== before[i].angle);
  assert.deepEqual(changed.map(cell => cell.layer), [1, 2, 3]);
  await page.locator("#faceUnitCycle").click();
  assert.notDeepEqual(await grainRows(page), before);
  await page.locator("#faceUnitCustom").click();
  assert.deepEqual(await grainRows(page), after);
});

test("point repeating units stay independent by layer and tile in all three directions", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.locator("#tab-intralayer").click();
  await page.locator("#totalLayers").fill("5");
  await page.locator("#pointUnitCycle").click();
  await page.locator("#tab-geometry").click();
  await page.locator("#unitPicker").selectOption("4");
  assert.equal(await page.locator("#layer").inputValue(), "4");
  assert.match(await page.locator("#unitLabel").textContent(), /Layer 5/);
  const position = page.getByRole("button", { name: "Unit position a" });
  await position.click();
  const angle = page.locator("#cellAngle");
  const next = (await angle.inputValue()) === "150" ? "30" : "150";
  const before = await grainRows(page);
  await position.click();
  await angle.selectOption(next);
  const after = await grainRows(page);
  assert.deepEqual(after, before.map(cell => cell.layer === 5 && cell.slot === "a" ? { ...cell, angle: +next } : cell));
  assert.deepEqual([...new Set(after.map(cell => `${cell.layer}:${cell.style}`))], ["1:1", "2:2", "3:3", "4:4", "5:5"]);
  const layer = new Map(after.filter(cell => cell.layer === 5).map(cell => {
    const row = Math.round((cell.y - 3) / 3);
    const x = Math.round(cell.x / Math.sqrt(3));
    return [`${row}:${x}`, `${cell.slot}:${cell.angle}`];
  }));
  for (const [dr, dx] of [[2, 0], [1, 3], [-1, 3]]) {
    let pairs = 0;
    for (const [point, value] of layer) {
      const [row, x] = point.split(":").map(Number);
      const neighbor = layer.get(`${row + dr}:${x + dx}`);
      if (!neighbor) continue;
      assert.equal(neighbor, value);
      pairs++;
    }
    assert.ok(pairs > 60);
  }
});

test("the unit diagram selects the nearest full unit on the current layer and synchronizes both angle controls", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const picker = page.locator("#unitPicker");
  assert.deepEqual(await picker.locator("option").allTextContents(), ["Layer 1", "Layer 2", "Layer 3"]);
  await picker.selectOption("1");
  assert.equal(await page.locator("#layer").inputValue(), "1");
  const before = await grainRows(page);
  const expected = centerGroup(before, 2);
  const position = page.getByRole("button", { name: "Unit position a" });
  const unselected = await snapshot(page);
  await nextDraw(page, () => position.click());
  assert.equal(await position.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#cellInfo").textContent(), `Layer 2 · ${expected[0].group}a`);
  assert.notEqual(await snapshot(page), unselected);
  const angle = page.locator("#cellAngle");
  const original = await angle.inputValue();
  const next = original === "30" ? "150" : "30";
  await angle.selectOption(next);
  const unitAngle = page.locator("#unit-angle-0");
  assert.equal(await unitAngle.inputValue(), next);
  await unitAngle.selectOption(original);
  assert.equal(await angle.inputValue(), original);
  await angle.selectOption(next);
  assert.equal(await position.getAttribute("aria-pressed"), "true");
  await page.locator("#tab-intralayer").click();
  assert.equal(await angle.isVisible(), false);
  await page.locator("#tab-geometry").click();
  assert.equal(await position.getAttribute("aria-pressed"), "false");
  assert.equal(await unitAngle.inputValue(), next);
  assert.match(await position.locator("title").textContent(), new RegExp(`${next}°`));
  const after = await grainRows(page);
  assert.deepEqual(after, before.map(cell => cell.layer === 2 && cell.group === expected[0].group && cell.slot === "a"
    ? { ...cell, angle: +next } : cell));
  await page.locator("#tab-intralayer").click();
  await page.locator("#pointUnitCycle").click();
  await page.locator("#tab-geometry").click();
  await position.click();
  await angle.selectOption(next);
  assert.deepEqual(await grainRows(page), before.map(cell => cell.layer === 2 && cell.slot === "a" ? { ...cell, angle: +next } : cell));
});

test("plane unit positions follow the current layer's center and clear when clicking blank space", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Plane Programming", exact: true }).click();
  await page.locator("#tab-geometry").click();
  await page.locator("#unitPicker").selectOption("2");
  const center = centerGroup(await grainRows(page), 3);
  await page.locator("#planeTemplate summary").click();
  await page.locator("#planePicker").selectOption(center[0].style === "1" ? "2" : "0");
  for (const cell of center) {
    const position = page.getByRole("button", { name: `Unit position ${cell.slot}` });
    await position.click();
    assert.equal(await position.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#cellInfo").textContent(), `Shared cell · ${cell.group}${cell.slot}`);
    assert.equal(await page.locator("#cellAngle").inputValue(), String(cell.angle));
  }
  const canvas = await page.locator("#interactive canvas").boundingBox();
  await page.mouse.click(canvas.x + 5, canvas.y + canvas.height * 0.25);
  assert.equal(await page.locator("#cellAngle").isVisible(), false);
  assert.equal(await page.locator('#unit [aria-pressed="true"]').count(), 0);
});

test("stacking presets both repeat, and switching dirty modes can save or discard edits", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.locator("#tab-interlayer").click();
  assert.equal(await page.locator('[data-preset="αβγ"]').getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#stackCycle").getAttribute("aria-pressed"), "true");
  await page.locator('[data-preset="ααα"]').click();
  assert.equal(await page.locator("#stackCycle").getAttribute("aria-pressed"), "true");
  await page.locator("#tab-geometry").click();
  await page.getByRole("button", { name: "Unit position a" }).click();
  await page.locator("#cellAngle").selectOption("150");
  const savedRows = await grainRows(page);
  const line = page.getByRole("button", { name: "Line Programming", exact: true });
  await line.click();
  await page.getByRole("dialog", { name: "Unsaved changes" }).waitFor();
  const [project] = await Promise.all([page.waitForEvent("download"), page.locator("#saveAndStay").click()]);
  assert.equal(project.suggestedFilename(), "grain-workbench-project.json");
  const saved = JSON.parse(await fs.readFile(await project.path(), "utf8"));
  assert.equal(saved.program, "point");
  assert.equal(saved.design.preset, "ααα");
  assert.equal(await line.getAttribute("aria-pressed"), "false");
  await page.locator("#strandWidth").fill("0.8");
  await line.click();
  await page.locator("#discardSwitch").click();
  assert.equal(await line.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#strandWidth").inputValue(), "0.6");
  await page.getByRole("button", { name: "Point Programming", exact: true }).click();
  assert.equal(await page.locator('[data-preset="ααα"]').getAttribute("aria-pressed"), "true");
  const reopened = await openWorkbench(t);
  await reopened.goto(url);
  await reopened.locator("#projectFile").setInputFiles(await project.path());
  await reopened.locator('[data-preset="ααα"][aria-pressed="true"]').waitFor({ state: "attached" });
  await reopened.locator("#tab-interlayer").click();
  assert.equal(await reopened.locator('#stackCycle').getAttribute("aria-pressed"), "true");
  assert.deepEqual(await grainRows(reopened), savedRows);
});

test("the local workbench downloads separately extruded strokes at touching layer heights", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const outlines = (await download(page, "#csv")).split("\r\n").slice(1);
  await page.locator("#exportMenu summary").click();
  await page.locator("#export-gcode").click();
  const submit = page.getByRole("button", { name: "Download G-code" });
  const bedX = page.getByLabel("Build X / mm");
  await bedX.fill("10");
  await submit.click();
  assert.match(await page.locator("#gcodeError").textContent(), /build volume/);
  await bedX.fill("220");
  const [file] = await Promise.all([page.waitForEvent("download"), submit.click()]);
  assert.equal(file.suggestedFilename(), "grain-strands.gcode");
  const code = await fs.readFile(await file.path(), "utf8");
  assert.deepEqual([...code.matchAll(/^; LAYER \d+ model-layer=\d+ Z=([\d.]+)$/gm)].map(match => +match[1]), [0.3, 0.6, 0.9]);
  const strokes = code.split("; STROKE\n").slice(1);
  assert.ok(strokes.length > 1000);
  for (const stroke of strokes) {
    assert.match(stroke, /^G0 Z.*\nG0 X.*\nG0 Z.*\n(?:G1 E0\.6.*\n)?G1 X.*\nG1 E-0\.6/m);
    assert.equal((stroke.match(/^G1 X/gm) ?? []).length, 1);
    assert.ok(+stroke.match(/^G1 X[^\n]+ E([\d.]+)/m)[1] > 0);
  }

  const sharedEdges = new Map();
  for (const row of outlines) {
    const [layer, , , , group, , slot] = row.split(",");
    const points = row.match(/"([^"]+)"/)[1].split(" ");
    if (points.length !== 6) continue;
    const edges = points.map((point, i) => [point, points[(i + 1) % points.length]]);
    const world = point => point.split(",").map(Number);
    const length = ([a, b]) => Math.hypot(world(a)[0] - world(b)[0], world(a)[1] - world(b)[1]);
    if (!edges.every(edge => Math.abs(length(edge) - 2) < 0.0001)) continue;
    for (const edge of edges) {
      const key = `${layer}:${edge.slice().sort().join(";")}`;
      if (!sharedEdges.has(key)) sharedEdges.set(key, []);
      sharedEdges.get(key).push({ cell: `${layer}:${group}:${slot}`, a: world(edge[0]), b: world(edge[1]) });
    }
  }
  const roads = new Map();
  for (const segment of code.split(/^; LAYER /m).slice(1)) {
    const layer = segment.match(/model-layer=(\d+)/)[1];
    for (const grain of segment.split(/^; GRAIN /m).slice(1)) {
      const [, group, slot] = grain.match(/^group=(\d+) slot=([abc])/);
      const moves = [...grain.matchAll(/^G0 X([\d.]+) Y([\d.]+)[^\n]*\nG0 Z[^\n]*\n(?:G1 E[^\n]*\n)?G1 X([\d.]+) Y([\d.]+)/gm)];
      roads.set(`${layer}:${group}:${slot}`, moves.map(([, x1, y1, x2, y2]) => [[+x1 - 5, 29 - y1], [+x2 - 5, 29 - y2]]));
    }
  }
  let joins = 0;
  for (const edges of sharedEdges.values()) {
    if (edges.length !== 2) continue;
    const [{ a, b }, other] = edges;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const signedDistance = ([x, y]) => (dx * (y - a[1]) - dy * (x - a[0])) / length;
    const projection = ([x, y]) => (dx * (x - a[0]) + dy * (y - a[1])) / length;
    const parallelRoad = (id, offset) => roads.get(id).find(stroke =>
      stroke.every(point => Math.abs(signedDistance(point) - offset) < 0.0001));
    const first = parallelRoad(edges[0].cell, 0.228);
    const second = parallelRoad(other.cell, -0.228);
    assert.ok(first && second, "both grains have a separate road centered near their shared edge");
    const [a0, a1] = first.map(projection).sort((x, y) => x - y);
    const [b0, b1] = second.map(projection).sort((x, y) => x - y);
    assert.ok(Math.min(a1, b1) - Math.max(a0, b0) > 1);
    assert.ok(0.6 - Math.abs(signedDistance(first[0]) - signedDistance(second[0])) > 0.14);
    joins++;
  }
  assert.ok(joins > 400);

  await page.locator("#strandWidth").fill("0.8");
  await page.locator("#exportMenu summary").click();
  await page.locator("#export-gcode").click();
  const [wider] = await Promise.all([page.waitForEvent("download"), submit.click()]);
  const widerCode = await fs.readFile(await wider.path(), "utf8");
  assert.deepEqual([...widerCode.matchAll(/^; LAYER \d+ model-layer=\d+ Z=([\d.]+)$/gm)].map(match => +match[1]), [0.4, 0.8, 1.2]);
});

test("only numbered layers appear in the preview and export offers STL and 3MF", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  assert.deepEqual(await page.locator("#layer option").allTextContents(), ["Layer 1", "Layer 2", "Layer 3"]);
  assert.equal(await page.getByRole("button", { name: "Isometric", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Top", exact: true }).count(), 0);
  for (const format of ["stl", "3mf"]) {
    await page.locator("#exportMenu summary").click({ timeout: 4000 });
    const [file] = await Promise.all([page.waitForEvent("download"), page.locator("#export-" + format).click()]);
    assert.equal(file.suggestedFilename(), "grain-strands." + format);
    const data = await fs.readFile(await file.path());
    assert.ok(data.byteLength > 1000);
    if (format === "stl") {
      let maxZ = 0;
      for (let face = 84; face < data.byteLength; face += 50) {
        for (const vertexZ of [20, 32, 44]) maxZ = Math.max(maxZ, data.readFloatLE(face + vertexZ));
      }
      assert.ok(Math.abs(maxZ - 0.9) < 1e-6);
    }
  }
});

test("clicking a grain highlights it and changing its angle updates one exported cell", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const before = (await download(page, "#csv")).split("\r\n");
  const canvas = await page.locator("#interactive canvas").boundingBox();
  const x = canvas.x + canvas.width / 2, y = canvas.y + canvas.height / 2;
  const detail = () => page.screenshot({ clip: { x: x - 110, y: y - 70, width: 220, height: 140 } });
  const plain = await detail();
  await nextDraw(page, () => page.mouse.click(x, y));
  const angle = page.getByRole("combobox", { name: "Cell angle" });
  await angle.waitFor({ timeout: 5000 });
  assert.notDeepEqual(await detail(), plain);
  const old = await angle.inputValue();
  const next = old === "150" ? "30" : "150";
  const selected = await snapshot(page);
  await nextDraw(page, () => angle.selectOption(next));
  assert.equal(await angle.inputValue(), next);
  assert.notEqual(await snapshot(page), selected);
  const after = (await download(page, "#csv")).split("\r\n");
  const changed = after.map((line, i) => i).filter(i => after[i] !== before[i]);
  assert.equal(changed.length, 1);
  const cells = before[changed[0]].split(",");
  assert.equal(cells[7], old);
  cells[7] = next;
  assert.equal(after[changed[0]], cells.join(","));

  assert.equal(await angle.isVisible(), false);
  await page.mouse.click(x, y);
  await page.getByRole("button", { name: "Clear selection" }).click();
  assert.equal(await angle.isVisible(), false);
  await nextDraw(page, () => page.locator("#renderStyle").selectOption("layer"));
  await page.mouse.click(x, y);
  assert.equal(await angle.inputValue({ timeout: 5000 }), next);
  await page.keyboard.press("Escape");
  assert.equal(await angle.isVisible(), false);
});

test("WebGL draws actual geometry and responds to continuous rotation, zoom, and right-button pan", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const canvas = page.locator("#interactive canvas");
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.5;
  const initial = await snapshot(page);
  await nextDraw(page, async () => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 72; i++) {
      await page.mouse.move(x + 135 * Math.sin(i / 13), y + 95 * Math.sin(i / 21));
    }
    await page.mouse.up();
  });
  const rotated = await snapshot(page);
  assert.notEqual(rotated, initial);
  assert.equal(await page.getByRole("combobox", { name: "Cell angle" }).isVisible(), false);
  await nextDraw(page, () => page.mouse.wheel(0, -360));
  const zoomed = await snapshot(page);
  assert.notEqual(zoomed, rotated);
  await nextDraw(page, async () => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x + 95, y + 55, { steps: 16 });
    await page.mouse.up({ button: "right" });
  });
  assert.notEqual(await snapshot(page), zoomed);
  await nextDraw(page, () => page.getByRole("button", { name: "Reset" }).click());
  assert.equal(await snapshot(page), initial);
  const settled = await page.evaluate(() => window.gpu.draws);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.gpu.draws), settled);
});

test("rapid edits and repeated model generation retain one canvas and release old GPU buffers", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const initial = await snapshot(page);
  const liveBuffers = () => page.evaluate(() => {
    const gl = document.querySelector("#interactive canvas").getContext("webgl2");
    return window.gpu.liveBuffers(gl);
  });
  const baseline = await liveBuffers();
  assert.ok(baseline > 0);
  for (let round = 0; round < 15; round++) {
    const allocated = await page.evaluate(() => window.gpu.allocated);
    await nextDraw(page, () => page.locator("#width").evaluate((input, iteration) => {
      for (let i = 0; i < 30; i++) {
        input.value = String(35 + i + iteration);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, round));
    assert.equal(await liveBuffers(), baseline);
    assert.equal(await page.evaluate(() => window.gpu.allocated), allocated + baseline);
  }
  assert.equal(await page.locator("#interactive canvas").count(), 1);
  assert.notEqual(await snapshot(page), initial);
  const latest = await snapshot(page);
  const beforeInvalid = await page.evaluate(() => window.gpu.draws);
  await page.locator("#width").fill("");
  await page.locator("#error").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.gpu.draws), beforeInvalid);
  assert.equal(await snapshot(page), latest);
  assert.equal(await page.locator("#csv").isDisabled(), true);
  await nextDraw(page, () => page.locator("#width").fill("35"));
  assert.equal(await snapshot(page), initial);
  await nextDraw(page, () => page.locator("#layer").selectOption("2"));
  assert.match(await page.locator("#stats").textContent(), /Layer 3 of 3/);
  assert.notEqual(await snapshot(page), initial);
});

test("context loss pauses drawing and restoration shows the latest valid geometry", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const initial = await snapshot(page);
  await page.evaluate(() => {
    const canvas = document.querySelector("#interactive canvas");
    window.contextLoss = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
    if (!window.contextLoss) throw Error("Browser lacks WEBGL_lose_context");
    window.contextLoss.loseContext();
  });
  await page.locator('#interactive[data-status="lost"]').waitFor();
  const paused = await page.evaluate(() => window.gpu.draws);
  await page.locator("#width").fill("55");
  await page.getByRole("button", { name: "Reset" }).click();
  assert.equal(await page.evaluate(() => window.gpu.draws), paused);
  await nextDraw(page, () => page.evaluate(() => window.contextLoss.restoreContext()));
  await ready(page);
  assert.notEqual(await snapshot(page), initial);
  assert.equal(await page.locator("#interactive canvas").count(), 1);
});

test("an unexpected draw failure can be retried without leaving an extra canvas", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.evaluate(() => { window.gpu.failNextDraw = true; });
  await page.locator("#width").fill("59");
  await page.locator('#interactive[data-status="error"]').waitFor();
  await nextDraw(page, () => page.getByRole("button", { name: "Retry 3D" }).click());
  await ready(page);
  assert.equal(await page.locator("#interactive canvas").count(), 1);
});

test("the SVG fallback and model downloads remain available when WebGL initialization fails", async t => {
  const page = await openWorkbench(t, { webglUnavailable: true });
  await page.goto(url);
  await page.locator('#interactive[data-status="error"]').waitFor({ timeout: 5000 });
  await page.locator("#canvas polygon").first().waitFor();
  const svg = await download(page, "#svg");
  assert.match(svg, /<polygon/);
  assert.match(svg, /depth-shadow/);
  await page.locator("#exportMenu summary").click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.locator("#export-stl").click()]);
  assert.equal(file.suggestedFilename(), "grain-strands.stl");
});

test("scientific CSV is identical across view modes", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  const csv = await download(page, "#csv");
  assert.match(csv, /^\uFEFFlayer,sequence,layout,cycle,group,style,slot,angle_deg,x_mm,y_mm,edge_mm,clipped_outline_mm/);
  assert.equal(csv.split("\r\n").length - 1, 297);
  const isometric = await download(page, "#svg");
  for (const value of ["solid", "layer", "print"]) {
    await page.locator("#renderStyle").selectOption(value);
    assert.equal(await download(page, "#csv"), csv);
    assert.equal(await download(page, "#svg"), isometric);
  }
});

test("the 3D model and every view button remain unobstructed at tablet width", async t => {
  const page = await openWorkbench(t, { viewport: { width: 768, height: 800 } });
  await page.goto(url);
  await ready(page);
  const buttons = page.locator("#layer, #renderStyle");
  for (const button of await buttons.all()) await button.click({ trial: true, timeout: 1500 });
  await page.locator("#togglePanel").click();
  for (const button of await buttons.all()) await button.click({ trial: true, timeout: 1500 });
});

test("a narrow viewport keeps exports readable and accepts the advertised touch gestures", async t => {
  const page = await openWorkbench(t, {
    viewport: { width: 320, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(url);
  await ready(page);
  const buttons = page.locator("#exportMenu summary");
  for (const button of await buttons.all()) {
    const box = await button.boundingBox();
    assert.ok(box.height >= 36 && box.height <= 44);
    assert.ok(box.x >= 0 && box.x + box.width <= 320);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  for (const button of await page.getByRole("navigation", { name: "Programming modes" }).getByRole("button").all()) {
    const box = await button.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320);
  }
  for (const button of await page.locator("#layer, .tools button").all()) {
    const box = await button.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320);
    assert.ok(await button.evaluate(element => element.scrollWidth <= element.clientWidth));
  }
  await page.locator("#strandWidth").click({ trial: true, timeout: 1500 });
  assert.equal(await page.getByText("Drag to rotate · Scroll to zoom · Right-drag to pan").isVisible(), false);
  assert.equal(await page.getByText("One finger to rotate · Pinch to zoom · Two fingers to pan").isVisible(), true);

  const canvas = await page.locator("#interactive canvas").boundingBox();
  const point = { id: 0, x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const client = await page.context().newCDPSession(page);
  const input = (type, touchPoints) => client.send("Input.dispatchTouchEvent", { type, touchPoints });
  const initial = await snapshot(page);
  await nextDraw(page, async () => {
    await input("touchStart", [point]);
    for (let step = 1; step <= 12; step++) {
      await input("touchMove", [{ ...point, x: point.x + 5 * step, y: point.y + 3 * step }]);
    }
    await input("touchEnd", []);
  });
  assert.notEqual(await snapshot(page), initial);
  await nextDraw(page, () => page.getByRole("button", { name: "Reset" }).tap());
  assert.equal(await snapshot(page), initial);

  const fingers = (halfSeparation, dx = 0, dy = 0) => [
    { ...point, x: point.x + dx - halfSeparation, y: point.y + dy },
    { id: 1, x: point.x + dx + halfSeparation, y: point.y + dy },
  ];
  await nextDraw(page, async () => {
    await input("touchStart", fingers(28));
    for (let step = 1; step <= 6; step++) await input("touchMove", fingers(28 + 6 * step));
    await input("touchEnd", []);
  });
  const pinched = await snapshot(page);
  assert.notEqual(pinched, initial);
  await nextDraw(page, async () => {
    await input("touchStart", fingers(35));
    for (let step = 1; step <= 6; step++) await input("touchMove", fingers(35, 6 * step, 4 * step));
    await input("touchEnd", []);
  });
  assert.notEqual(await snapshot(page), pinched);
  await page.getByRole("button", { name: "Show", exact: true }).tap();
  const stage = await page.locator(".stage").boundingBox();
  const sidebar = await page.locator("#controls").boundingBox();
  assert.ok(sidebar.y >= stage.y + stage.height);
  for (const tab of await page.getByRole("tab").all()) {
    assert.ok(await tab.evaluate(element => element.scrollWidth <= element.clientWidth));
  }
  const unit = page.getByRole("button", { name: "Unit position a" });
  await unit.tap();
  assert.equal(await unit.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#cellAngle").isVisible(), true);
});

test("a large accepted structure draws and the existing cell limit preserves it on rejection", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const initial = await snapshot(page);
  await nextDraw(page, () => page.evaluate(() => {
    for (const [id, value] of [["width", 100], ["height", 80], ["edge", 0.5]]) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }));
  const count = Number((await page.locator("#stats").textContent()).match(/(\d+) cells/)[1]);
  assert.ok(count > 10000, "stress case draws a large layer");
  const large = await snapshot(page);
  assert.notEqual(large, initial);
  await page.locator("#width").fill("250");
  await page.locator("#error").waitFor({ state: "visible" });
  assert.match(await page.locator("#error").textContent(), /Too many cells/);
  assert.equal(await snapshot(page), large);
});

test("the print preview changes with strand diameter and shows uncovered areas without partial strands", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const input = page.getByRole("spinbutton", { name: "Strand diameter / mm" });
  assert.equal(await input.inputValue({ timeout: 5000 }), "0.6");
  await page.locator("#printNote").filter({ hasText: /[1-9]\d* strands/ }).waitFor({ timeout: 5000 });
  assert.match(await page.locator("#printNote").textContent(), /0\.06 mm in-layer gap/);
  assert.match(await page.locator("#printNote").textContent(), /0\.3 mm layer/);
  await nextDraw(page, () => input.fill("0.8"));
  assert.match(await page.locator("#printNote").textContent(), /0\.4 mm layer/);
  await nextDraw(page, () => input.fill("0.6"));
  const defaultPrint = await snapshot(page);
  await page.locator("#layer").selectOption("1");
  await page.locator("#layer").selectOption("0");
  await nextDraw(page, () => input.fill("6"));
  await page.locator("#printNote").filter({ hasText: "0 strands" }).waitFor({ timeout: 5000 });
  assert.notEqual(await snapshot(page), defaultPrint);
  await input.fill("");
  await page.locator("#printError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#csv").isEnabled(), true);
  await nextDraw(page, () => input.fill("0.6"));
  await page.locator("#printNote").filter({ hasText: /[1-9]\d* strands/ }).waitFor({ timeout: 5000 });
  assert.equal(await snapshot(page), defaultPrint);
  await nextDraw(page, () => page.locator("#renderStyle").selectOption("layer", { timeout: 5000 }));
  const oneLayer = await snapshot(page);
  assert.notEqual(oneLayer, defaultPrint);
  await nextDraw(page, () => page.locator("#layer").selectOption("1"));
  assert.notEqual(await snapshot(page), oneLayer);
  await nextDraw(page, () => page.locator("#layer").selectOption("0"));
  await nextDraw(page, () => page.locator("#renderStyle").selectOption("print"));
  assert.equal(await snapshot(page), defaultPrint);
  await nextDraw(page, () => page.locator("#renderStyle").selectOption("solid"));
  assert.equal(await input.isVisible(), false);
  assert.notEqual(await snapshot(page), defaultPrint);
});
