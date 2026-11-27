import {
  AmbientLight, BufferGeometry, Color, DataTexture, DirectionalLight, DoubleSide, Float32BufferAttribute,
  Group, LineBasicMaterial, LinearFilter, LinearMipmapLinearFilter, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial, PerspectiveCamera, Raycaster,
  RepeatWrapping, Scene, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { pickCell } from "./cell-picking.mjs";
import { addPrintLayers, printShadowMaterial } from "./print-mesh.mjs";
export { planPrint } from "./print-paths.mjs";
export { exportSTL, export3MF } from "./model-export.mjs";
export { exportGcode } from "./gcode.mjs";

const THICKNESS = 0.49;
// A small display gap keeps touching layer faces legible from oblique views.
const LAYER_PITCH = 0.53;

function stripeTexture() {
  const pixels = new Uint8Array(32 * 4);
  for (let i = 0; i < 32; i++) {
    const value = i < 5 ? 162 : 255;
    pixels.set([value, value, value, 255], i * 4);
  }
  const texture = new DataTexture(pixels, 1, 32);
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function layerGeometry(cells, layer, model, colors, height, scale) {
  const positions = [], normals = [], uvs = [], vertexColors = [], indices = [];
  const top = (height / 2 - layer * LAYER_PITCH * model.edge) * scale;
  const bottom = top - THICKNESS * model.edge * scale;
  const spacing = 0.21 * model.edge;
  function vertex([x, z], y, nx, ny, nz, color, stripe = 0.5) {
    positions.push((x - model.width / 2) * scale, y, (z - model.height / 2) * scale);
    normals.push(nx, ny, nz);
    uvs.push(0.5, stripe);
    vertexColors.push(color.r, color.g, color.b);
  }

  for (const { points, angle } of cells) {
    const { fill, wall, sin, cos } = colors[angle];
    const first = positions.length / 3;
    const count = points.length;
    for (const point of points) {
      const [x, z] = point;
      vertex(point, top, 0, 1, 0, fill, (x * sin + z * cos) / spacing);
    }
    for (const point of points) vertex(point, bottom, 0, -1, 0, wall);
    for (let i = 1; i < count - 1; i++) {
      indices.push(first, first + i + 1, first + i);
      indices.push(first + count, first + count + i, first + count + i + 1);
    }
    for (let i = 0; i < count; i++) {
      const a = points[i], b = points[(i + 1) % count];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 1e-10) continue;
      const nx = dz / length, nz = -dx / length;
      const side = positions.length / 3;
      vertex(a, top, nx, 0, nz, wall);
      vertex(b, top, nx, 0, nz, wall);
      vertex(b, bottom, nx, 0, nz, wall);
      vertex(a, bottom, nx, 0, nz, wall);
      indices.push(side, side + 1, side + 2, side, side + 2, side + 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new Float32BufferAttribute(vertexColors, 3));
  geometry.setIndex(indices);
  return geometry;
}

function disposeModel(group) {
  group.removeFromParent();
  group.traverse(object => object.geometry?.dispose());
  group.clear();
}

export function createPreview(host, palette, onStatus, onCellPicked) {
  const colors = Object.fromEntries(Object.entries(palette).map(([angle, color]) => {
    const radians = Number(angle) * Math.PI / 180;
    return [angle, { fill: new Color(color.fill), wall: new Color(color.wall),
      sin: Math.sin(radians), cos: Math.cos(radians) }];
  }));
  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.05, 30);
  const solidHome = new Vector3(1, 0.94, 1.13).normalize();
  const printHome = new Vector3(0.06, 0.37, 1).normalize();
  camera.position.copy(printHome).multiplyScalar(4);
  const target = new Vector3();
  const offset = new Vector3();
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const key = new DirectionalLight(0xffffff, 1.55);
  key.position.set(-2, 4, 3);
  const printFill = new DirectionalLight(0xfff3df, 0.7);
  printFill.position.set(1, 3, -3);
  scene.add(new AmbientLight(0xffffff, 1.15), key, printFill);

  let renderer, controls, canvas, group, materials, stack;
  let latest, latestPrint, builtModel, builtPrint, selected = 0, appliedLayer = -1;
  let selectedCell = null, outlinedCell = null, outline, press;
  let isolate = false, appliedIsolation = false;
  let visible = false, lost = false, failed = false, frame = null;
  let width = 0, height = 0, pixelRatio = 0, fitDistance = 0;
  let status;

  function report(next) {
    if (next === status) return;
    status = next;
    host.dataset.status = next;
    onStatus(next);
  }

  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function requestRender() {
    if (visible && renderer && !lost && !failed && frame === null) {
      frame = requestAnimationFrame(draw);
    }
  }

  function dropOutline() {
    if (outline) {
      disposeModel(outline);
      outline = null;
    }
    outlinedCell = null;
  }

  function drawOutline() {
    dropOutline();
    if (!selectedCell) return;
    const { top, pitch, scale } = stack;
    const cells = Array.isArray(selectedCell) ? selectedCell : [selectedCell];
    const positions = [];
    for (const { points, layer } of cells) {
      const y = (top - (layer - 1) * pitch) * scale;
      for (let i = 0; i < points.length; i++) {
        const [x, z] = points[i], [nextX, nextZ] = points[(i + 1) % points.length];
        if (x === nextX && z === nextZ) continue;
        positions.push((x - builtModel.width / 2) * scale, y, (z - builtModel.height / 2) * scale,
          (nextX - builtModel.width / 2) * scale, y, (nextZ - builtModel.height / 2) * scale);
      }
    }
    outline = new Group();
    const line = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), materials.outline[0]);
    line.renderOrder = 3;
    outline.add(line);
    if (cells.length === 1) {
      const { points, layer } = cells[0];
      const y = (top - (layer - 1) * pitch) * scale;
      const triangles = [];
      for (let i = 1; i < points.length - 1; i++) {
        for (const [x, z] of [points[0], points[i], points[i + 1]]) {
          triangles.push((x - builtModel.width / 2) * scale, y, (z - builtModel.height / 2) * scale);
        }
      }
      const fill = new BufferGeometry();
      fill.setAttribute("position", new Float32BufferAttribute(triangles, 3));
      const tint = new Mesh(fill, materials.outline[1]);
      tint.renderOrder = 2;
      outline.add(tint);
    }
    scene.add(outline);
    outlinedCell = selectedCell;
  }

  function pointerDown(event) {
    press = event.isPrimary && event.button === 0
      ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  }

  function pointerMove(event) {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) {
      press = null;
    }
  }

  function pointerUp(event) {
    pointerMove(event);
    const tapped = press?.id === event.pointerId;
    press = null;
    if (!tapped || status !== "ready" || builtModel !== latest || appliedLayer < 0) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(2 * (event.clientX - rect.left) / rect.width - 1,
      1 - 2 * (event.clientY - rect.top) / rect.height);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    const { origin, direction } = raycaster.ray;
    const { scale } = stack;
    const ray = {
      origin: { x: origin.x / scale + builtModel.width / 2, y: origin.y / scale,
        z: origin.z / scale + builtModel.height / 2 },
      direction,
    };
    const cell = pickCell(builtModel.grids, ray, { ...stack, active: appliedLayer, isolated: appliedIsolation });
    onCellPicked(cell, builtModel);
  }

  function cancelPress() { press = null; }

  const pointerEvents = {
    pointerdown: pointerDown, pointermove: pointerMove, pointerup: pointerUp,
    pointercancel: cancelPress, lostpointercapture: cancelPress,
  };

  function releaseModel() {
    dropOutline();
    if (group) disposeModel(group);
    group = builtModel = builtPrint = null;
    if (materials) {
      materials.solid[0].map.dispose();
      materials.shadow[0].alphaMap.dispose();
      for (const variants of Object.values(materials)) {
        for (const material of variants) material.dispose();
      }
      materials = null;
    }
  }

  function contextLost(event) {
    event.preventDefault();
    lost = true;
    cancelFrame();
    controls.enabled = false;
    // Remove dispose listeners from the old WebGL caches before Three.js restores them.
    releaseModel();
    report("lost");
  }

  function contextRestored() {
    lost = false;
    controls.enabled = visible;
    report("loading");
    requestRender();
  }

  function stopRenderer() {
    cancelFrame();
    releaseModel();
    if (controls) {
      target.copy(controls.target);
      controls.removeEventListener("change", requestRender);
      controls.dispose();
    }
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      for (const [type, handler] of Object.entries(pointerEvents)) canvas.removeEventListener(type, handler);
      canvas.remove();
    }
    if (renderer) {
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    }
    renderer = controls = canvas = null;
    cancelPress();
    lost = false;
    width = height = pixelRatio = 0;
  }

  function fail(error) {
    failed = true;
    stopRenderer();
    console.error("3D preview:", error);
    report("error");
  }

  function startRenderer() {
    report("loading");
    try {
      canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Interactive 3D grain structure");
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.debug.onShaderError = () => {
        throw Error("WebGL could not compile the 3D preview shader.");
      };
      canvas.addEventListener("webglcontextlost", contextLost);
      canvas.addEventListener("webglcontextrestored", contextRestored);
      for (const [type, handler] of Object.entries(pointerEvents)) canvas.addEventListener(type, handler);
      host.prepend(canvas);
      controls = new OrbitControls(camera, canvas);
      controls.target.copy(target);
      controls.enableDamping = false;
      controls.minDistance = 1.8;
      controls.maxTargetRadius = 0.55;
      controls.update();
      controls.addEventListener("change", requestRender);
      requestRender();
    } catch (error) {
      fail(error);
    }
  }

  function replaceModel() {
    if (!materials) {
      const map = stripeTexture();
      const fade = { transparent: true, opacity: 0.19, depthWrite: false };
      materials = {
        solid: [
          new MeshLambertMaterial({ map, vertexColors: true }),
          new MeshLambertMaterial({ map, vertexColors: true, ...fade }),
        ],
        road: [
          new MeshPhongMaterial({ color: 0xdf8b49, specular: 0xa37443, shininess: 30 }),
          new MeshPhongMaterial({ color: 0xdf8b49, specular: 0xa37443, shininess: 30, ...fade }),
        ],
        gap: [
          new LineBasicMaterial({ color: 0x34383e, transparent: true, opacity: 0.83, depthWrite: false }),
          new LineBasicMaterial({ color: 0x34383e, ...fade, opacity: 0.1 }),
        ],
        shadow: [printShadowMaterial()],
        outline: [
          new LineMaterial({ color: 0x24645e, linewidth: 3, depthTest: false, depthWrite: false, transparent: true }),
          new MeshBasicMaterial({ color: 0x34736c, opacity: 0.4, side: DoubleSide, transparent: true,
            depthTest: false, depthWrite: false }),
        ],
      };
    }
    const next = new Group();
    const stackHeight = latestPrint
      ? latestPrint.stackHeight
      : ((latest.grids.length - 1) * LAYER_PITCH + THICKNESS) * latest.edge;
    // Normalizing to a unit bounding sphere preserves the camera as dimensions change.
    const scale = 2 / Math.hypot(latest.width, stackHeight, latest.height);
    try {
      if (latestPrint) addPrintLayers(next, latestPrint, latest, scale, materials);
      else latest.grids.forEach((cells, layer) => {
        next.add(new Mesh(layerGeometry(cells, layer, latest, colors, stackHeight, scale), materials.solid[0]));
      });
    } catch (error) {
      disposeModel(next);
      throw error;
    }
    scene.add(next);
    if (group) disposeModel(group);
    dropOutline();
    group = next;
    stack = {
      scale, top: stackHeight / 2,
      pitch: latestPrint?.pitch ?? LAYER_PITCH * latest.edge,
      thickness: latestPrint?.height ?? THICKNESS * latest.edge,
    };
    builtModel = latest;
    builtPrint = latestPrint;
    printFill.visible = Boolean(latestPrint);
    host.dataset.display = latestPrint ? "print" : "solid";
    appliedLayer = -1;
  }

  function resize(nextWidth, nextHeight, nextRatio) {
    const aspect = nextWidth / nextHeight;
    const halfFov = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(aspect, 1));
    const framing = latestPrint && aspect >= 1 ? 0.92 : 1.08;
    const nextFit = framing / Math.sin(halfFov);
    const relativeDistance = fitDistance ? camera.position.distanceTo(controls.target) / fitDistance : 1;
    fitDistance = nextFit;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = nextRatio;
    controls.maxDistance = Math.max(controls.minDistance, fitDistance * 3);
    camera.aspect = aspect;
    camera.far = controls.maxDistance + 4;
    camera.updateProjectionMatrix();
    offset.subVectors(camera.position, controls.target).setLength(fitDistance * relativeDistance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    renderer.setDrawingBufferSize(width, height, pixelRatio);
  }

  function draw() {
    try {
      if (!latest || renderer.getContext().isContextLost()) return;
      const nextWidth = host.clientWidth, nextHeight = host.clientHeight;
      if (!nextWidth || !nextHeight) return;
      const nextRatio = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(4_000_000 / (nextWidth * nextHeight)));
      if (width !== nextWidth || height !== nextHeight || pixelRatio !== nextRatio) {
        resize(nextWidth, nextHeight, nextRatio);
      }
      if (latest !== builtModel || latestPrint !== builtPrint) replaceModel();
      if (appliedLayer !== selected || appliedIsolation !== isolate) {
        group.children.forEach((layer, i) => {
          if (layer === group.userData.shadow) {
            layer.visible = !isolate;
            return;
          }
          layer.visible = !isolate || i === selected;
          const state = Number(i < selected);
          layer.traverse(object => {
            if (object.isLineSegments) {
              object.material = materials.gap[state];
              object.visible = i <= selected;
            } else if (object.isMesh) {
              object.material = (builtPrint ? materials.road : materials.solid)[state];
            }
          });
        });
        appliedLayer = selected;
        appliedIsolation = isolate;
      }
      if (outlinedCell !== selectedCell) drawOutline();
      renderer.render(scene, camera);
      if (!renderer.getContext().isContextLost()) report("ready");
    } catch (error) {
      fail(error);
    } finally {
      frame = null;
    }
  }

  const observer = new ResizeObserver(requestRender);
  observer.observe(host);
  window.addEventListener("resize", requestRender);

  function resetView() {
    controls?.target.set(0, 0, 0);
    target.set(0, 0, 0);
    camera.position.copy(latestPrint ? printHome : solidHome).multiplyScalar(fitDistance || 4);
    controls?.update();
  }

  return {
    show(next) {
      visible = next;
      if (controls) controls.enabled = visible && !lost;
      if (!visible) cancelFrame();
      else if (!renderer && !failed) startRenderer();
      else requestRender();
    },
    update(model, layer, print = null, onlySelected = false, cell = null) {
      if (latest === model && selected === layer && latestPrint === print &&
        isolate === onlySelected && selectedCell === cell) return;
      const changedDisplay = Boolean(latestPrint) !== Boolean(print);
      latest = model;
      latestPrint = print;
      selected = layer;
      selectedCell = cell;
      isolate = onlySelected;
      if (changedDisplay) {
        width = height = fitDistance = 0;
        resetView();
      }
      requestRender();
    },
    zoom(factor) {
      if (!controls || lost) return;
      offset.subVectors(camera.position, controls.target).divideScalar(factor);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      requestRender();
    },
    reset() {
      if (!controls) return;
      resetView();
      requestRender();
    },
    retry() {
      stopRenderer();
      failed = false;
      if (visible) startRenderer();
    },
    dispose() {
      observer.disconnect();
      window.removeEventListener("resize", requestRender);
      visible = false;
      stopRenderer();
      latest = latestPrint = null;
    },
  };
}
