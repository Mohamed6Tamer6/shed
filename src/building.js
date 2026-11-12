import * as THREE from 'three';
import { gen, polyhaven, pbr, interior, tex } from './assets.js';
import { boxMetric, beamGeo, scaleUV, shadows, rng } from './util.js';

// Interior half-width (x) and half-depth (z), wall thickness, wall-top heights. Metres.
export const X = 2.1, Z = 1.7, T = 0.2;
export const H_BACK = 2.45, H_FRONT = 2.9;
export const DOOR = { x0: -1.75, x1: -0.25, h: 2.1 };
export const WINDOW = { z0: -1.3, z1: -0.45, y0: 1.7, y1: 2.25 };
export const GROUND_Y = -0.06;

const RUN = 2 * (Z + T);
const SLOPE = (H_FRONT - H_BACK) / RUN;
const ALPHA = Math.atan(SLOPE);
const WALL_TILE = 2.4;            // must match TILE_M in tools/make_textures.py
/** Height of the wall-top line at world z. */
export const wallTop = (z) => H_BACK + (z + Z + T) * SLOPE;

function rectShape(x0, y0, x1, y1) {
  const s = new THREE.Shape();
  s.moveTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1).closePath();
  return s;
}

/**
 * Extrudes a wall outline by the wall thickness and places it with an explicit basis.
 * The cap at local z=0 gets `inner` when innerCap is 0, otherwise the far cap does.
 */
function wall(shape, { ex, ez, origin, inner, outer, innerCap = 0 }) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 1 });
  const [caps, sides] = g.groups;
  g.clearGroups();
  g.addGroup(caps.start, caps.count / 2, innerCap === 0 ? 0 : 1);
  g.addGroup(caps.start + caps.count / 2, caps.count / 2, innerCap === 0 ? 1 : 0);
  g.addGroup(sides.start, sides.count, 1);
  scaleUV(g, 1 / WALL_TILE);
  const m = new THREE.Mesh(g, [inner, outer]);
  m.matrixAutoUpdate = false;
  m.matrix.makeBasis(ex, new THREE.Vector3(0, 1, 0), ez).setPosition(origin);
  return m;
}

function corrugatedSheet(x0, x1, z0, z1, uvOff, lift) {
  const PITCH = 0.076, AMP = 0.009, TILE = 1.6;
  const nx = Math.round(((x1 - x0) / PITCH) * 10);
  const pos = [], nor = [], uv = [], idx = [];
  for (let j = 0; j <= 1; j++) {
    const z = j ? z1 : z0;
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const ph = (x / PITCH) * Math.PI * 2;
      pos.push(x, AMP * Math.cos(ph) + lift, z);
      const slope = ((-AMP * Math.PI * 2) / PITCH) * Math.sin(ph);
      const l = Math.hypot(slope, 1);
      nor.push(-slope / l, 1 / l, 0);
      uv.push(x / TILE + uvOff[0], z / TILE + uvOff[1]);
    }
  }
  for (let i = 0; i < nx; i++) {
    const a = i, b = i + 1, c = i + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function buildShed() {
  const shed = new THREE.Group();
  const rand = rng(7);

  // ---- materials
  const wallIn = interior(pbr({ map: gen('wall_in_diff', 'hero'), normalMap: gen('wall_in_nor', 'hero'), arm: gen('wall_in_arm', 'aux') }, { normalScale: 1.2, color: 0xe6d8c9 }));
  const wallOut = pbr(polyhaven('grey_plaster_02'), { color: new THREE.Color(1.6, 1.52, 1.42) });   // the scan is darker than sun-bleached render
  const floorMat = interior(pbr(polyhaven('dirty_concrete', 'hero', 'hero'), { color: 0xf0e6d8, normalScale: 1.3 }));
  floorMat.userData.envBoost = 1.7;       // the floor sees far more sky through the door than the probe in mid-room does
  const sheetMaps = polyhaven('rusty_metal_sheet');
  const sheetTop = pbr({ ...sheetMaps, arm: null }, { color: 0xc3c8cc, roughnessMap: sheetMaps.arm, roughness: 0.62, metalness: 0.5, side: THREE.FrontSide, shadowSide: THREE.DoubleSide });
  const sheetUnder = interior(pbr({ ...sheetMaps, arm: null }, { color: 0xd2d2cc, roughnessMap: sheetMaps.arm, roughness: 0.75, metalness: 0.25, side: THREE.BackSide }));
  const woodMaps = polyhaven('rough_wood');
  const woodIn = interior(pbr(woodMaps, { color: 0xc49a78 }));
  const woodOut = pbr(woodMaps, { color: 0xb08a6c });
  const doorMat = pbr(polyhaven('distressed_painted_planks'), { color: new THREE.Color(1.35, 1.3, 1.22) });
  const iron = pbr({ map: tex('rusty_metal_05', 'Diffuse'), normalMap: tex('rusty_metal_05', 'nor_gl'), arm: tex('rusty_metal_05', 'arm') }, { color: 0x8a8078 });

  // ---- walls
  const X1 = new THREE.Vector3(1, 0, 0), Z1 = new THREE.Vector3(0, 0, 1);
  const back = wall(rectShape(-X - T, GROUND_Y, X + T, H_BACK + T * SLOPE), {
    ex: X1, ez: Z1, origin: new THREE.Vector3(0, 0, -Z - T), inner: wallIn, outer: wallOut, innerCap: 1,
  });
  const frontShape = new THREE.Shape();
  frontShape.moveTo(-X - T, GROUND_Y).lineTo(DOOR.x0, GROUND_Y).lineTo(DOOR.x0, DOOR.h).lineTo(DOOR.x1, DOOR.h).lineTo(DOOR.x1, GROUND_Y)
    .lineTo(X + T, GROUND_Y).lineTo(X + T, H_FRONT).lineTo(-X - T, H_FRONT).closePath();
  const front = wall(frontShape, { ex: X1, ez: Z1, origin: new THREE.Vector3(0, 0, Z), inner: wallIn, outer: wallOut, innerCap: 0 });

  // Side walls run between the front and back walls and rise with the roof up to the purlins.
  const SIDE_RISE = 0.18 / Math.cos(ALPHA);
  const sideShape = (sign, hole) => {
    // shape x = sign * world z
    const s = new THREE.Shape();
    const zs = sign > 0 ? [-Z, Z] : [Z, -Z];
    s.moveTo(sign * zs[0], GROUND_Y).lineTo(sign * zs[1], GROUND_Y).lineTo(sign * zs[1], wallTop(zs[1]) + SIDE_RISE).lineTo(sign * zs[0], wallTop(zs[0]) + SIDE_RISE).closePath();
    if (hole) {
      const h = new THREE.Path();
      const x0 = Math.min(sign * hole.z0, sign * hole.z1), x1 = Math.max(sign * hole.z0, sign * hole.z1);
      h.moveTo(x0, hole.y0).lineTo(x0, hole.y1).lineTo(x1, hole.y1).lineTo(x1, hole.y0).closePath();
      s.holes.push(h);
    }
    return s;
  };
  const right = wall(sideShape(-1, WINDOW), { ex: new THREE.Vector3(0, 0, -1), ez: new THREE.Vector3(1, 0, 0), origin: new THREE.Vector3(X, 0, 0), inner: wallIn, outer: wallOut, innerCap: 0 });
  const left = wall(sideShape(1, null), { ex: new THREE.Vector3(0, 0, 1), ez: new THREE.Vector3(-1, 0, 0), origin: new THREE.Vector3(-X, 0, 0), inner: wallIn, outer: wallOut, innerCap: 0 });
  shed.add(shadows(back), shadows(front), shadows(right), shadows(left));

  // ---- floor slab (top at y = 0, a low plinth shows outside)
  const concreteOut = pbr(polyhaven('dirty_concrete', 'hero', 'hero'), { color: 0xd6cdc0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * X + 0.02, 2 * Z + T + 0.02).rotateX(-Math.PI / 2), floorMat);
  scaleUV(floor.geometry, (2 * X) / 2.0, (2 * Z + T) / 2.0);
  floor.position.set(0, 0, T / 2);                       // runs out through the doorway to the threshold
  floor.receiveShadow = true;
  const plinth = new THREE.Mesh(boxMetric(2 * (X + T) + 0.24, 0.3, RUN + 0.24, 2.0), concreteOut);
  plinth.position.y = -0.152;
  // Concrete apron in front of the door.
  const apron = new THREE.Mesh(boxMetric(DOOR.x1 - DOOR.x0 + 0.5, 0.3, 0.7, 2.0, [0.37, 0.61]), concreteOut);
  apron.position.set((DOOR.x0 + DOOR.x1) / 2, -0.17, Z + T + 0.35);
  shed.add(floor, shadows(plinth, true, true), shadows(apron, false, true));

  // ---- roof, built in a frame that lies on the wall-top line (local z runs up the slope)
  const roof = new THREE.Group();
  roof.position.set(0, H_BACK, -Z - T);
  roof.rotation.x = -ALPHA;
  shed.add(roof);
  const LS = RUN / Math.cos(ALPHA);
  const beam = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(beamGeo(w, h, d, 1.2, [rand(), rand()]), mat);
    m.position.set(x, y, z);
    return shadows(m);
  };
  // wall plates
  roof.add(beam(2 * (X + T), 0.08, 0.14, 0, 0.04, 0.09, woodIn), beam(2 * (X + T), 0.08, 0.14, 0, 0.04, LS - 0.09, woodIn));
  // rafters
  for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) roof.add(beam(0.06, 0.1, LS + 0.75, x + (rand() - 0.5) * 0.04, 0.13, LS / 2 + 0.075, woodIn));
  // purlins
  const purlinZ = [-0.2, 0.72, 1.66, 2.6, 3.52, LS + 0.33];
  for (const z of purlinZ) roof.add(beam(2 * (X + T) + 0.6, 0.05, 0.05, 0, 0.205, z, woodIn));
  // corrugated sheets, each a little different so the roof does not read as one plane
  const SHEET_W = 0.912, x0 = -(X + T + 0.36);
  for (let k = 0; k < 6; k++) {
    const xa = x0 + k * (SHEET_W - 0.076), xb = xa + SHEET_W;
    for (const [za, zb, lift] of [[-0.36, 2.15, 0], [2.0, LS + 0.5, 0.004]]) {
      const g = corrugatedSheet(xa, xb, za, zb, [rand(), rand()], 0.241 + lift + (k % 2) * 0.0025);
      const top = new THREE.Mesh(g, sheetTop);
      top.castShadow = true;
      top.receiveShadow = true;
      const under = new THREE.Mesh(g, sheetUnder);
      under.receiveShadow = true;
      roof.add(top, under);
    }
  }
  // roofing nails with washers along every purlin
  const nails = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8), pbr({}, { color: 0x6f5b4b, roughness: 0.7, metalness: 0.6 }), purlinZ.length * 24);
  const dummy = new THREE.Object3D();
  let n = 0;
  for (const z of purlinZ) {
    for (let i = 0; i < 24; i++) {
      dummy.position.set(Math.round((x0 + 0.15 + i * 0.228) / 0.076) * 0.076, 0.241 + 0.012, z + (rand() - 0.5) * 0.01);
      dummy.updateMatrix();
      nails.setMatrixAt(n++, dummy.matrix);
    }
  }
  roof.add(nails);

  // ---- door frame and leaf (open outwards)
  const zMid = Z + T / 2;
  shed.add(
    beam(0.07, DOOR.h, T + 0.02, DOOR.x0 + 0.035, DOOR.h / 2, zMid, woodOut),
    beam(0.07, DOOR.h, T + 0.02, DOOR.x1 - 0.035, DOOR.h / 2, zMid, woodOut),
    beam(DOOR.x1 - DOOR.x0, 0.07, T + 0.02, (DOOR.x0 + DOOR.x1) / 2, DOOR.h - 0.035, zMid, woodOut),
  );
  const leafW = DOOR.x1 - DOOR.x0 - 0.16, leafH = DOOR.h - 0.09;
  const hinge = new THREE.Group();
  hinge.position.set(DOOR.x0 + 0.075, 0, Z + T + 0.012);
  hinge.rotation.y = THREE.MathUtils.degToRad(-112);       // swung open
  const leaf = new THREE.Mesh(boxMetric(leafW, leafH, 0.035, 1.5), doorMat);
  leaf.position.set(leafW / 2, leafH / 2 + 0.015, 0);
  hinge.add(shadows(leaf));
  for (const y of [0.25, leafH / 2, leafH - 0.25]) {
    const ledge = new THREE.Mesh(beamGeo(leafW - 0.06, 0.11, 0.025, 1.5, [rand(), rand()]), doorMat);
    ledge.position.set(leafW / 2, y, -0.03);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.045, 0.006), iron);
    strap.position.set(0.2, y, 0.021);
    hinge.add(shadows(ledge), shadows(strap));
  }
  const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 10), iron);
  bolt.rotation.z = Math.PI / 2;
  bolt.position.set(leafW - 0.12, leafH * 0.52, 0.03);
  hinge.add(shadows(bolt));
  shed.add(hinge);

  // ---- window frame and bars
  const wz = (WINDOW.z0 + WINDOW.z1) / 2, wy = (WINDOW.y0 + WINDOW.y1) / 2;
  const ww = WINDOW.z1 - WINDOW.z0, wh = WINDOW.y1 - WINDOW.y0;
  const win = new THREE.Group();
  win.position.set(X + T / 2, wy, wz);
  const fr = (w, h, d, y, z) => beam(w, h, d, 0, y, z, woodIn);
  win.add(fr(T + 0.03, 0.05, ww, wh / 2 - 0.025, 0), fr(T + 0.03, 0.05, ww, -wh / 2 + 0.025, 0));
  win.add(fr(T + 0.03, wh, 0.05, 0, ww / 2 - 0.025), fr(T + 0.03, wh, 0.05, 0, -ww / 2 + 0.025));
  const barMat = iron;
  for (let i = 1; i <= 6; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, wh - 0.08, 8), barMat);
    b.position.set(0.02, 0, -ww / 2 + (ww * i) / 7);
    win.add(shadows(b));
  }
  for (let i = 1; i <= 2; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, ww - 0.08, 8), barMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(0.032, -wh / 2 + (wh * i) / 3, 0);
    win.add(shadows(b));
  }
  shed.add(win);

  return shed;
}

/** Sandy yard around the shed that fades into the photographed ground of the sky dome. */
export function buildYard(radius = 15) {
  const maps = polyhaven('gravelly_sand');
  const g = new THREE.PlaneGeometry(radius * 2, radius * 2, 96, 96);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position, uv = g.attributes.uv;
  const colours = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    uv.setXY(i, x / 2.6, z / 2.6);
    // slow colour drift hides the texture repeat; alpha fades the patch out at its rim
    const n = Math.sin(x * 0.37 + 1.3) * Math.cos(z * 0.29 - 0.4) * 0.5 + Math.sin(x * 0.11 + z * 0.17) * 0.5;
    const shade = 0.93 + 0.09 * n;
    colours[i * 4] = shade * 1.02;
    colours[i * 4 + 1] = shade;
    colours[i * 4 + 2] = shade * 0.97;
    const r = Math.hypot(x, z) / radius;
    colours[i * 4 + 3] = 1 - THREE.MathUtils.smoothstep(r, 0.55, 0.98);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 4));
  const m = new THREE.Mesh(g, pbr(maps, { vertexColors: true, transparent: true, color: 0xf2dccb }));
  m.position.y = GROUND_Y;
  m.receiveShadow = true;
  m.renderOrder = -1;
  return m;
}

/**
 * The supervisor's office: a small flat-roofed room a few steps to the right of the shed, door
 * facing the same yard. Returns { group, door: Vector3 (just outside its door, shed space),
 * inside: Vector3 (where someone stands at the desk), colliders: [[minX, minZ, maxX, maxZ], ...] }.
 */
export function buildOffice() {
  const g = new THREE.Group();
  const rand = rng(31);
  const CX = 6.9, CZ = 0.9, HX = 1.5, HZ = 1.4, H = 2.55, DOOR_W = 0.95, DOOR_H = 2.05;
  const dx0 = CX - HX + 0.35, dx1 = dx0 + DOOR_W;                 // door on the front wall, near its left end
  const wallOut = pbr(polyhaven('grey_plaster_02'), { color: new THREE.Color(1.7, 1.62, 1.5) });
  const wallIn = interior(pbr({ map: gen('wall_in_diff', 'hero'), normalMap: gen('wall_in_nor', 'hero'), arm: gen('wall_in_arm', 'aux') }, { color: 0xf2e9dc }));
  const concrete = pbr(polyhaven('dirty_concrete', 'hero', 'hero'), { color: 0xd6cdc0 });
  const floorMat = interior(pbr(polyhaven('dirty_concrete', 'hero', 'hero'), { color: 0xe6dccd }));
  const woodMaps = polyhaven('rough_wood');
  const wood = interior(pbr(woodMaps, { color: 0xb98f6a }));
  const woodOut = pbr(woodMaps, { color: 0xb08a6c });
  const doorMat = pbr(polyhaven('distressed_painted_planks'), { color: new THREE.Color(1.1, 1.2, 1.25) });
  const steel = interior(new THREE.MeshStandardMaterial({ color: 0x6f7a80, roughness: 0.55, metalness: 0.6 }));

  const X1 = new THREE.Vector3(1, 0, 0), Z1 = new THREE.Vector3(0, 0, 1);
  const front = new THREE.Shape();
  front.moveTo(CX - HX - T, GROUND_Y).lineTo(dx0, GROUND_Y).lineTo(dx0, DOOR_H).lineTo(dx1, DOOR_H).lineTo(dx1, GROUND_Y)
    .lineTo(CX + HX + T, GROUND_Y).lineTo(CX + HX + T, H).lineTo(CX - HX - T, H).closePath();
  const win = new THREE.Path();                                   // window beside the door
  win.moveTo(CX + 0.25, 1.05).lineTo(CX + 0.25, 1.95).lineTo(CX + 1.15, 1.95).lineTo(CX + 1.15, 1.05).closePath();
  front.holes.push(win);
  const side = (sign) => rectShape(sign * (CZ - HZ), GROUND_Y, sign * (CZ + HZ), H);
  const walls = [
    wall(rectShape(CX - HX - T, GROUND_Y, CX + HX + T, H), { ex: X1, ez: Z1, origin: new THREE.Vector3(0, 0, CZ - HZ - T), inner: wallIn, outer: wallOut, innerCap: 1 }),
    wall(front, { ex: X1, ez: Z1, origin: new THREE.Vector3(0, 0, CZ + HZ), inner: wallIn, outer: wallOut, innerCap: 0 }),
    wall(side(-1), { ex: new THREE.Vector3(0, 0, -1), ez: new THREE.Vector3(1, 0, 0), origin: new THREE.Vector3(CX + HX, 0, 0), inner: wallIn, outer: wallOut, innerCap: 0 }),
    wall(side(1), { ex: new THREE.Vector3(0, 0, 1), ez: new THREE.Vector3(-1, 0, 0), origin: new THREE.Vector3(CX - HX, 0, 0), inner: wallIn, outer: wallOut, innerCap: 0 }),
  ];
  g.add(...walls.map((w) => shadows(w)));

  const box = (w, h, d, x, y, z, mat, tile = 1.2) => {
    const m = new THREE.Mesh(beamGeo(w, h, d, tile, [rand(), rand()]), mat);
    m.position.set(x, y, z);
    return shadows(m);
  };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * HX + 0.02, 2 * HZ + T + 0.02).rotateX(-Math.PI / 2), floorMat);
  scaleUV(floor.geometry, HX, HZ);
  floor.position.set(CX, 0, CZ + T / 2);
  floor.receiveShadow = true;
  const slabTop = new THREE.Mesh(boxMetric(2 * (HX + T) + 0.5, 0.14, 2 * (HZ + T) + 0.5, 2.0), concrete);
  slabTop.position.set(CX, H + 0.07, CZ);
  const plinth = new THREE.Mesh(boxMetric(2 * (HX + T) + 0.2, 0.3, 2 * (HZ + T) + 0.2, 2.0), concrete);
  plinth.position.set(CX, -0.152, CZ);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * HX, 2 * HZ).rotateX(Math.PI / 2), wallIn);
  ceiling.position.set(CX, H - 0.001, CZ);
  g.add(floor, shadows(slabTop), shadows(plinth), ceiling);

  // door frame, open leaf, window frame
  const zMid = CZ + HZ + T / 2;
  g.add(
    box(0.06, DOOR_H, T + 0.02, dx0 + 0.03, DOOR_H / 2, zMid, woodOut), box(0.06, DOOR_H, T + 0.02, dx1 - 0.03, DOOR_H / 2, zMid, woodOut),
    box(DOOR_W, 0.06, T + 0.02, (dx0 + dx1) / 2, DOOR_H - 0.03, zMid, woodOut),
    box(0.9, 0.05, T + 0.03, CX + 0.7, 1.075, zMid, woodOut), box(0.9, 0.05, T + 0.03, CX + 0.7, 1.925, zMid, woodOut),
    box(0.05, 0.9, T + 0.03, CX + 0.275, 1.5, zMid, woodOut), box(0.05, 0.9, T + 0.03, CX + 1.125, 1.5, zMid, woodOut), box(0.035, 0.9, 0.04, CX + 0.7, 1.5, zMid, woodOut),
  );
  const hinge = new THREE.Group();
  hinge.position.set(dx1 - 0.065, 0, CZ + HZ + T + 0.01);
  hinge.rotation.y = THREE.MathUtils.degToRad(100);
  const leaf = new THREE.Mesh(boxMetric(DOOR_W - 0.14, DOOR_H - 0.08, 0.035, 1.5), doorMat);
  leaf.position.set(-(DOOR_W - 0.14) / 2, (DOOR_H - 0.08) / 2 + 0.015, 0);
  hinge.add(shadows(leaf));
  g.add(hinge);

  // a desk with a chair and a filing cabinet, seen through the door and window
  const dz = CZ - HZ + 0.45;
  g.add(
    box(1.3, 0.04, 0.65, CX + 0.35, 0.74, dz, wood), box(0.05, 0.72, 0.6, CX - 0.25, 0.36, dz, wood), box(0.05, 0.72, 0.6, CX + 0.95, 0.36, dz, wood),
    box(0.42, 0.04, 0.42, CX + 0.35, 0.45, dz + 0.75, wood), box(0.42, 0.5, 0.04, CX + 0.35, 0.72, dz + 0.95, wood),
    box(0.04, 0.45, 0.04, CX + 0.16, 0.225, dz + 0.57, steel), box(0.04, 0.45, 0.04, CX + 0.54, 0.225, dz + 0.57, steel),
    box(0.04, 0.45, 0.04, CX + 0.16, 0.225, dz + 0.93, steel), box(0.04, 0.45, 0.04, CX + 0.54, 0.225, dz + 0.93, steel),
    box(0.45, 1.3, 0.5, CX - HX + 0.28, 0.65, CZ - HZ + 0.3, steel),
    box(0.32, 0.03, 0.23, CX + 0.2, 0.775, dz - 0.02, interior(new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.8 }))),
  );

  return {
    group: g,
    door: new THREE.Vector3((dx0 + dx1) / 2, 0, CZ + HZ + T + 0.7),
    inside: new THREE.Vector3((dx0 + dx1) / 2 + 0.2, 0, CZ + 0.5),
    colliders: [
      [CX - HX - T, CZ - HZ - T, CX + HX + T, CZ - HZ],                 // back
      [CX - HX - T, CZ - HZ, CX - HX, CZ + HZ + T],                     // left
      [CX + HX, CZ - HZ, CX + HX + T, CZ + HZ + T],                     // right
      [CX - HX - T, CZ + HZ, dx0, CZ + HZ + T], [dx1, CZ + HZ, CX + HX + T, CZ + HZ + T],   // front, either side of the door
      [CX - 0.3, dz - 0.33, CX + 1.0, dz + 0.33], [CX - HX, CZ - HZ, CX - HX + 0.52, CZ - HZ + 0.56],   // desk, cabinet
    ],
  };
}

/** Wall and prop footprints of the shed for walking collisions: [minX, minZ, maxX, maxZ] in shed space. */
export const SHED_COLLIDERS = [
  [-X - T, -Z - T, X + T, -Z],                                    // back wall
  [-X - T, -Z, -X, Z + T], [X, -Z, X + T, Z + T],                 // side walls
  [-X - T, Z, DOOR.x0, Z + T], [DOOR.x1, Z, X + T, Z + T],        // front wall, either side of the door
];
