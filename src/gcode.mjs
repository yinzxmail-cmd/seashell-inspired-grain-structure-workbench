import { placeStrands } from "./print-paths.mjs";

const STROKE_LIMIT = 250000;
const EPS = 1e-8;
const orientation = angle => angle % 180;
const pointKey = point => point.map(value => Math.round(value * 1e6)).join(",");
const cutEdges = points => points.map((a, i) => [a, points[(i + 1) % points.length]]);

function boundary([a, b]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length > EPS ? { a, x: -dy / length, y: dx / length } : null;
}

function localFrame(angle) {
  const rad = orientation(angle) * Math.PI / 180;
  const cos = Math.cos(rad), sin = -Math.sin(rad);
  return {
    along: ([x, y]) => cos * x + sin * y,
    across: ([x, y]) => -sin * x + cos * y,
    world: (u, v) => [cos * u - sin * v, sin * u + cos * v],
  };
}

function interval(walls, offset, width, clearance, overlap, join = false) {
  let min = -Infinity, max = Infinity;
  for (const wall of walls) {
    const padding = wall.outer ? 0 : overlap && wall.overlap ? -wall.overlap : clearance;
    const margin = join && wall.neighbor !== undefined ? 0 : Math.abs(wall.v) * width / 2 + padding;
    const need = wall.intercept + margin - wall.v * offset;
    if (wall.u > EPS) min = Math.max(min, need / wall.u);
    else if (wall.u < -EPS) max = Math.min(max, need / wall.u);
    else if (need > EPS) return null;
  }
  return max - min > 0.01 ? [min, max] : null;
}

function grainLayout(cell, width, footprint) {
  const frame = localFrame(cell.angle);
  function wallInFrame(edge, outer) {
    const wall = boundary(edge);
    if (!wall) return null;
    const u = frame.along([wall.x, wall.y]), v = frame.across([wall.x, wall.y]);
    return { u, v, intercept: wall.x * wall.a[0] + wall.y * wall.a[1], key: edge.map(pointKey).sort().join(":"), overlap: 0, outer };
  }
  const sides = cutEdges(cell.points).map(edge => wallInFrame(edge, false)).filter(Boolean);
  const walls = [...sides, ...footprint.map(edge => wallInFrame(edge, true)).filter(Boolean)];
  const clearance = width * 0.05;
  const original = placeStrands(cell.points, cell.angle, width, 1, 0).tracks;
  const rows = original.flatMap(({ start }) => {
    const offset = frame.across(start);
    const fit = interval(sides, offset, width, clearance, false);
    return fit ? [{ offset, start: fit[0], end: fit[1] }] : [];
  }).sort((a, b) => a.offset - b.offset);
  return { cell, frame, sides, walls, rows };
}

const beadArea = (width, height) => (width - height) * height + Math.PI * (height / 2) ** 2;

function road(frame, min, max, offset, width, angle, color, volume) {
  const face = x => [frame.world(x, offset - width / 2), frame.world(x, offset + width / 2)];
  return { start:frame.world(min,offset),end:frame.world(max,offset),startFace:face(min),endFace:face(max),width,angle,color,volume };
}

function orientedTrack(layout, row, offset, width) {
  const { frame, walls, cell } = layout;
  const height = width / 2;
  const length = row.end - row.start;
  const area = beadArea(width, height);
  let min = row.start, max = row.end, actualWidth = width;
  let adjusted = interval(walls, offset, width, width * 0.05, true);
  if (!adjusted || adjusted[1] - adjusted[0] < length - EPS) {
    // Near an exterior corner a full sideways shift may shorten the road. Retain the
    // furthest feasible part of that shift, so its original extrusion still fits.
    let low = 0, high = 1;
    adjusted = interval(walls, row.offset, width, width * 0.05, true);
    for (let i = 0; i < 8 && offset !== row.offset; i++) {
      const step = (low + high) / 2;
      const candidate = interval(walls, row.offset + step * (offset - row.offset), width, width * 0.05, true);
      if (candidate && candidate[1] - candidate[0] >= length - EPS) { low = step; adjusted = candidate; }
      else high = step;
    }
    offset = row.offset + low * (offset - row.offset);
  }
  if (adjusted && adjusted[1] - adjusted[0] >= length - EPS) {
    // Preserve each original road's extrusion volume. Bound its growth to keep a full bead.
    const span = Math.min(adjusted[1] - adjusted[0], length * 1.42);
    const center = (row.start + row.end) / 2;
    min = Math.max(adjusted[0], Math.min(center - span / 2, adjusted[1] - span));
    max = min + span;
    actualWidth = area * length / (span * height) + height * (1 - Math.PI / 4);
  } else {
    offset = row.offset;
  }
  return road(frame,min,max,offset,actualWidth,cell.angle,cell.color,area*length);
}

function roadOffset(sides, row, index, length, width) {
  let edgeOffset = row.offset;
  let adjustment = Infinity;
  for (const wall of sides) {
    // A road nearly parallel to a shared edge overlaps by moving sideways.
    if (!wall.overlap || Math.abs(wall.u) > 0.50 + EPS) continue;
    if ((wall.v > 0 && index !== 0) || (wall.v < 0 && index !== length - 1)) continue;
    const center = (row.start + row.end) / 2;
    const target = (wall.intercept - wall.u * center) / wall.v + Math.sign(wall.v) * width * 0.18;
    const shift = target - row.offset;
    if (shift * wall.v < 0 && Math.abs(shift) < adjustment) {
      edgeOffset = target;
      adjustment = Math.abs(shift);
    }
  }
  return Math.max(row.offset - width * 0.95, Math.min(row.offset + width * 0.95, edgeOffset));
}

function collectRuns(active, offset, width, clearance) {
  const spans = new Map();
  for (const layout of active) {
    const fit = interval(layout.walls,offset,width,clearance,true,true);
    if (fit) spans.set(layout.index,{layout,start:fit[0],end:fit[1],color:layout.cell.color});
  }
  const seen = new Set(), runs = [];
  for (const [index, span] of spans) {
    if (seen.has(index)) continue;
    seen.add(index);
    const pieces=[span];
    let min=span.start, max=span.end;
    for(let i=0;i<pieces.length;i++){
      const piece=pieces[i];
      for(const {neighbor} of piece.layout.sides){
        const next=spans.get(neighbor);
        if(!next||seen.has(neighbor)||piece.end+EPS<next.start||next.end+EPS<piece.start) continue;
        pieces.push(next);
        seen.add(neighbor);
        min=Math.min(min,next.start);
        max=Math.max(max,next.end);
      }
    }
    runs.push({min,max,offset,pieces});
  }
  return runs;
}

function scanRegion(layouts, pitch, phase, width, clearance, padding) {
  const bottom=layouts[0].low, top=layouts.reduce((end,layout)=>Math.max(end,layout.high),-Infinity);
  const middle=(bottom+top)/2;
  let offset=middle+(phase-Math.floor((middle-bottom)/pitch+phase))*pitch;
  let next=0, active=[], length=0, joined=0;
  const runs=[];
  for(;offset<=top+EPS;offset+=pitch){
    while(next<layouts.length&&layouts[next].low<=offset+padding) active.push(layouts[next++]);
    active=active.filter(layout=>layout.high>=offset-padding);
    for(const run of collectRuns(active,offset,width,clearance)){
      length+=run.max-run.min;
      if(run.pieces.some(piece=>piece.end-piece.start<run.max-run.min-EPS)) joined++;
      runs.push(run);
      if(runs.length>STROKE_LIMIT) return null;
    }
  }
  return {runs,length,joined};
}

function planRegion(layouts, width) {
  const height=width/2, area=beadArea(width,height);
  const volume=layouts.reduce((sum,layout)=>sum+layout.rows.reduce((total,row)=>total+(row.end-row.start)*area,0),0);
  if(!volume) return null;
  const {frame,cell}=layouts[0];
  for(const layout of layouts){
    const span=layout.cell.points.map(frame.across);
    layout.low=Math.min(...span);
    layout.high=Math.max(...span);
  }
  const ordered=[...layouts].sort((a,b)=>a.low-b.low);
  const clearance=width*0.05, padding=width*0.42;
  let best;
  // Each candidate uses a common pitch and phase. The fitted bead must stay
  // inside its planning width, and the whole region keeps its original volume.
  for(const scale of [1.10,1.02,0.94,0.86,1.20,1.30]){
    const pitch=width*scale, guard=Math.min(width,pitch-width*0.04);
    for(const phase of [0.5,0]){
      const scan=scanRegion(ordered,pitch,phase,guard,clearance,padding);
      if(!scan?.length) continue;
      const actual=volume/(scan.length*height)+height*(1-Math.PI/4);
      if(actual>guard+EPS||actual<height-EPS) continue;
      const unusedWidth=width-actual;
      if(!best||Boolean(scan.joined)>Boolean(best.joined)||
        (Boolean(scan.joined)===Boolean(best.joined)&&unusedWidth<best.unusedWidth)){
        best={...scan,actual,unusedWidth};
      }
    }
    if(best?.joined&&best.unusedWidth<width*0.025) break;
  }
  if(!best) return null;
  const angle=orientation(cell.angle);
  const tracks=best.runs.map(({min,max,offset,pieces})=>{
    const first=pieces[0].color;
    const track=road(frame,min,max,offset,best.actual,angle,first,volume*(max-min)/best.length);
    if(pieces.some(piece=>piece.color!==first)){
      let covered=min;
      track.colorParts=[];
      for(const piece of pieces.sort((a,b)=>a.start-b.start)){
        if(piece.end<=covered+EPS) continue;
        track.colorParts.push(road(frame,covered,piece.end,offset,best.actual,angle,piece.color,0));
        covered=piece.end;
      }
    }
    return track;
  });
  return {tracks,joinedStrokes:best.joined};
}

export function* planGcodeLayer(cells, width, merge = false) {
  const shared = new Map();
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [index,cell] of cells.entries()) {
    for (const [a,b] of cutEdges(cell.points)) {
      minX=Math.min(minX,a[0]); minY=Math.min(minY,a[1]);
      maxX=Math.max(maxX,a[0]); maxY=Math.max(maxY,a[1]);
      if (pointKey(a) === pointKey(b)) continue;
      const key=[pointKey(a),pointKey(b)].sort().join(":");
      if (!shared.has(key)) shared.set(key, new Set());
      shared.get(key).add(index);
    }
  }
  const footprint=cutEdges([[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]]);
  const pending = new Map(), printable = [];
  function getLayout(index) {
    if (!pending.has(index)) {
      const layout=grainLayout(cells[index],width,footprint);
      layout.index=index;
      pending.set(index,layout);
      printable[index]=layout.rows.length>0;
    }
    return pending.get(index);
  }
  function prepare(layout, join) {
    let matchingEdges=0;
    for(const wall of layout.sides){
      const neighbors=shared.get(wall.key);
      if(neighbors?.size!==2) continue;
      const other=[...neighbors].find(i=>i!==layout.index);
      const matching=orientation(layout.cell.angle)===orientation(cells[other].angle);
      if(join&&matching){
        wall.neighbor=other;
        matchingEdges++;
      }else{
        if(printable[other]===undefined) getLayout(other);
        if(printable[other]) wall.overlap=width*0.42;
      }
    }
    return matchingEdges;
  }
  function individual(layout) {
    const {cell,rows,sides}=layout;
    prepare(layout,false);
    const tracks=rows.map((row,i)=>orientedTrack(layout,row,roadOffset(sides,row,i,rows.length,width),width));
    return {cell,cells:[cell],tracks,matchingEdges:0,joinedStrokes:0};
  }
  const visited=new Set();
  for (let index=0;index<cells.length;index++) {
    if(visited.has(index)) continue;
    const layout=getLayout(index);
    if(!merge){
      const entry=individual(layout);
      pending.delete(index);
      yield entry;
      continue;
    }
    const component=[layout];
    let matchingEdges=0;
    visited.add(index);
    for(let i=0;i<component.length;i++){
      const member=component[i];
      matchingEdges+=prepare(member,true);
      for(const {neighbor} of member.sides){
        if(neighbor===undefined||visited.has(neighbor)) continue;
        visited.add(neighbor);
        component.push(getLayout(neighbor));
      }
    }
    const region=component.length>1?planRegion(component,width):null;
    if(region){
      for(const member of component) pending.delete(member.index);
      yield {cell:layout.cell,cells:component.map(member=>member.cell),...region,matchingEdges:matchingEdges/2};
    }else{
      for(const [i,member] of component.entries()){
        const entry=individual(member);
        pending.delete(member.index);
        yield {...entry,matchingEdges:i===0?matchingEdges/2:0};
      }
    }
  }
}

function planLayer(cells,width,merge,limit) {
  const byAngle=new Map(), gaps=[];
  let count=0, matchingEdges=0, joinedStrokes=0;
  for(const entry of planGcodeLayer(cells,width,merge)){
    matchingEdges+=entry.matchingEdges;
    joinedStrokes+=entry.joinedStrokes;
    for(const track of entry.tracks) count+=track.colorParts?.length??1;
    if(count>limit) return null;
    if(entry.tracks.length){
      const angle=orientation(entry.cell.angle);
      if(!byAngle.has(angle)) byAngle.set(angle,[]);
      byAngle.get(angle).push(entry);
    }else for(const [a,b] of cutEdges(entry.cell.points)){
      if(boundary([a,b])) gaps.push([a,a.map((value,axis)=>value+0.45*(b[axis]-value))]);
    }
  }
  return {orientations:[...byAngle].sort(([a],[b])=>a-b),gaps,count,matchingEdges,joinedStrokes};
}

export function planDeposits(model, width) {
  const height = width / 2;
  const layers = [];
  let count = 0;
  for (const cells of model.grids) {
    const layer=planLayer(cells,width,model.merge,STROKE_LIMIT-count);
    if(!layer) return null;
    count+=layer.count;
    const {orientations,gaps,matchingEdges,joinedStrokes}=layer;
    const tracks=orientations.flatMap(([,entries])=>entries.flatMap(entry=>entry.tracks));
    layers.push({tracks,gaps,matchingEdges,joinedStrokes});
  }
  return { width, height, pitch: height, stackHeight: height * layers.length, layers, deposited: true };
}

const format = value => Number(value.toFixed(5)).toString();

export function exportGcode(model, width, settings) {
  const { hotend, bed, filament, bedX, bedY, bedZ } = settings;
  if (![width, hotend, bed, filament, bedX, bedY, bedZ].every(Number.isFinite) ||
      width < 0.01 || filament < 1 || filament > 4 || hotend < 170 || hotend > 300 ||
      bed < 0 || bed > 120 || Math.min(bedX, bedY, bedZ) < 1) {
    throw Error("Check the filament diameter, temperatures, and printer build dimensions.");
  }
  const height = width / 2;
  const zHop = 0.3;
  const margin = 5;
  if (model.width + 2 * margin > bedX || model.height + 2 * margin > bedY ||
      model.grids.length * height + zHop > bedZ) throw Error("The specimen does not fit the configured build volume.");
  const extrusionArea = beadArea(width, height);
  const filamentArea = Math.PI * (filament / 2) ** 2;
  const extrusionSpeed = Math.max(1, Math.min(1500, Math.floor(180 / extrusionArea)));
  const xy = ([x, y]) => `X${format(x + margin)} Y${format(model.height - y + margin)}`;
  const code = ["; Grain Structure Workbench", "; Marlin-compatible, positive XY bed origin, single extruder",
    `; Width ${format(width)} mm; layer height ${format(height)} mm`,
    "G21", `M140 S${bed}`, "G28", "G90", "M83", "M200 D0", `M190 S${bed}`, `M109 S${hotend}`, "G92 E0"];
  let count = 0, planned = 0;
  for (let index = model.grids.length - 1; index >= 0; index--) {
    const layer = model.grids.length - index;
    const z = layer * height;
    const plan=planLayer(model.grids[index],width,model.merge,STROKE_LIMIT-planned);
    if(!plan) throw Error("Too many G-code strokes. Reduce the specimen size or increase strand width.");
    if(!plan.count) throw Error(`Layer ${index + 1} has no full-width strokes. Restore grains on that layer or reduce the strand width.`);
    planned+=plan.count;
    code.push(`; LAYER ${layer} model-layer=${index + 1} Z=${format(z)}`);
    for(const [angle,entries] of plan.orientations){
      code.push(`; ORIENTATION angle=${angle}`);
      for(const {cell,cells,tracks} of entries){
        code.push(cells.length>1?`; REGION grains=${cells.length} angle=${angle}`:
          `; GRAIN group=${cell.group} slot=${cell.slot} angle=${cell.angle}`);
        for(const {start:a,end:b,volume} of tracks){
          const extrusion=volume/filamentArea;
          code.push("; STROKE",`G0 Z${format(z+zHop)} F600`,`G0 ${xy(a)} F4800`,`G0 Z${format(z)} F600`);
          if(count>0) code.push("G1 E0.6 F1500");
          code.push(`G1 ${xy(b)} E${extrusion.toFixed(8)} F${extrusionSpeed}`,"G1 E-0.6 F1500");
          count++;
        }
      }
    }
  }
  if (count === 0) throw Error("No full-width strokes fit. Reduce the strand width before exporting.");
  code.push(`G0 Z${format(model.grids.length * height + zHop)} F600`, "M400", "M104 S0", "M140 S0", "M107", "M84");
  return code.join("\n") + "\n";
}
