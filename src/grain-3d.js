import {
  AmbientLight, BufferGeometry, Color, DataTexture, DirectionalLight, Float32BufferAttribute,
  Group, LinearFilter, LinearMipmapLinearFilter, Mesh,
  MeshLambertMaterial, PerspectiveCamera, RepeatWrapping, Scene, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  for (const mesh of group.children) mesh.geometry.dispose();
  group.clear();
}

export function createPreview(host, palette, onStatus) {
  const colors = Object.fromEntries(Object.entries(palette).map(([angle, color]) => {
    const radians = Number(angle) * Math.PI / 180;
    return [angle, { fill: new Color(color.fill), wall: new Color(color.wall),
      sin: Math.sin(radians), cos: Math.cos(radians) }];
  }));
  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.05, 30);
  const home = new Vector3(1, 0.94, 1.13).normalize();
  camera.position.copy(home).multiplyScalar(4);
  const target = new Vector3();
  const offset = new Vector3();
  const key = new DirectionalLight(0xffffff, 1.55);
  key.position.set(-2, 4, 3);
  scene.add(new AmbientLight(0xffffff, 1.15), key);

  let renderer, controls, canvas, group, materials;
  let latest, builtModel, selected = 0, appliedLayer = -1;
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

  function releaseModel() {
    if (group) disposeModel(group);
    group = builtModel = null;
    if (materials) {
      materials.opaque.map.dispose();
      materials.opaque.dispose();
      materials.faded.dispose();
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
      canvas.remove();
    }
    if (renderer) {
      renderer.dispose();
      if (!renderer.getContext().isContextLost()) renderer.forceContextLoss();
    }
    renderer = controls = canvas = null;
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
      materials = {
        opaque: new MeshLambertMaterial({ map, vertexColors: true }),
        faded: new MeshLambertMaterial({
          map, vertexColors: true, transparent: true, opacity: 0.19, depthWrite: false,
        }),
      };
    }
    const next = new Group();
    const stackHeight = ((latest.grids.length - 1) * LAYER_PITCH + THICKNESS) * latest.edge;
    // Normalizing to a unit bounding sphere preserves the camera as dimensions change.
    const scale = 2 / Math.hypot(latest.width, stackHeight, latest.height);
    try {
      latest.grids.forEach((cells, layer) => {
        next.add(new Mesh(layerGeometry(cells, layer, latest, colors, stackHeight, scale), materials.opaque));
      });
    } catch (error) {
      disposeModel(next);
      throw error;
    }
    scene.add(next);
    if (group) disposeModel(group);
    group = next;
    builtModel = latest;
    appliedLayer = -1;
  }

  function resize(nextWidth, nextHeight, nextRatio) {
    const aspect = nextWidth / nextHeight;
    const halfFov = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(aspect, 1));
    const nextFit = 1.08 / Math.sin(halfFov);
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
      if (latest !== builtModel) replaceModel();
      if (appliedLayer !== selected) {
        group.children.forEach((mesh, i) => { mesh.material = i < selected ? materials.faded : materials.opaque; });
        appliedLayer = selected;
      }
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

  return {
    show(next) {
      visible = next;
      if (controls) controls.enabled = visible && !lost;
      if (!visible) cancelFrame();
      else if (!renderer && !failed) startRenderer();
      else requestRender();
    },
    update(model, layer) {
      if (latest === model && selected === layer) return;
      latest = model;
      selected = layer;
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
      controls.target.set(0, 0, 0);
      camera.position.copy(home).multiplyScalar(fitDistance || 4);
      controls.update();
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
      latest = null;
    },
  };
}
