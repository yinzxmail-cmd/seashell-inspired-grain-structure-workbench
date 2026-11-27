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
    const [layer, sequence, layout, , , style, , angle, x, y] = row.split(",");
    return { layer: +layer, sequence: +sequence, layout, style, angle: +angle, x: +x, y: +y };
  });
}

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
  assert.equal(await page.locator("#cellAngle").isVisible(), false);
  await page.locator("#pointUnitCustom").click();
  await clickGrain();
  await page.locator("#cellAngle").waitFor();

  await page.getByRole("button", { name: "Plane Programming", exact: true }).click();
  await page.locator("#faceUnitCustom").click({ timeout: 4000 });
  const before = await grainRows(page);
  await clickGrain();
  const angle = page.locator("#cellAngle");
  await angle.selectOption((await angle.inputValue()) === "150" ? "30" : "150");
  const after = await grainRows(page);
  const changed = after.filter((cell, i) => cell.angle !== before[i].angle);
  assert.deepEqual(changed.map(cell => cell.layer), [1, 2, 3]);
  await page.locator("#faceUnitCycle").click();
  assert.deepEqual(await grainRows(page), before);
  await page.locator("#faceUnitCustom").click();
  assert.deepEqual(await grainRows(page), after);
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
    assert.ok((await fs.stat(await file.path())).size > 1000);
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
  // The default export from main at a547b85, including 297 cells and their clipped polygons.
  assert.equal(createHash("sha256").update(csv).digest("hex"),
    "437a76f227743bd76addb14807aeed83d0497a0f382af5a099d4cbad0a17b3c6");
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
  assert.match(await page.locator("#printNote").textContent(), /0\.06 mm gap/);
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
