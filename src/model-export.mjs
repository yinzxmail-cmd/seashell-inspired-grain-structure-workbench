import { strToU8, Zip, ZipDeflate } from "three/addons/libs/fflate.module.js";
import { printProfile, profileFraction, strandIndices } from "./print-mesh.mjs";

const xml = '<?xml version="1.0" encoding="UTF-8"?>';
const modelPart = "3D/3dmodel.model";
const partTypes = xml + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const relationships = xml + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="model" Target="/' + modelPart +
  '" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';

function meshInfo(plan) {
  const count = plan.layers.reduce((sum, layer) => sum + layer.tracks.length, 0);
  if (!count) throw Error("No strands fit. Reduce the strand diameter before exporting.");
  const profile = printProfile(plan.width, plan.height, count);
  return { count, profile, indices: strandIndices(profile.length) };
}

function* strands(model, plan, profile) {
  for (const [layerIndex, layer] of plan.layers.entries()) {
    const bottom = (plan.layers.length - 1 - layerIndex) * plan.pitch;
    for (const { startFace, endFace, width } of layer.tracks) {
      const vertices = [];
      for (const [[ax, ay], [bx, by]] of [startFace, endFace]) {
        for (const sample of profile) {
          const t = profileFraction(sample,width,plan.height);
          const { y } = sample;
          // Rotate the preview's Y-up system into Z-up, retaining right-handed winding.
          vertices.push([ax + (bx - ax) * t, model.height - (ay + (by - ay) * t), bottom + y]);
        }
      }
      yield vertices;
    }
  }
}

function writeFacet(view, offset, a, b, c) {
  const [ux, uy, uz] = b.map((value, axis) => value - a[axis]);
  const [vx, vy, vz] = c.map((value, axis) => value - a[axis]);
  const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const length = Math.hypot(...normal);
  for (let i = 0; i < 3; i++) view.setFloat32(offset + i * 4, length ? normal[i] / length : 0, true);
  for (let i = 0; i < 3; i++) {
    const vertex = [a, b, c][i];
    for (let axis = 0; axis < 3; axis++) view.setFloat32(offset + 12 + 12 * i + 4 * axis, vertex[axis], true);
  }
}

export function exportSTL(model, plan) {
  const { count, profile, indices } = meshInfo(plan);
  const bytesPerStrand = indices.length / 3 * 50;
  const header = new Uint8Array(84);
  header.set(strToU8("Grain workbench - millimeters"));
  new DataView(header.buffer).setUint32(80, count * indices.length / 3, true);
  const chunks = [header];
  const batchSize = 512;
  let packed, written = 0;
  for (const vertices of strands(model, plan, profile)) {
    const batchIndex = written % batchSize;
    if (batchIndex === 0) {
      const buffer = new ArrayBuffer(Math.min(batchSize, count - written) * bytesPerStrand);
      chunks.push(buffer);
      packed = new DataView(buffer);
    }
    let offset = batchIndex * bytesPerStrand;
    for (let i = 0; i < indices.length; i += 3) {
      writeFacet(packed, offset, vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]);
      offset += 50;
    }
    written++;
  }
  return new Blob(chunks, { type: "model/stl" });
}

export function export3MF(model, plan) {
  const { count, profile, indices } = meshInfo(plan);
  const chunks = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    if (bytes.length) chunks.push(bytes);
  });
  for (const [name, content] of [["[Content_Types].xml", partTypes], ["_rels/.rels", relationships]]) {
    const file = new ZipDeflate(name);
    zip.add(file);
    file.push(strToU8(content), true);
  }
  const mesh = new ZipDeflate(modelPart, { level: 3 });
  zip.add(mesh);
  mesh.push(strToU8(xml +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model"><mesh><vertices>'));
  let batch = [];
  function flush() {
    if (batch.length) mesh.push(strToU8(batch.join("")));
    batch = [];
  }
  for (const vertices of strands(model, plan, profile)) {
    for (const [x, y, z] of vertices) {
      batch.push(`<vertex x="${x.toFixed(7)}" y="${y.toFixed(7)}" z="${z.toFixed(7)}"/>`);
    }
    if (batch.length >= 2048) flush();
  }
  flush();
  mesh.push(strToU8("</vertices><triangles>"));
  const verticesPerStrand = profile.length * 2;
  for (let strand = 0; strand < count; strand++) {
    const start = strand * verticesPerStrand;
    for (let i = 0; i < indices.length; i += 3) {
      batch.push(`<triangle v1="${start + indices[i]}" v2="${start + indices[i + 1]}" v3="${start + indices[i + 2]}"/>`);
    }
    if (batch.length >= 2048) flush();
  }
  flush();
  mesh.push(strToU8('</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'), true);
  zip.end();
  return new Blob(chunks, { type: "model/3mf" });
}
