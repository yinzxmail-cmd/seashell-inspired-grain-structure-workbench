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

function exportedToolpaths(code) {
  const paths = new Map();
  for (const layer of code.split(/^; LAYER /m).slice(1)) {
    const layerNumber = +layer.match(/model-layer=(\d+)/)[1];
    const moves = layer.matchAll(/^G0 X([\d.]+) Y([\d.]+)[^\n]*\nG0 Z[^\n]*\n(?:G1 E[^\n]*\n)?G1 X([\d.]+) Y([\d.]+)/gm);
    paths.set(layerNumber, [...moves].map(([, ...axes]) => axes.map(Number)));
  }
  return paths;
}

const extrusions = code => [...code.matchAll(/^G1 X.* E([\d.]+) F/gm)].map(match => match[1]);
const totalExtrusion = paths => paths.reduce((sum,value) => sum + Number(value),0);

function gcodeGrains(code) {
  const roads = new Map();
  for (const segment of code.split(/^; LAYER /m).slice(1)) {
    const layer = segment.match(/model-layer=(\d+)/)[1];
    for (const grain of segment.split(/^; GRAIN /m).slice(1)) {
      const [, group, slot, angle] = grain.match(/^group=(\d+) slot=([abc]) angle=(\d+)/);
      const moves = [...grain.matchAll(/^G0 X([\d.]+) Y([\d.]+)[^\n]*\nG0 Z[^\n]*\n(?:G1 E[^\n]*\n)?G1 X([\d.]+) Y([\d.]+) E([\d.]+)/gm)];
      roads.set(`${layer}:${group}:${slot}`, moves.map(([, x1, y1, x2, y2, extrusion]) => {
        const start = [+x1 - 5, 29 - y1], end = [+x2 - 5, 29 - y2];
        const [dx, dy] = [end[0] - start[0], end[1] - start[1]];
        const length = Math.hypot(dx, dy), h = 0.3;
        const width = (+extrusion * Math.PI * (1.75 / 2) ** 2) / (length * h) + h * (1 - Math.PI / 4);
        const rad = +angle * Math.PI / 180;
        assert.ok(Math.abs(dx * Math.sin(rad) + dy * Math.cos(rad)) < 2e-5, "each extruded segment follows its grain angle");
        const shift = ([x, y], sign) => [x - sign * dy * width / (2 * length), y + sign * dx * width / (2 * length)];
        return [shift(start,-1),shift(end,-1),shift(end,1),shift(start,1)];
      }));
    }
  }
  return roads;
}

function footprintsOverlap(one, other) {
  return [one, other].every(points => points.every(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    const project = polygon => polygon.map(([u, v]) => (ny - y) * u - (nx - x) * v);
    const first = project(one), second = project(other);
    return Math.max(Math.min(...first), Math.min(...second)) < Math.min(Math.max(...first), Math.max(...second)) - 1e-5;
  }));
}

async function downloadGcode(page) {
  await page.locator("#exportMenu summary").click();
  await page.locator("#export-gcode").click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download G-code" }).click()]);
  return fs.readFile(await file.path(), "utf8");
}

async function assertExportMatchesPreview(page, paths) {
  const displayed = await page.evaluate(() => {
    const point = ([x, y]) => [x + 5, model.height - y + 5].map(value => +value.toFixed(5));
    return getPrintPlan().layers.map(({ tracks }) => tracks.map(({ start, end }) => [...point(start), ...point(end)]));
  });
  assert.equal(paths.size, displayed.length);
  displayed.forEach((layer, i) => assert.deepEqual(paths.get(i + 1), layer, `deposited strokes in layer ${i + 1}`));
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

test("deleting a selected grain in face programming removes the corresponding position in every layer", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await nextDraw(page, () => page.getByRole("button", { name: "Face Programming", exact: true }).click());
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

test("line directions support independent cycles, custom lines, and alternating double-strand intersections", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Line Programming", exact: true }).click();
  const axes = page.locator(".line-family");
  const first = axes.nth(0);
  const direction = first.getByLabel("Direction", { exact: true });
  assert.deepEqual(await direction.locator("option").allTextContents(), ["0°","60°","90°","120°"]);
  const original = await snapshot(page);
  await nextDraw(page, () => direction.selectOption("0"));
  assert.notEqual(await snapshot(page), original);
  await first.getByLabel("Line layout").selectOption("repeat");
  await first.getByLabel("Lines per cycle").selectOption("2");
  await first.getByLabel("Cycle 1").selectOption("30");
  await first.getByLabel("Cycle 2").selectOption("60");
  const firstLayer = (await grainRows(page)).filter(cell => cell.layer === 1);
  const rows = new Map();
  for (const cell of firstLayer) {
    if (!rows.has(cell.y)) rows.set(cell.y, new Set());
    rows.get(cell.y).add(cell.angle);
  }
  assert.ok([...rows.values()].every(angles => angles.size === 1));
  const rowAngles = [...rows.entries()].sort(([a],[b]) => a-b).map(([,angles]) => [...angles][0]);
  assert.deepEqual(new Set(rowAngles), new Set([30,60]));
  assert.ok(rowAngles.every((angle,i) => !i || angle !== rowAngles[i-1]));
  await first.getByLabel("Line layout").selectOption("custom");
  await first.getByLabel("Line", { exact: true }).selectOption("0");
  await first.getByLabel("Line angle", { exact: true }).selectOption("150");
  const custom = (await grainRows(page)).filter(cell => cell.layer === 1);
  assert.ok(custom.some(cell => cell.angle === 150));
  assert.equal(new Set(custom.filter(cell => cell.angle === 150).map(cell => cell.y)).size,1);

  await page.getByRole("button", { name: "Double strand", exact: true }).click();
  const second = axes.nth(1);
  assert.ok(await second.getByLabel("Direction 2").locator('option[value="0"]').isDisabled());
  await second.getByLabel("Direction 2").selectOption("90");
  const guides = await page.evaluate(() => {
    const { axes, center } = model.lineGeometry[0];
    const visible = showLineEditor(0);
    return {
      expected: [...new Set(axes.flatMap(axis => axis.get(0).map(cell => cell.id)))].sort(),
      actual: visible.cells.map(cell => cell.id).sort(),
      centralCell: visible.anchor?.id,
      expectedCenter: center.id,
    };
  });
  assert.deepEqual(guides.actual, guides.expected);
  assert.equal(guides.centralCell, guides.expectedCenter);
  const sidebar = await page.locator("#controls").boundingBox();
  const merge = await page.locator("#mergeGrains").boundingBox();
  assert.ok(sidebar.y + sidebar.height < merge.y);
  for (const [axis, angle] of [[first,"30"],[second,"90"]]) {
    await axis.getByLabel("Line layout").selectOption("repeat");
    await axis.getByLabel("Lines per cycle").selectOption("1");
    await axis.getByLabel("Cycle 1").selectOption(angle);
  }
  const woven = (await grainRows(page)).filter(cell => cell.layer === 1);
  const center = woven.reduce((best, cell) => Math.hypot(cell.x - 17.5, cell.y - 12) < Math.hypot(best.x - 17.5, best.y - 12) ? cell : best);
  const axial = ({x,y}) => Math.round((x / Math.sqrt(3) - Math.round((y - 2) / 3) - 1) / 2);
  for (const cell of woven) assert.equal(cell.angle, Math.abs((axial(cell)-axial(center))%2) ? 30 : 90);
  assert.deepEqual(new Set(woven.map(cell => cell.angle)), new Set([30,90]));
});

test("face programming sets every grain in a layer to one angle while stacking remains independent", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Face Programming", exact: true }).click();
  assert.equal(await page.locator(".viewer-head #totalLayers").count(), 1);
  assert.equal(await page.locator("#panel-intralayer #totalLayers").count(), 0);
  await page.locator("#totalLayers").fill("4");
  const angle = page.getByLabel("Layer 3 angle", { exact: true });
  await angle.selectOption("custom");
  const slider = page.getByRole("slider", { name: "Custom angle in degrees" });
  await slider.fill("47");
  assert.equal(await page.locator("#angleNumber").inputValue(), "47");
  await page.getByRole("button", { name: "Apply angle" }).click();
  await page.getByLabel("Layer 4 angle", { exact: true }).selectOption("60");
  const rows = await grainRows(page);
  assert.deepEqual([...new Set(rows.map(cell => cell.layer + ":" + cell.layout + ":" + cell.angle))],
    ["1:α:30", "2:β:90", "3:γ:47", "4:α:60"]);
  const centers = layer => rows.filter(cell => cell.layer === layer).map(cell => cell.x + "," + cell.y);
  assert.deepEqual(centers(1), centers(4));
  assert.notDeepEqual(centers(2), centers(3));
  await page.locator("#tab-geometry").click();
  await page.locator("#unitPicker").selectOption("1");
  await page.getByRole("button", {name:"Unit position b"}).click();
  await page.getByLabel("Layer angle", {exact:true}).selectOption("150");
  const after = await grainRows(page);
  assert.deepEqual(after,rows.map(cell => cell.layer===2 ? {...cell,angle:150}:cell));
  await page.locator("#tab-intralayer").click();
  await page.locator("#totalLayers").fill("8");
  await page.getByLabel("Layer 8 angle", { exact: true }).waitFor();
  const expanded = new Map((await grainRows(page)).map(cell => [cell.layer, cell.angle % 180]));
  assert.equal(expanded.size, 8);
  assert.equal(new Set(expanded.values()).size, 8);
  assert.ok(await angle.locator('option[value="150"]').isDisabled());
  await angle.selectOption("custom");
  await slider.fill("150");
  await page.getByRole("button", { name: "Apply angle" }).click();
  assert.ok(await page.getByRole("dialog", { name: "Custom angle" }).isVisible());
  assert.match(await page.locator("#angleError").textContent(), /Layer 2/);
  await slider.fill("180");
  await page.getByRole("button", { name: "Apply angle" }).click();
  assert.match(await page.locator("#angleError").textContent(), /Layer 6/);
  await slider.fill("53");
  await page.getByRole("button", { name: "Apply angle" }).click();
  assert.equal(await angle.inputValue(), "53");
});

test("point layout displays an editable angle triple per layer in both arrangements", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.locator("#tab-intralayer").click();
  for (const id of ["pointUnitCycle","pointUnitCustom"]) {
    await page.locator("#"+id).click();
    for(const n of [1,2,3]) {
      assert.ok(await page.locator("#pointLayerRows").getByRole("button",{name:"Layer "+n,exact:true}).isVisible());
      assert.ok(await page.getByLabel("Layer "+n+" position a",{exact:true}).isEnabled());
    }
  }
  await page.getByLabel("Layer 2 position b",{exact:true}).selectOption("60");
  const cells=await grainRows(page);
  assert.ok(cells.filter(cell=>cell.layer===2&&cell.slot==="b").every(cell=>cell.angle===60));
  assert.ok(cells.filter(cell=>cell.layer===1&&cell.slot==="b").every(cell=>cell.angle===90));
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

test("face unit positions follow the current layer's center and clear when clicking blank space", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Face Programming", exact: true }).click();
  await page.locator("#tab-geometry").click();
  await page.locator("#unitPicker").selectOption("2");
  const center = centerGroup(await grainRows(page), 3);
  for (const cell of center) {
    const position = page.getByRole("button", { name: `Unit position ${cell.slot}` });
    await position.click();
    assert.equal(await position.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#cellInfo").textContent(), `Layer 3 · ${cell.group}${cell.slot}`);
    assert.equal(await page.locator("#cellAngle").inputValue(), String(cell.angle));
  }
  const canvas = await page.locator("#interactive canvas").boundingBox();
  await page.mouse.click(canvas.x + 5, canvas.y + canvas.height * 0.25);
  assert.equal(await page.locator("#cellAngle").isVisible(), false);
  assert.equal(await page.locator('#unit [aria-pressed="true"]').count(), 0);
});

test("the hexagonal palette recolors only a selected grain and saves exact custom colors", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const colors=page.getByRole("group",{name:"Grain color"});
  assert.equal(await colors.getByRole("button").count(),6);
  assert.ok(await colors.getByRole("button",{name:"Black",exact:true}).isDisabled());
  await page.getByRole("button",{name:"Unit position a"}).click();
  const baseline=await snapshot(page);
  await nextDraw(page,()=>colors.getByRole("button",{name:"Black",exact:true}).click());
  assert.notEqual(await snapshot(page),baseline);
  assert.equal(await colors.getByRole("button",{name:"Black",exact:true}).getAttribute("aria-pressed"),"true");
  await colors.getByLabel("Custom grain color").fill("#416a91");
  assert.equal(await colors.getByLabel("Custom grain color").inputValue(),"#416a91");
  assert.equal(await page.locator('#unit defs rect[fill="#416a91"]').count(),1);
  const project=JSON.parse(await download(page,"#export-project"));
  assert.deepEqual(project.design.colors.map(([,color])=>color),["#416a91"]);
});

test("the merge toggle renders and exports longer continuous roads using the same material volume", async t => {
  const page = await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button",{name:"Face Programming",exact:true}).click();
  const toggle=page.getByRole("button",{name:"Merge matching grains",exact:true});
  const original=await snapshot(page);
  const before=await downloadGcode(page);
  await nextDraw(page,()=>toggle.click());
  assert.equal(await toggle.getAttribute("aria-pressed"),"true");
  assert.notEqual(await snapshot(page),original);
  const code=await downloadGcode(page);
  const joined = extrusions(code), initial = extrusions(before);
  assert.ok(joined.length < initial.length);
  assert.ok(Math.abs(totalExtrusion(joined)-totalExtrusion(initial))<1e-4);
  const paths = exportedToolpaths(code);
  assert.match(code,/^; REGION grains=(?:[2-9]|[1-9]\d+) angle=/m);
  const longest = layers => [...layers.values()].flat().reduce((max,[x1,y1,x2,y2]) =>
    Math.max(max,Math.hypot(x2-x1,y2-y1)),0);
  assert.ok(longest(paths)>2*longest(exportedToolpaths(before)));
  await assertExportMatchesPreview(page, paths);
});

test("merge reports no matching edges, then joins roads when an adjacent pair is aligned", async t => {
  const page=await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  const merge=page.getByRole("button",{name:"Merge matching grains",exact:true});
  await page.locator("#renderStyle").selectOption("solid");
  await merge.click();
  assert.equal(await page.locator("#renderStyle").inputValue(),"layer");
  const note=page.locator("#mergeNote");
  assert.match(await note.textContent({timeout:4000}),/No adjacent grains with matching angles/);
  await page.getByRole("button",{name:"Unit position b",exact:true}).click();
  await page.locator("#cellAngle").selectOption("30");
  assert.match(await note.textContent(),/[1-9]\d* continuous strokes/);
  const merged=await downloadGcode(page);
  await merge.click();
  const original=await downloadGcode(page);
  assert.ok(Math.abs(totalExtrusion(extrusions(merged))-totalExtrusion(extrusions(original)))<1e-4);
  assert.match(merged,/^; REGION grains=(?:[2-9]|[1-9]\d+) angle=30$/m);
  assert.notDeepEqual(exportedToolpaths(merged),exportedToolpaths(original));
});

test("custom angles accept numerical input and reject values outside zero to 180", async t => {
  const page=await openWorkbench(t);
  await page.goto(url);
  await ready(page);
  await page.getByRole("button",{name:"Unit position a",exact:true}).click();
  const angle=page.locator("#cellAngle");
  await angle.selectOption("custom");
  const number=page.getByRole("spinbutton",{name:"Angle in degrees",exact:true});
  const range=page.locator("#angleRange");
  const dialog=page.getByRole("dialog",{name:"Custom angle"});
  for (const value of ["-0.5","180.5"]) {
    await number.fill(value,{timeout:4000});
    assert.equal(await number.getAttribute("aria-invalid"),"true");
    assert.match(await page.locator("#angleError").textContent(),/0° and 180°/);
    assert.equal(await number.evaluate(el=>getComputedStyle(el).borderTopColor),"rgb(165, 47, 57)");
    await number.press("Enter");
    assert.ok(await dialog.isVisible());
  }
  await number.fill("47.5");
  assert.equal(await number.getAttribute("aria-invalid"),"false");
  assert.equal(await range.inputValue(),"47.5");
  await range.fill("180");
  assert.equal(await number.inputValue(),"180");
  await number.fill("47.5");
  await number.press("Enter");
  assert.equal(await angle.inputValue(),"47.5");
  assert.ok((await grainRows(page)).some(cell=>cell.angle===47.5));
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
  await assertExportMatchesPreview(page, exportedToolpaths(code));
  assert.deepEqual([...code.matchAll(/^; LAYER \d+ model-layer=\d+ Z=([\d.]+)$/gm)].map(match => +match[1]), [0.3, 0.6, 0.9]);
  const strokes = code.split("; STROKE\n").slice(1);
  assert.ok(strokes.length > 1000);
  const originalExtrusions = await page.evaluate(() => [...model.grids].reverse().flatMap(grid =>
    [...grid].sort((a,b) => a.angle%180-b.angle%180).flatMap(cell =>
    Grain3D.planPrint({ ...model, grids: [[cell]], merge: false }, 0.6).layers[0].tracks.map(track =>
      (track.volume / (Math.PI * (1.75 / 2) ** 2)).toFixed(8)))));
  assert.deepEqual(extrusions(code),originalExtrusions);
  for (const stroke of strokes) {
    assert.match(stroke, /^G0 Z.*\nG0 X.*\nG0 Z.*\n(?:G1 E0\.6.*\n)?G1 X.*\nG1 E-0\.6/m);
    assert.equal((stroke.match(/^G1 X/gm) ?? []).length, 1);
    assert.ok(+stroke.match(/^G1 X[^\n]+ E([\d.]+)/m)[1] > 0);
  }

  const sharedEdges = new Map();
  for (const row of outlines) {
    const [layer, , , , group, , slot] = row.split(",");
    const points = row.match(/"([^"]+)"/)[1].split(" ");
    const edges = points.map((point, i) => [point, points[(i + 1) % points.length]]);
    const world = point => point.split(",").map(Number);
    for (const edge of edges) {
      if (edge[0] === edge[1]) continue;
      const key = `${layer}:${edge.slice().sort().join(";")}`;
      if (!sharedEdges.has(key)) sharedEdges.set(key, []);
      const [a,b]=edge.map(world);
      if (Math.hypot(b[0]-a[0],b[1]-a[1])>1e-5) sharedEdges.get(key).push(`${layer}:${group}:${slot}`);
    }
  }
  const roads = gcodeGrains(code);
  let joins = 0;
  for (const edges of sharedEdges.values()) {
    if (edges.length !== 2 || !edges.every(id => roads.has(id))) continue;
    const [first, second] = edges.map(id => roads.get(id));
    assert.ok(first.some(a => second.some(b => footprintsOverlap(a,b))), `overlap at ${edges.join(" / ")}`);
    joins++;
  }
  assert.equal(joins,717);

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
    const retained = await liveBuffers();
    assert.ok(retained <= baseline + 3);
    assert.equal(await page.evaluate(() => window.gpu.allocated), allocated + retained);
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
  assert.equal(await liveBuffers(), baseline);
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
  const merge = await page.locator("#mergeGrains").boundingBox();
  const tools = await page.locator(".tools").boundingBox();
  assert.ok(merge.y + merge.height < tools.y);
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
  let resetView = await snapshot(page);
  for (let attempt = 0; resetView !== initial && attempt < 4; attempt++) resetView = await snapshot(page);
  assert.equal(resetView, initial);

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
  await page.locator("#printNote").filter({ hasText: /[1-9]\d* strokes/ }).waitFor({ timeout: 5000 });
  assert.match(await page.locator("#printNote").textContent(), /Printed toolpaths/);
  assert.match(await page.locator("#printNote").textContent(), /0\.3 mm layer/);
  await nextDraw(page, () => input.fill("0.8"));
  assert.match(await page.locator("#printNote").textContent(), /0\.4 mm layer/);
  await nextDraw(page, () => input.fill("0.6"));
  const defaultPrint = await snapshot(page);
  await page.locator("#layer").selectOption("1");
  await page.locator("#layer").selectOption("0");
  await nextDraw(page, () => input.fill("6"));
  await page.locator("#printNote").filter({ hasText: "0 strokes" }).waitFor({ timeout: 5000 });
  assert.notEqual(await snapshot(page), defaultPrint);
  await input.fill("");
  await page.locator("#printError").waitFor({ state: "visible" });
  assert.equal(await page.locator("#csv").isEnabled(), true);
  await nextDraw(page, () => input.fill("0.6"));
  await page.locator("#printNote").filter({ hasText: /[1-9]\d* strokes/ }).waitFor({ timeout: 5000 });
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
