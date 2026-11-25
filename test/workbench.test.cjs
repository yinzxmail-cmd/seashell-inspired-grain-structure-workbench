const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright");

const url = pathToFileURL(path.resolve(__dirname, "../index.html")).href;
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
    const draw = proto.drawElements;
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
    proto.drawElements = function (...args) {
      if (window.gpu.failNextDraw) {
        window.gpu.failNextDraw = false;
        throw Error("Injected draw failure");
      }
      window.gpu.draws++;
      return draw.apply(this, args);
    };
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
  // Exclude the controls and the parameter panel from pixel comparisons.
  const pixels = await page.screenshot({ clip: { x: x + 25, y: y + 100,
    width: width - 100, height: height - 220 } });
  return createHash("sha256").update(pixels).digest("hex");
}

async function download(page, id) {
  const [result] = await Promise.all([page.waitForEvent("download"), page.locator(id).click()]);
  return fs.readFile(await result.path(), "utf8");
}

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

test("SVG views remain available when WebGL initialization fails", async t => {
  const page = await openWorkbench(t, { webglUnavailable: true });
  await page.goto(url);
  await page.locator('#interactive[data-status="error"]').waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.locator("#canvas polygon").first().waitFor();
  const svg = await download(page, "#svg");
  assert.match(svg, /<polygon/);
  await page.getByRole("button", { name: "Isometric", exact: true }).click();
  assert.match(await download(page, "#svg"), /depth-shadow/);
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
  for (const name of ["Top", "Isometric", "3D"]) {
    await page.getByRole("button", { name, exact: true }).click({ timeout: 5000 });
    assert.equal(await download(page, "#csv"), csv);
    if (name === "Isometric") assert.equal(await download(page, "#svg"), isometric);
  }
});

test("the 3D model and every view button remain unobstructed at tablet width", async t => {
  const page = await openWorkbench(t, { viewport: { width: 768, height: 800 } });
  await page.goto(url);
  await ready(page);
  const buttons = page.locator(".viewer-actions .tabs button");
  for (const button of await buttons.all()) await button.click({ trial: true, timeout: 1500 });
  await page.locator("#togglePanel").click();
  for (const button of await buttons.all()) await button.click({ trial: true, timeout: 1500 });
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
