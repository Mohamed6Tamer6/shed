import * as THREE from 'three';
import { HAND_CONFIG } from './handConfig.js';

// The player's own body (no head): black cotton t-shirt, blue denim jeans, dark grey sneakers.
// Body space: origin at the feet, +Y up, -Z forward, +X right.

const HIP_Y = 0.92, HIP_X = 0.09, THIGH = 0.42, SHIN = 0.42, ANKLE = 0.08;
const SHOULDER = new THREE.Vector3(0.2, 1.43, 0);
const ARM_L0 = 0.3; // modelled upper-arm length; scaled to the real shoulder->elbow distance
const BACK = 0.17;
const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const band = (x, a, b, f) => smooth(a - f, a, x) * (1 - smooth(b, b + f, x));

// ---------- geometry helpers ----------

// Catmull-Rom resample of key rings ({y, rx, rz, cx, cz, p}) so each segment is at most `step` tall.
function resample(keys, step) {
  const out = [];
  const lerpKey = (a, b, c, d, t) => {
    const r = {};
    for (const k of Object.keys(b)) {
      const p0 = a[k] ?? b[k], p1 = b[k], p2 = c[k] ?? b[k], p3 = d[k] ?? p2;
      const t2 = t * t, t3 = t2 * t;
      r[k] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
    return r;
  };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(keys.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.abs(c.y - b.y) / step));
    for (let s = 0; s < n; s++) out.push(lerpKey(a, b, c, d, s / n));
  }
  out.push({ ...keys[keys.length - 1] });
  return out;
}

// Hemispherical cap rings: from the pole (r=0) to the equator, centred at yc, pole on side `dir` (+1 up / -1 down).
function cap(yc, r, dir, n = 5, extra = {}, flat = 1) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * Math.PI / 2;
    out.push({ y: yc + dir * r * flat * Math.cos(a), rx: Math.max(r * Math.sin(a), 1e-4), rz: Math.max(r * Math.sin(a), 1e-4), ...extra });
  }
  return out;
}

// Lofted tube through elliptical / super-elliptical rings along Y. UVs are in metres.
// opt.shape(theta, ring, i) -> radial multiplier (folds); opt.shade(theta, ring, i) -> vertex colour multiplier.
function tube(rings, seg, opt = {}) {
  const nR = rings.length, cols = seg + 1;
  const pos = new Float32Array(nR * cols * 3), uv = new Float32Array(nR * cols * 2), col = new Float32Array(nR * cols * 3);
  let perim = 0;
  for (const r of rings) perim += Math.PI * (r.rx + r.rz);
  perim /= nR;
  let arc = 0;
  for (let i = 0; i < nR; i++) {
    const r = rings[i];
    if (i > 0) { const q = rings[i - 1]; arc += Math.hypot(r.y - q.y, (r.rx + r.rz - q.rx - q.rz) * 0.5); }
    const e = 2 / (r.p ?? 2);
    for (let j = 0; j < cols; j++) {
      const th = (j / seg) * TAU, c = Math.cos(th), s = Math.sin(th);
      const k = opt.shape ? opt.shape(th, r, i) : 1;
      const o = i * cols + j;
      pos[o * 3] = (r.cx ?? 0) + Math.sign(c) * Math.abs(c) ** e * r.rx * k;
      pos[o * 3 + 1] = r.y;
      pos[o * 3 + 2] = (r.cz ?? 0) + Math.sign(s) * Math.abs(s) ** e * r.rz * k;
      uv[o * 2] = (j / seg) * perim; uv[o * 2 + 1] = arc;
      const sh = opt.shade ? opt.shade(th, r, i) : 1;
      col[o * 3] = col[o * 3 + 1] = col[o * 3 + 2] = sh;
    }
  }
  const idx = [];
  const flip = rings[nR - 1].y < rings[0].y;
  for (let i = 0; i < nR - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * cols + j, b = a + cols, c = a + 1, d = b + 1;
      if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Weld the seam normals so there is no visible line.
  const n = g.attributes.normal.array;
  for (let i = 0; i < nR; i++) {
    const a = i * cols * 3, b = (i * cols + seg) * 3;
    for (let k = 0; k < 3; k++) { const m = (n[a + k] + n[b + k]) * 0.5; n[a + k] = n[b + k] = m; }
  }
  return g;
}

// ---------- procedural textures ----------

function canvasTex(size, paint, srgb) {
  const cv = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  paint(img.data, size);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 3/1 twill denim: indigo warp running diagonally over white weft, with slubby yarn variation. Seamless.
function denimTextures() {
  const S = 256, P = 8;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const warp = Array.from({ length: S }, () => 0.93 + rnd() * 0.12);
  const weft = Array.from({ length: S }, () => 0.97 + rnd() * 0.06);
  for (let k = 0; k < 14; k++) { const x = Math.floor(rnd() * S); for (let d = -1; d <= 1; d++) warp[(x + d + S) % S] *= 1.05; } // slub streaks run along the leg
  const tw = (x, y) => 0.5 + 0.5 * Math.cos(TAU * ((x + y) % P) / P);
  const map = canvasTex(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const t = tw(x, y), w = warp[x] * weft[y], n = 0.93 + rnd() * 0.14;
      const o = (y * S + x) * 4;
      // indigo warp (t high) vs white-ish weft peeking through (t low)
      d[o] = clamp((44 + (1 - t) * 52) * w * n, 0, 255);
      d[o + 1] = clamp((70 + (1 - t) * 50) * w * n, 0, 255);
      d[o + 2] = clamp((118 + (1 - t) * 50) * w * n, 0, 255);
      d[o + 3] = 255;
    }
  }, true);
  const bump = canvasTex(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = clamp(tw(x, y) * 200 * warp[x] + rnd() * 40, 0, 255), o = (y * S + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
  }, false);
  for (const t of [map, bump]) t.repeat.set(20, 20);
  return { map, bump };
}

// Fine cotton jersey knit: soft vertical loops for a bump map.
function knitBump() {
  const S = 128;
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const t = canvasTex(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = 0.5 + 0.25 * Math.cos(TAU * x / 4) * Math.cos(TAU * y / 8) + rnd() * 0.25;
      const o = (y * S + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v * 255; d[o + 3] = 255;
    }
  }, false);
  t.repeat.set(70, 70);
  return t;
}

// ---------- materials ----------

function makeMaterials(skinMaterial) {
  const denim = denimTextures();
  const shirt = new THREE.MeshPhysicalMaterial({
    color: 0x2a2b2e, roughness: 0.9, sheen: 1, sheenColor: 0x6e6e74, sheenRoughness: 0.55,
    bumpMap: knitBump(), bumpScale: 0.35, vertexColors: true, side: THREE.DoubleSide,
  });
  const jeans = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: denim.map, roughness: 0.88, sheen: 0.6, sheenColor: 0x8fa6c8, sheenRoughness: 0.7,
    bumpMap: denim.bump, bumpScale: 0.6, vertexColors: true, side: THREE.DoubleSide,
  });
  const skin = skinMaterial || new THREE.MeshPhysicalMaterial({ color: HAND_CONFIG.skin.tone, roughness: 0.62, sheen: 0.25, sheenColor: 0xffa58c, sheenRoughness: 0.6 });
  const shoe = new THREE.MeshPhysicalMaterial({ color: 0x3b3d42, roughness: 0.75, sheen: 0.5, sheenColor: 0x6a6d75, sheenRoughness: 0.6, vertexColors: true });
  const sole = new THREE.MeshPhysicalMaterial({ color: 0xe6e3dc, roughness: 0.7, vertexColors: true });
  const lace = new THREE.MeshPhysicalMaterial({ color: 0x2a2b2f, roughness: 0.85, sheen: 0.5, sheenColor: 0x55585f });
  return { shirt, jeans, skin, shoe, sole, lace };
}

// ---------- body parts ----------

// Torso of the t-shirt: hem (turned back), belly, chest, shoulders, open crew neck.
function shirtTorso() {
  const keys = [
    { y: 0.905, rx: 0.180, rz: 0.121, cz: 0.004, p: 2.2 },
    { y: 0.96, rx: 0.177, rz: 0.117, cz: 0.0, p: 2.2 },
    { y: 1.04, rx: 0.170, rz: 0.112, cz: -0.006, p: 2.2 },
    { y: 1.12, rx: 0.172, rz: 0.113, cz: -0.006, p: 2.3 },
    { y: 1.21, rx: 0.181, rz: 0.119, cz: -0.010, p: 2.4 },
    { y: 1.29, rx: 0.190, rz: 0.121, cz: -0.010, p: 2.5 },
    { y: 1.36, rx: 0.198, rz: 0.114, cz: -0.004, p: 2.6 },
    { y: 1.405, rx: 0.197, rz: 0.102, cz: 0.0, p: 2.5 },
    { y: 1.432, rx: 0.180, rz: 0.090, cz: 0.003, p: 2.3 },
    { y: 1.455, rx: 0.135, rz: 0.076, cz: 0.006, p: 2.1 },
    { y: 1.467, rx: 0.100, rz: 0.069, cz: 0.007, p: 2.0 },
    { y: 1.474, rx: 0.080, rz: 0.066, cz: 0.008, p: 2.0 },
  ];
  const rings = [
    { y: 0.93, rx: 0.172, rz: 0.114, cz: 0.004, p: 2.2 }, // inside of hem
    { y: 0.902, rx: 0.176, rz: 0.118, cz: 0.004, p: 2.2 },
    ...resample(keys, 0.012),
    { y: 1.472, rx: 0.074, rz: 0.060, cz: 0.008 }, // inside of collar
    { y: 1.455, rx: 0.074, rz: 0.060, cz: 0.008 },
  ];
  const n = rings.length;
  return tube(rings, 48, {
    shape: (th, r, i) => {
      if (i < 2 || i > n - 3) return 1;
      const fold = Math.sin(r.y * 95 + 2.4 * Math.sin(th * 3 + 0.7)) * band(r.y, 0.95, 1.1, 0.04) * 0.012;
      const drape = Math.sin(th * 7 + Math.sin(th * 2) * 2) * band(r.y, 0.9, 0.98, 0.05) * 0.01;
      return 1 + fold + drape;
    },
    shade: (th, r, i) => {
      if (i < 2) return 0.6;
      const side = Math.abs(Math.cos(th)) ** 6; // underarm / side shadows
      const fold = Math.sin(r.y * 95 + 2.4 * Math.sin(th * 3 + 0.7)) * band(r.y, 0.95, 1.1, 0.04);
      return clamp(1 - side * 0.25 * band(r.y, 1.0, 1.32, 0.08) + fold * 0.12, 0.5, 1.1);
    },
  });
}

// Collar rib and a short neck stub inside the opening.
function collar(mats) {
  const g = new THREE.Group();
  const rib = new THREE.Mesh(new THREE.TorusGeometry(1, 0.11, 8, 40), mats.shirt);
  rib.scale.set(0.077, 0.063, 0.08);
  rib.rotation.x = Math.PI / 2;
  rib.position.set(0, 1.472, 0.008);
  rib.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rib.geometry.attributes.position.count * 3).fill(0.8), 3));
  const neckRings = resample([
    { y: 1.40, rx: 0.058, rz: 0.054 }, { y: 1.45, rx: 0.056, rz: 0.052 }, { y: 1.47, rx: 0.055, rz: 0.051 },
  ], 0.02).concat(cap(1.47, 0.03, 1, 4).reverse().slice(1));
  const neck = new THREE.Mesh(tube(neckRings, 24), mats.skin);
  neck.position.z = 0.012;
  g.add(rib, neck);
  return g;
}

// Rounded t-shirt shoulder cap that blends the sleeve into the torso.
function shoulderCap(mats, h) {
  const r = 0.06, rz = 0.057;
  const rings = cap(0, r, 1, 6, {}, 0.8).slice(0, -1)
    .concat([{ y: 0, rx: r, rz }, { y: -0.03, rx: r, rz }, { y: -0.055, rx: 0.058, rz: 0.055 }])
    .concat(cap(-0.055, 0.058, -1, 4, {}, 0.4).reverse().slice(1));
  for (const q of rings) q.rz = Math.min(q.rz, q.rx * 0.95);
  const m = new THREE.Mesh(tube(rings, 28), mats.shirt);
  m.position.set(h * 0.195, 1.385, 0.0);
  return m;
}

// Jeans hips: waistband to crotch, closed shape.
function jeansHips() {
  const keys = [
    { y: 0.77, rx: 0.06, rz: 0.05, cz: 0.01, p: 2.2 },
    { y: 0.80, rx: 0.11, rz: 0.085, cz: 0.012, p: 2.4 },
    { y: 0.85, rx: 0.165, rz: 0.112, cz: 0.014, p: 2.4 },
    { y: 0.92, rx: 0.168, rz: 0.110, cz: 0.006, p: 2.3 },
    { y: 0.99, rx: 0.161, rz: 0.104, cz: 0.002, p: 2.2 },
    { y: 1.04, rx: 0.160, rz: 0.103, cz: 0.002, p: 2.2 },
  ];
  const rings = [
    { y: 0.76, rx: 1e-4, rz: 1e-4, cz: 0.01 },
    ...resample(keys, 0.015),
    { y: 1.042, rx: 0.12, rz: 0.08 }, { y: 1.043, rx: 1e-4, rz: 1e-4 },
  ];
  return tube(rings, 48, {
    shade: (th, r) => {
      const waist = 1 - 0.3 * band(r.y, 0.993, 0.997, 0.002); // waistband stitch
      const crotch = 1 - 0.2 * (1 - smooth(0.76, 0.84, r.y));
      return waist * crotch;
    },
  });
}

// Lighter worn denim over the kneecap; d = height above the knee joint.
const kneeFade = (th, d) => 1 + 0.16 * smooth(0.2, 1, -Math.sin(th)) * Math.exp(-(((d + 0.01) / 0.06) ** 2));

// Thigh in hip-pivot space: hip ball down to the knee ball (both joint centres at the cap centres).
function thighGeo() {
  const rTop = 0.076, rKnee = 0.058;
  const keys = [
    { y: 0, rx: rTop, rz: rTop }, { y: -0.12, rx: 0.072, rz: 0.071 }, { y: -0.28, rx: 0.064, rz: 0.063 },
    { y: -0.38, rx: 0.059, rz: 0.058 }, { y: -THIGH, rx: rKnee, rz: rKnee },
  ];
  const rings = cap(0, rTop, 1, 6).slice(0, -1).concat(resample(keys, 0.016)).concat(cap(-THIGH, rKnee, -1, 6).reverse().slice(1));
  return tube(rings, 26, {
    shape: (th, r) => {
      const back = smooth(0.2, 1, Math.sin(th)); // +z = back of the leg
      const knee = Math.sin((r.y + THIGH) * 140 + Math.cos(th * 2) * 1.5) * back * band(r.y, -0.44, -0.33, 0.04) * 0.04;
      return 1 + knee;
    },
    shade: (th, r) => {
      const front = smooth(0.2, 1, -Math.sin(th));
      const fade = 1 + 0.16 * front * band(r.y, -0.3, -0.04, 0.08); // worn lighter on the front of the thigh
      const back = smooth(0.2, 1, Math.sin(th));
      const crease = Math.sin((r.y + THIGH) * 140 + Math.cos(th * 2) * 1.5) * back * band(r.y, -0.44, -0.33, 0.04);
      const top = 1 - 0.3 * smooth(-0.1, 0.0, r.y);
      return fade * kneeFade(th, r.y + THIGH) * (1 + crease * 0.2) * top;
    },
  });
}

// Shin in knee-pivot space: knee ball down to an open, slightly stacked hem that rests on the shoe.
function shinGeo() {
  const rKnee = 0.058, hem = -0.428;
  const keys = [
    { y: 0, rx: rKnee, rz: rKnee }, { y: -0.08, rx: 0.056, rz: 0.055 }, { y: -0.2, rx: 0.053, rz: 0.052 },
    { y: -0.33, rx: 0.051, rz: 0.051 }, { y: -0.39, rx: 0.053, rz: 0.053 }, { y: hem, rx: 0.056, rz: 0.058, cz: 0.004 },
  ];
  const rings = cap(0, rKnee, 1, 6).slice(0, -1).concat(resample(keys, 0.012)).concat([
    { y: hem - 0.004, rx: 0.054, rz: 0.056, cz: 0.004 }, { y: hem + 0.012, rx: 0.051, rz: 0.053, cz: 0.004 },
  ]);
  const n = rings.length;
  const stack = (th, r) => Math.sin(r.y * 160 + Math.sin(th * 3) * 2.2) * band(r.y, -0.41, -0.33, 0.03);
  return tube(rings, 26, {
    shape: (th, r, i) => (i >= n - 2 ? 1 : 1 + stack(th, r) * 0.05),
    shade: (th, r, i) => {
      if (i >= n - 2) return 0.55;
      return kneeFade(th, r.y) * (1 + stack(th, r) * 0.22);
    },
  });
}

// Sneaker in ankle space (ankle at origin, ground at y = -ANKLE): upper, light sole, laces.
function shoe(mats) {
  const g = new THREE.Group();
  const L = 0.26, heelZ = 0.065, R = 0.04, ground = -ANKLE;
  const top = (s) => {
    if (s < 0.09) return 0.018 - 0.01 * smooth(0.0, 0.09, s); // collar
    return THREE.MathUtils.lerp(0.008, -0.058, smooth(0.09, L, s) ** 0.9);
  };
  const width = (s) => 0.034 + 0.016 * smooth(0.0, 0.15, s) - 0.012 * smooth(0.2, L, s);
  const round = (s) => { const m = Math.min(s, L - s); return m >= R ? 1 : Math.sqrt(1 - (1 - m / R) ** 2); };
  const N = 26;
  const upperRings = [], soleRings = [];
  for (let k = 0; k <= N; k++) {
    const s = (k / N) * L, e = Math.max(round(s), 0.003);
    const lo = ground + 0.014, hi = top(s);
    const cy = (lo + hi) / 2, hy = (hi - lo) / 2;
    // builder y = s; cross-section x = width, "z" = height (becomes y after rotation)
    upperRings.push({ y: s, rx: width(s) * e, rz: hy * e, cz: cy, p: 2.6 });
    const sh = 0.0135;
    soleRings.push({ y: s - 0.004 * (1 - 2 * k / N), rx: (width(s) + 0.004) * e, rz: sh * Math.max(e, 0.4), cz: ground + sh, p: 4 });
  }
  const toFoot = (geo) => { geo.rotateX(-Math.PI / 2); geo.translate(0, 0, heelZ); return geo; };
  // after rotateX(-90°): builder (x, y=s, z) -> (x, z, -s); so builder z must hold the height
  const upper = new THREE.Mesh(toFoot(tube(upperRings, 22, {
    shade: (th) => 1 - 0.25 * smooth(0.3, 1, -Math.sin(th)),
  })), mats.shoe);
  const sole = new THREE.Mesh(toFoot(tube(soleRings, 20, {
    shade: (th) => 1 - 0.35 * smooth(0.0, 1, -Math.sin(th)),
  })), mats.sole);
  g.add(sole, upper);
  // Laces across the instep.
  const laceGeo = new THREE.CapsuleGeometry(0.0032, 0.03, 3, 6);
  laceGeo.rotateZ(Math.PI / 2);
  for (let k = 0; k < 5; k++) {
    const s = 0.1 + k * 0.022;
    const l = new THREE.Mesh(laceGeo, mats.lace);
    const slope = Math.atan2(top(s + 0.005) - top(s - 0.005), 0.01);
    l.position.set(0, top(s) + 0.002, heelZ - s);
    l.rotation.x = -slope;
    l.scale.x = (width(s) * 0.9) / 0.034;
    g.add(l);
  }
  return g;
}

// One leg: hip pivot -> thigh -> knee pivot -> shin -> ankle pivot -> shoe.
function leg(mats, h) {
  const hip = new THREE.Group();
  hip.position.set(h * HIP_X, HIP_Y, 0);
  hip.add(new THREE.Mesh(thighGeo(), mats.jeans));
  const knee = new THREE.Group();
  knee.position.y = -THIGH;
  knee.add(new THREE.Mesh(shinGeo(), mats.jeans));
  hip.add(knee);
  const ankle = new THREE.Group();
  ankle.position.y = -SHIN;
  ankle.add(shoe(mats));
  ankle.rotation.y = -h * 0.08; // toes out a touch
  knee.add(ankle);
  return { hip, knee, ankle };
}

// Upper arm: skin capsule from shoulder to elbow along -Y (length ARM_L0) plus a short t-shirt sleeve.
function upperArm(mats, h) {
  const root = new THREE.Group();
  root.position.set(h * SHOULDER.x, SHOULDER.y, SHOULDER.z);
  const keys = [
    { y: -0.045, rx: 0.045, rz: 0.045 }, { y: -0.1, rx: 0.046, rz: 0.047 }, { y: -0.2, rx: 0.043, rz: 0.044 }, { y: -ARM_L0, rx: 0.04, rz: 0.04 },
  ];
  const rings = cap(-0.045, 0.045, 1, 5, {}, 0.5).slice(0, -1).concat(resample(keys, 0.015)).concat(cap(-ARM_L0, 0.04, -1, 5).reverse().slice(1));
  const arm = new THREE.Mesh(tube(rings, 24), mats.skin);
  const sl = -ARM_L0 * 0.45;
  const sKeys = [
    { y: -0.045, rx: 0.057, rz: 0.058 }, { y: sl * 0.6, rx: 0.057, rz: 0.057 }, { y: sl, rx: 0.056, rz: 0.055 },
  ];
  const sRings = cap(-0.045, 0.057, 1, 6, {}, 0.6).slice(0, -1).concat(resample(sKeys, 0.012)).concat([
    { y: sl - 0.002, rx: 0.054, rz: 0.053 }, { y: sl + 0.012, rx: 0.048, rz: 0.047 },
  ]);
  const n = sRings.length;
  const sleeve = new THREE.Mesh(tube(sRings, 32, {
    shape: (th, r, i) => (i >= n - 2 ? 1 : 1 + Math.sin(th * 5 + r.y * 40) * band(r.y, sl, sl * 0.4, 0.02) * 0.03),
    shade: (th, r, i) => (i >= n - 2 ? 0.5 : 1 - 0.3 * smooth(0.3, 1, -h * Math.cos(th))),
  }), mats.shirt);
  root.add(arm, sleeve);
  return { root, arm, sleeve };
}

// ---------- assembly ----------

/**
 * createBody(parent, { skinMaterial }) adds the body to `parent` (the stage's `world` group: positions passed to
 * update() are in that group's space). Returns { group, materials, update(dt, state), setArms(r, l) }.
 */
export function createBody(scene, { skinMaterial } = {}) {
  const mats = makeMaterials(skinMaterial);
  const group = new THREE.Group();
  group.name = 'playerBody';
  const upper = new THREE.Group();
  const lower = new THREE.Group();
  group.add(upper, lower);

  upper.add(new THREE.Mesh(shirtTorso(), mats.shirt), collar(mats), shoulderCap(mats, 1), shoulderCap(mats, -1));
  lower.add(new THREE.Mesh(jeansHips(), mats.jeans));
  const legs = [leg(mats, 1), leg(mats, -1)];
  for (const l of legs) lower.add(l.hip);
  const arms = [upperArm(mats, 1), upperArm(mats, -1)];
  for (const a of arms) group.add(a.root);

  group.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true; } });
  scene.add(group);

  const lift = (t, k) => THIGH * (1 - Math.cos(t)) + SHIN * (1 - Math.cos(t - k));

  function update(dt, s) {
    const amp = clamp(s.bobAmp ?? 0, 0, 1);
    const run = clamp(((s.speed ?? 0) - 2.3) / 1.3, 0, 1);
    const air = Math.max(0, s.air ?? 0);
    const tuck = clamp(air / 0.15, 0, 1);
    const swing = amp * (0.45 + 0.3 * run) * (1 - 0.6 * tuck);
    const lifts = [];
    legs.forEach((l, i) => {
      const t = (i === 0 ? 1 : -1) * Math.sin(s.bobPhase) * swing + 0.3 * tuck;
      const k = Math.max(0, -t) * (1.2 + 0.6 * run) + 0.3 * run * amp + 0.55 * tuck + 0.03;
      l.hip.rotation.x = t;
      l.knee.rotation.x = -k;
      l.ankle.rotation.x = -(t - k) - Math.max(0, -t) * 0.3; // level foot, toe-off on the back swing
      lifts.push(lift(t, k));
    });
    const bob = Math.cos(s.bobPhase * 2) * 0.028 * amp;
    const drop = air > 0 ? 0 : Math.min(Math.min(...lifts), 0.06);
    lower.position.y = -bob - drop;

    const yaw = s.yaw;
    group.position.set(s.pos.x + Math.sin(yaw) * BACK, s.pos.y + air + bob, s.pos.z + Math.cos(yaw) * BACK);
    group.rotation.set(0, yaw, 0);
    group.updateMatrixWorld(true);
  }

  const inv = new THREE.Matrix4(), e = new THREE.Vector3(), dir = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);
  function setArms(rightElbowWorld, leftElbowWorld) {
    group.updateMatrixWorld(true);
    inv.copy(group.matrixWorld).invert();
    [rightElbowWorld, leftElbowWorld].forEach((w, i) => {
      if (!w) return;
      const a = arms[i];
      e.copy(w).applyMatrix4(inv);
      dir.copy(e).sub(a.root.position);
      const len = Math.max(dir.length(), 1e-4);
      a.root.quaternion.setFromUnitVectors(DOWN, dir.multiplyScalar(1 / len));
      a.root.scale.set(1, len / ARM_L0, 1);
    });
    group.updateMatrixWorld(true);
  }

  return { group, update, setArms, materials: Object.values(mats) };
}
