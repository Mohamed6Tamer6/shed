import * as THREE from 'three';
import { gen, tex, tiled, pbr, interior, polyhaven, quality } from './assets.js';
import { gridNormals, fbm, rng, scaleUV, shadows } from './util.js';
import { X, Z } from './building.js';

const sp = (c, e) => Math.sign(c) * Math.abs(c) ** e;
const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);

/** A filled woven sack lying on its side: length along x, flattened where it carries load. */
function sackGeometry(L, Hs, D, seed) {
  const NU = 80, NV = 60, pos = [], uv = [], idx = [];
  for (let j = 0; j <= NV; j++) {
    const phi = (Math.PI * j) / NV;
    const cx = sp(Math.cos(phi), 0.5), rr = sp(Math.sin(phi), 0.5);
    for (let i = 0; i <= NU; i++) {
      const a = (Math.PI * 2 * i) / NU;
      let x = (-L / 2) * cx;
      let y = (-Hs / 2) * rr * sp(Math.cos(a), 0.62);
      let z = (D / 2) * rr * sp(Math.sin(a), 0.62);
      y = ((Hs / 2) * Math.tanh((1.5 * y) / (Hs / 2))) / Math.tanh(1.5);
      const end = smooth(Math.abs(cx), 0.8, 1);
      y *= 1 - 0.5 * end;
      // creases: broad lumps from the filling, tight folds towards the sewn ends
      const ca = Math.cos(a), sa = Math.sin(a);
      const n = 0.016 * fbm(x * 4 + seed, ca * 1.6 + seed, sa * 1.6, 4)
        + 0.007 * smooth(Math.abs(cx), 0.45, 1) * Math.sin(a * 11 + 4 * fbm(x * 3, ca, sa + seed, 2));
      const l = Math.hypot(y, z) || 1;
      y += (y / l) * n;
      z += (z / l) * n;
      x += 0.01 * fbm(seed, ca * 2, sa * 2 + x * 3, 2);
      pos.push(x, y, z);
      uv.push(i / NU, j / NV);
    }
  }
  const row = NU + 1;
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * row + i, b = a + row, c = a + 1, d = b + 1;
      idx.push(a, b, c, c, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return gridNormals(g, row);
}

function strandGeometry() {
  const g = new THREE.CylinderGeometry(0.0055, 0.007, 1, 3, 4, true);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + 0.07 * p.getY(i) ** 2);
  g.computeVertexNormals();
  return g;
}

/** Loose straw as instanced strands. `place(i, rand)` returns { p: Vector3, dir: Vector3, len }. */
function strands(count, material, seed, place) {
  const rand = rng(seed);
  const mesh = new THREE.InstancedMesh(strandGeometry(), material, count);
  const dummy = new THREE.Object3D(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const pale = new THREE.Color(0.86, 0.74, 0.47), gold = new THREE.Color(0.72, 0.55, 0.27), brown = new THREE.Color(0.46, 0.34, 0.18);
  for (let i = 0; i < count; i++) {
    const { p, dir, len } = place(i, rand);
    dummy.position.copy(p);
    dummy.quaternion.setFromUnitVectors(up, dir.normalize());
    dummy.rotateY(rand() * 6.283);
    dummy.scale.set(len * (0.8 + rand() * 0.5), len, len * (0.8 + rand() * 0.5));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const t = rand();
    col.copy(gold).lerp(pale, t);
    if (rand() < 0.14) col.lerp(brown, 0.7);
    mesh.setColorAt(i, col);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const randomDir = (rand, flatness) => {
  const a = rand() * 6.283;
  return new THREE.Vector3(Math.cos(a), (rand() * 2 - 1) * flatness, Math.sin(a));
};

/** The sack stack, the loose heap in the corner behind it and the straw scattered on the floor. */
export function makeSacksAndStraw() {
  const g = new THREE.Group();
  const density = { '4k': 1, '2k': 0.75, '1k': 0.4 }[quality.hero];
  const fabric = interior(pbr(
    { map: gen('sack_diff', 'hero'), normalMap: tiled(tex('hessian_380', 'nor_gl', 'aux'), 7, 5) },
    { roughness: 0.74, normalScale: 0.85 },
  ));
  const strawMaps = polyhaven('reed_roof_04');
  const thatch = interior(pbr(strawMaps, { color: 0xe9d3a2, normalScale: 1.4 }));
  const strandMat = interior(new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0 }));

  // ---- stack of three, against the back wall
  const sx = 1.04, sz = -Z + 0.37;
  const stack = [[0.94, 0.42, 0.6, 0.205, 0.04, 0.0, 3], [0.9, 0.4, 0.58, 0.58, -0.07, 0.03, 11], [0.86, 0.46, 0.56, 0.975, 0.05, -0.02, 29]];
  for (const [L, Hs, D, y, rot, dx, seed] of stack) {
    const s = new THREE.Mesh(sackGeometry(L, Hs, D, seed), fabric);
    s.position.set(sx + dx, y, sz);
    s.rotation.y = rot;
    g.add(s);
  }
  // open top sack: a heap of straw standing proud of the mouth
  const topY = 0.975 + 0.2;
  const dome = new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2);
  const dp = dome.attributes.position;
  for (let i = 0; i < dp.count; i++) {
    const k = 1 + 0.16 * fbm(dp.getX(i) * 2.2, dp.getY(i) * 2.2, dp.getZ(i) * 2.2, 3);
    dp.setXYZ(i, dp.getX(i) * k, dp.getY(i) * k, dp.getZ(i) * k);
  }
  dome.computeVertexNormals();
  scaleUV(dome, 2, 0.8);
  const mound = new THREE.Mesh(dome, thatch);
  mound.scale.set(0.34, 0.15, 0.21);
  mound.position.set(sx - 0.02, topY - 0.02, sz);
  g.add(mound);
  g.add(strands(Math.round(2400 * density), strandMat, 5, (i, rand) => {
    const a = rand() * 6.283, r = Math.sqrt(rand());
    const px = Math.cos(a) * r, pz = Math.sin(a) * r;
    const h = Math.sqrt(Math.max(0, 1 - r * r));
    const len = 0.1 + rand() * 0.22;
    return { p: new THREE.Vector3(sx - 0.02 + px * 0.34, topY - 0.03 + h * 0.15, sz + pz * 0.21), dir: randomDir(rand, 0.5).add(new THREE.Vector3(px * 0.6, 0.1, pz * 0.6)), len };
  }));

  // ---- loose heap in the back right corner
  const cornerX = X, cornerZ = -Z;
  const heapH = (x, z) => {
    const d = Math.hypot((cornerX - x) / 1.0, (z - cornerZ) / 1.25);
    const base = 1.22 * (1 - smooth(d, 0.08, 1));
    return base <= 0 ? 0 : Math.max(0, base + 0.05 * fbm(x * 3.1, z * 3.1, 1.7, 3) * smooth(base, 0, 0.2));
  };
  const hg = new THREE.PlaneGeometry(1.05, 1.3, 56, 64).rotateX(-Math.PI / 2);
  hg.translate(cornerX - 0.525, 0, cornerZ + 0.65);
  const hp = hg.attributes.position, huv = hg.attributes.uv;
  for (let i = 0; i < hp.count; i++) {
    hp.setY(i, heapH(hp.getX(i), hp.getZ(i)) - 0.004);
    huv.setXY(i, hp.getX(i) / 0.9, (hp.getZ(i) / 0.9) * 0.8 + 0.05);
  }
  hg.computeVertexNormals();
  g.add(new THREE.Mesh(hg, thatch));
  g.add(strands(Math.round(5200 * density), strandMat, 9, (i, rand) => {
    let x, z, h;
    do {
      x = cornerX - rand() * 1.02;
      z = cornerZ + rand() * 1.27;
      h = heapH(x, z);
    } while (h < 0.012);
    return { p: new THREE.Vector3(x, h + 0.005, z), dir: randomDir(rand, 0.55), len: 0.12 + rand() * 0.26 };
  }));

  // ---- straw on the floor: thick around the stack and the heap, thinning across the room
  g.add(strands(Math.round(1700 * density), strandMat, 13, (i, rand) => {
    let x, z;
    if (rand() < 0.7) {
      x = 1.0 + (rand() + rand() + rand() - 1.5) * 1.1;
      z = -0.95 + (rand() + rand() + rand() - 1.5) * 1.0;
    } else {
      x = (rand() * 2 - 1) * X;
      z = (rand() * 2 - 1) * Z;
    }
    x = THREE.MathUtils.clamp(x, -X + 0.03, X - 0.03);
    z = THREE.MathUtils.clamp(z, -Z + 0.03, Z - 0.03);
    return { p: new THREE.Vector3(x, 0.004 + rand() * 0.004, z), dir: randomDir(rand, 0.04), len: 0.08 + rand() * 0.22 };
  }));
  // stalks poking out between the sacks
  g.add(strands(Math.round(420 * density), strandMat, 17, (i, rand) => {
    const side = rand() < 0.5 ? -1 : 1;
    const y = [0.4, 0.77][Math.floor(rand() * 2)] + (rand() - 0.5) * 0.05;
    const front = rand() < 0.6;
    const p = front
      ? new THREE.Vector3(sx + (rand() - 0.5) * 0.8, y, sz + 0.26 + rand() * 0.03)
      : new THREE.Vector3(sx + side * (0.42 + rand() * 0.04), y, sz + (rand() - 0.5) * 0.4);
    const out = front ? new THREE.Vector3((rand() - 0.5) * 1.2, -0.35 + rand() * 0.5, 1) : new THREE.Vector3(side, -0.3 + rand() * 0.5, (rand() - 0.5) * 1.2);
    return { p, dir: out, len: 0.08 + rand() * 0.16 };
  }));
  return shadows(g);
}
