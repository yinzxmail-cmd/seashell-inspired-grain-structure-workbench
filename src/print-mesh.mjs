import {
  BufferAttribute, BufferGeometry, Color, DataTexture, Float32BufferAttribute,
  Group, InstancedMesh, LineSegments, LinearFilter, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3,
} from "three";

function crossSection(width, height, steps) {
  const half = height / 2, flat = (width - height) / 2;
  const profile = [];
  for (const side of [1, -1]) {
    for (let i = 0; i <= steps; i++) {
      const theta = side * Math.PI * (i / steps - 0.5);
      const up = Math.sin(theta), across = side * Math.cos(theta);
      const z = side * flat + half * across;
      profile.push({ t: (z + width / 2) / width, y: half * (1 + up), up, across, side });
    }
  }
  return profile;
}

export function printProfile(width, height, strandCount) {
  return crossSection(width, height, strandCount <= 1500 ? 8 : strandCount <= 10000 ? 6 : strandCount <= 45000 ? 4 : 2);
}

export function profileFraction(sample, width, height) {
  if (width === undefined) return sample.t;
  return (sample.side * (width - height) + sample.across * height + width) / (2 * width);
}

export function strandIndices(ring, splitCaps = false) {
  const indices = [];
  for (let i = 0; i < ring; i++) {
    const next = (i + 1) % ring;
    indices.push(i, i + ring, next + ring, i, next + ring, next);
  }
  const start = splitCaps ? 2 * ring : 0;
  const end = start + ring;
  for (let i = 1; i < ring - 1; i++) {
    indices.push(start, start + i, start + i + 1, end, end + i + 1, end + i);
  }
  return indices;
}

function strandGeometry(tracks, profile, bottom, model, scale, height) {
  const ring = profile.length;
  const vertices = tracks.length * ring * 4;
  const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const rgb = new Color();
  const IndexArray = vertices > 65535 ? Uint32Array : Uint16Array;
  const strand = strandIndices(ring, true);
  const indices = new IndexArray(tracks.length * strand.length);
  const x = value => (value - model.width / 2) * scale;
  const z = value => (value - model.height / 2) * scale;
  tracks.forEach(({ angle, startFace, endFace, color, width }, i) => {
    rgb.set(color ?? 0xdf8b49);
    const rad = angle * Math.PI / 180;
    const normalX = Math.sin(rad), normalZ = Math.cos(rad);
    const first = i * ring * 4;
    [startFace, endFace].forEach(([[ax, az], [bx, bz]], end) => {
      const dx = bx - ax, dz = bz - az;
      const sign = end ? 1 : -1;
      const length = Math.hypot(dx, dz);
      const capX = sign * dz / length, capZ = -sign * dx / length;
      for (const [j, sample] of profile.entries()) {
        const { y, up, across } = sample;
        const t = profileFraction(sample,width,height);
        const side = (first + end * ring + j) * 3;
        const face = side + ring * 6;
        const px = x(ax + dx * t), py = bottom + y * scale, pz = z(az + dz * t);
        positions[side] = positions[face] = px;
        positions[side + 1] = positions[face + 1] = py;
        positions[side + 2] = positions[face + 2] = pz;
        normals[side] = normalX * across;
        normals[side + 1] = up;
        normals[side + 2] = normalZ * across;
        normals[face] = capX;
        normals[face + 2] = capZ;
        colors[side] = colors[face] = rgb.r;
        colors[side + 1] = colors[face + 1] = rgb.g;
        colors[side + 2] = colors[face + 2] = rgb.b;
      }
    });
    for (const [j, index] of strand.entries()) indices[i * strand.length + j] = first + index;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

function repeatedRoadMesh(tracks, profile, width, bottom, model, scale, material) {
  const half=width/2;
  const template={ angle:0, startFace:[[0,-half],[0,half]], endFace:[[1,-half],[1,half]], color:0xffffff };
  const geometry=strandGeometry([template],profile,0,{width:0,height:0},1);
  const mesh=new InstancedMesh(geometry,material,tracks.length);
  const position=new Vector3(), stretch=new Vector3(), up=new Vector3(0,1,0);
  const rotation=new Quaternion(), transform=new Matrix4(), tint=new Color();
  for (const [i,{start,end,color,width:trackWidth}] of tracks.entries()) {
    const dx=end[0]-start[0],dz=end[1]-start[1];
    position.set((start[0]-model.width/2)*scale,bottom,(start[1]-model.height/2)*scale);
    stretch.set(Math.hypot(dx,dz)*scale,scale,scale*(trackWidth??width)/width);
    rotation.setFromAxisAngle(up,-Math.atan2(dz,dx));
    mesh.setMatrixAt(i,transform.compose(position,rotation,stretch));
    mesh.setColorAt(i,tint.set(color??0xdf8b49));
  }
  mesh.frustumCulled=false;
  return mesh;
}

export function printShadowMaterial() {
  const size = 64, pixels = new Uint8Array(size ** 2 * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(0, Math.abs(2 * (x + 0.5) / size - 1) - 0.68);
      const dy = Math.max(0, Math.abs(2 * (y + 0.5) / size - 1) - 0.68);
      const strength = Math.round(255 * Math.max(0, 1 - Math.hypot(dx, dy) / 0.31) ** 2);
      pixels.set([strength, strength, strength, 255], (y * size + x) * 4);
    }
  }
  const alphaMap = new DataTexture(pixels, size, size);
  alphaMap.magFilter = alphaMap.minFilter = LinearFilter;
  alphaMap.needsUpdate = true;
  return new MeshBasicMaterial({ alphaMap, color: 0x3d3025, transparent: true, opacity: 0.24, depthWrite: false });
}

export function addPrintLayers(group, plan, model, scale, materials) {
  const { width, height, pitch, stackHeight, layers } = plan;
  const visible = layers.map(layer => layer.tracks.flatMap(track => track.colorParts ?? [track]));
  const count = visible.reduce((total, tracks) => total + tracks.length, 0);
  const profile = printProfile(width, height, count);
  const x = value => (value - model.width / 2) * scale;
  const z = value => (value - model.height / 2) * scale;

  for (const [index, { gaps }] of layers.entries()) {
    const tracks = visible[index];
    const layer = new Group();
    group.add(layer);
    const bottom = (stackHeight / 2 - index * pitch - height) * scale;
    if (tracks.length) {
      layer.add(plan.deposited&&count>12000
        ? repeatedRoadMesh(tracks,profile,width,bottom,model,scale,materials.road[0])
        : new Mesh(strandGeometry(tracks,profile,bottom,model,scale,height),materials.road[0]));
    }
    if (gaps.length) {
      const positions = [];
      const y = bottom + height * scale * 0.51;
      for (const [a, b] of gaps) positions.push(x(a[0]), y, z(a[1]), x(b[0]), y, z(b[1]));
      const lines = new BufferGeometry();
      lines.setAttribute("position", new Float32BufferAttribute(positions, 3));
      layer.add(new LineSegments(lines, materials.gap[0]));
    }
  }
  if (count) {
    const shadow = new Mesh(new PlaneGeometry(model.width * scale * 1.16, model.height * scale * 1.18), materials.shadow[0]);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = (-stackHeight / 2 - width * 0.025) * scale;
    shadow.renderOrder = -1;
    group.userData.shadow = shadow;
    group.add(shadow);
  }
}
