// Body hair for the first-person hands: forearm, back of the hand and the first finger segments.
// One InstancedMesh per hand (one draw call). Each strand is a camera-facing tapered ribbon of
// SEG segments, rooted on the bind-pose skin and skinned in the vertex shader with the same bones
// (up to 4 weights, interpolated from the triangle it was sampled on), so it stays glued to the skin
// when the fingers curl. Forearm strands use one extra matrix: the forearm mesh transform.
//
// What makes it read as hair rather than pen strokes (docs/hands/visual-gaps.md, gap 4):
//   - one growth map for the whole arm, in the hand's own frame: full on the back and the sides of the
//     forearm, carrying on over the wrist onto the little-finger half of the back of the hand and thinning
//     towards the knuckles, a tuft on each first finger segment, almost none on the palm side;
//   - hairs as long and thin as in the reference photo (forearm 1-2.2 cm, 50-80 µm), lying within a
//     millimetre of the skin and following its curve, flowing one way (towards the hand and the little-finger
//     side) with a smooth flow field and small scatter, gently curved (no polyline corners);
//   - brown with lighter tips, and drawn with their true coverage: a strand is never drawn thinner than
//     a pixel, and its opacity is its real width over the drawn width, so at play distance a hair darkens a
//     pixel by about as much as a real one does.
//
// The material is unlit by the scene: it takes its light from setLighting({ ambient, keyDir, keyColor })
//   ambient   radiance of a white matte surface in the light around the player (scene-linear)
//   keyDir    world-space direction towards the main light
//   keyColor  radiance of a white matte surface facing that light
import * as THREE from 'three';
import { HAND_CONFIG } from './handConfig.js';

const SEG = 6;               // segments per strand
// The look. These replace HAND_CONFIG.hair.color / length / forearmShare (the old black pen-stroke hair);
// HAND_CONFIG.hair.density still scales the number of strands.
const LOOK = {
  perCm2: 10.0,                         // strands per cm² where growth is full (back of the forearm), at density 1
  maxStrands: 5000,                    // per hand
  root: 0x3d2c21, tip: 0x84694f,       // sRGB: dark brown at the root, lighter towards the tip
  width: [0.00005, 0.00009],          // root width (m); terminal arm hair is 40-90 µm, the tip a fifth of that
  len: { arm: [0.008, 0.024], back: [0.006, 0.014], thumb: [0.004, 0.008], finger: [0.003, 0.0065] },
  lift: [0.05, 0.15],                  // how steeply a strand leaves the skin (it then bends back down)
  minPx: 1.0,                          // drawn width floor in pixels; opacity is scaled down to match
  cover: 1.6,                          // coverage gain: a photographed hair reads darker than its width (sharpening, contrast)
};

const VERT = /* glsl */`
#define NB BONE_COUNT
uniform mat4 uBones[NB];
uniform float uTime;
uniform vec3 uHandVel;
uniform float uViewH;
uniform float uMinPx;
uniform float uCover;
attribute vec3 aRoot;
attribute vec3 aDir;
attribute vec3 aNrm;
attribute vec4 aParm;   // length, root width, side curl (t^2), seed
attribute vec4 aShape;  // lift, bend back to the skin (m), side curl (t^3), shade
attribute vec4 aSkI;
attribute vec4 aSkW;
varying float vT;
varying float vAlpha;
varying float vShade;
varying vec3 vN;
varying vec3 vTan;
varying vec3 vW;
void main() {
  float t = position.y;
  float L = aParm.x, seed = aParm.w;
  vec3 B = normalize(cross(aNrm, aDir));
  // Leaves the skin at a shallow angle, bends back towards it and follows its curve; a gentle sideways S.
  float se = aShape.x, bend = aShape.y;
  float h = L * se * t * (1.0 - 0.65 * t) - bend * t * t + 0.00004 * t;
  float sway = aParm.z * t * t + aShape.z * t * t * t;
  vec3 local = aDir * (L * t) + aNrm * h + B * (L * sway);
  vec3 dl = aDir * L + aNrm * (L * se * (1.0 - 1.3 * t) - 2.0 * bend * t) + B * (L * (2.0 * aParm.z * t + 3.0 * aShape.z * t * t));

  mat4 S = uBones[int(aSkI.x)] * aSkW.x + uBones[int(aSkI.y)] * aSkW.y + uBones[int(aSkI.z)] * aSkW.z + uBones[int(aSkI.w)] * aSkW.w;
  vec3 p = (S * vec4(aRoot + local, 1.0)).xyz;
  mat3 S3 = mat3(S);
  vec3 wp3 = (modelMatrix * vec4(p, 1.0)).xyz;
  mat3 M3 = mat3(modelMatrix);
  vec3 wN = normalize(M3 * (S3 * aNrm));
  vec3 wT = normalize(M3 * (S3 * dl));

  // The tips lag a little behind the hand's own motion, never into the skin.
  vec3 vel = uHandVel;
  float vl = length(vel);
  if (vl > 2.0) vel *= 2.0 / vl;
  vec3 disp = -vel * 0.06 * (0.8 + 0.2 * sin(uTime * 9.0 + seed * 20.0)) * L * t * t;
  disp -= wN * min(dot(disp, wN), 0.0);
  wp3 += disp;

  // Camera-facing ribbon. A real hair is far below a pixel at arm's length: draw it at least uMinPx wide
  // and lower its opacity by the same factor, so it covers the pixel as much as the real hair would.
  vec3 toCam = cameraPosition - wp3;
  float dist = length(toCam);
  vec3 side = normalize(cross(wT, toCam));
  float w = aParm.y * (1.0 - 0.8 * t);
  float px = 2.0 * dist / (projectionMatrix[1][1] * uViewH);
  float wEff = max(w, px * uMinPx);
  wp3 += side * position.x * wEff * 0.5;

  vT = t;
  vAlpha = min(1.0, uCover * w / wEff) * (0.85 + 0.15 * fract(seed * 13.1));
  vShade = aShape.w;
  vN = wN;
  vTan = wT;
  vW = wp3;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp3, 1.0);
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uTipColor;
uniform vec3 uAmbient;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform float uOpacity;
varying float vT;
varying float vAlpha;
varying float vShade;
varying vec3 vN;
varying vec3 vTan;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN), T = normalize(vTan);
  vec3 L = normalize(uKeyDir);
  vec3 V = normalize(cameraPosition - vW);
  vec3 base = mix(uColor, uTipColor, smoothstep(0.15, 1.0, vT)) * vShade;
  // Diffuse: the light the skin underneath gets (wrapped), on a thin cylinder; a little darker at the root.
  float ndl = dot(N, L);
  float lit = pow(clamp(ndl * 0.6 + 0.4, 0.0, 1.0), 1.5);
  float tl = dot(T, L);
  float ao = mix(0.7, 1.0, smoothstep(0.0, 0.4, vT));
  vec3 col = base * (uAmbient + uKeyColor * lit * mix(0.55, 1.0, sqrt(max(1.0 - tl * tl, 0.0)))) * ao;
  // Highlight along the strand (Kajiya-Kay) from the key light, and a fainter one from the ambient light.
  vec3 H = normalize(L + V);
  float th = dot(T, H);
  float spec = pow(sqrt(max(1.0 - th * th, 0.0)), 40.0) * smoothstep(-0.2, 0.35, ndl);
  float tv = dot(T, V);
  col += uKeyColor * spec * 0.12 * vec3(1.0, 0.9, 0.8);
  col += uAmbient * pow(sqrt(max(1.0 - tv * tv, 0.0)), 8.0) * 0.03 * vec3(1.0, 0.9, 0.8);
  gl_FragColor = vec4(col, clamp(vAlpha, 0.0, 1.0) * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Small deterministic PRNG so every load grows the same hair.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Cheap 3D value noise for patchy density and the flow field.
function hash3(x, y, z) { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const l = (a, b, k) => a + (b - a) * k;
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy), l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy), sz);
}
const S = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);       // 0 below a, 1 above b (a < b)
const mix = (a, b, k) => a + (b - a) * k;

// Matrix taking obj's local space into ancestor's local space (works before anything is in a scene).
function relMatrix(obj, ancestor) {
  const m = new THREE.Matrix4();
  for (let o = obj; o && o !== ancestor; o = o.parent) {
    if (o.matrixAutoUpdate) o.updateMatrix();
    m.premultiply(o.matrix);
  }
  return m;
}

function triList(geo) {
  const pos = geo.attributes.position, idx = geo.index;
  const n = idx ? idx.count / 3 : pos.count / 3;
  const tris = [];
  for (let i = 0; i < n; i++) tris.push(idx ? [idx.getX(i * 3), idx.getX(i * 3 + 1), idx.getX(i * 3 + 2)] : [i * 3, i * 3 + 1, i * 3 + 2]);
  return tris;
}

export function createHair({ model, skinned, arm, side = 'right', u, n, wristModel }) {
  if (HAND_CONFIG.quality === 'low') return null;
  const density = HAND_CONFIG.hair.density ?? 1;
  if (!(density > 0)) return null;
  const rand = rng(side === 'right' ? 1234567 : 7654321);
  const h = side === 'right' ? 1 : -1;
  const bones = skinned.skeleton.bones;
  const NB = bones.length + 1; // last matrix = forearm mesh
  const ARM_BONE = bones.length;

  // ---- frames: model space -> skinned bind space ----
  skinned.updateMatrix();
  const modelToSkin = relMatrix(skinned, model).invert();
  const toSkinDir = (v) => v.clone().transformDirection(modelToSkin);
  const uS = toSkinDir(u), nS = toSkinDir(n);
  const vS = new THREE.Vector3().crossVectors(uS, nS).normalize();   // = h * towards the thumb
  const wristS = wristModel.clone().applyMatrix4(modelToSkin);
  const bindInv = skinned.bindMatrixInverse;
  const boneRest = skinned.skeleton.boneInverses.map((bi) => new THREE.Vector3().setFromMatrixPosition(bi.clone().invert()).applyMatrix4(bindInv));
  const boneIdx = (name) => bones.findIndex((b) => b.name === name);
  const palmLen = boneRest[boneIdx('middle-finger-phalanx-proximal')].clone().sub(wristS).dot(uS);
  const palmW = boneRest[boneIdx('index-finger-phalanx-proximal')].distanceTo(boneRest[boneIdx('pinky-finger-phalanx-proximal')]);
  const fingerAxis = {}; // proximal bone index -> {start, dir, len}
  for (const f of ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger']) {
    const a = boneIdx(`${f}-phalanx-proximal`), b = boneIdx(`${f}-phalanx-intermediate`);
    const d = boneRest[b].clone().sub(boneRest[a]);
    fingerAxis[a] = { start: boneRest[a], dir: d.clone().normalize(), len: d.length(), name: f };
  }
  const isBack = new Set(bones.map((b, i) => (/wrist|metacarpal/.test(b.name) && !/thumb/.test(b.name) ? i : -1)).filter((i) => i >= 0));
  const thumbMeta = boneIdx('thumb-metacarpal');

  // ---- the forearm in the same frame ----
  arm.updateMatrix();
  const armToModel = relMatrix(arm, model);
  const armToSkin = armToModel.clone().premultiply(modelToSkin);
  const modelToArm = armToModel.clone().invert();
  const nArm = n.clone().transformDirection(modelToArm);
  const uArm = u.clone().transformDirection(modelToArm);
  const ag = arm.geometry;
  ag.computeBoundingBox();
  // Where the forearm tube ends on the hand (the lip): hand skin closer to the wrist than this is under the tube.
  const lipB = new THREE.Vector3(0, ag.boundingBox.min.y, 0).applyMatrix4(armToSkin).sub(wristS).dot(uS);
  const elbowB = new THREE.Vector3(0, ag.boundingBox.max.y, 0).applyMatrix4(armToSkin).sub(wristS).dot(uS);

  // One growth map for the whole arm. B: metres from the wrist joint towards the fingers (negative up the
  // forearm), a: towards the thumb / palm width, facing: surface normal . palm normal (+1 palm side).
  const growth = (region, B, a, facing, t) => {
    if (region === 'arm') {
      const side = 0.04 + 0.96 * S(-facing, -0.45, 0.25);       // the back and both sides; ~0 on the palm side
      const up = -B;
      // full right to the end of the tube (the hand carries on from there); fades before the elbow end
      return side * (1 - S(up, -elbowB - 0.09, -elbowB - 0.015)) * (0.9 + 0.1 * S(up, 0.0, 0.12));
    }
    if (region === 'back') {
      if (B < lipB + 0.0015) return 0;
      const b = B / palmLen;
      const ulnar = S(-a, -0.2, 0.3);                          // the little-finger half keeps its hair
      const far = mix(0.1, 1.0, ulnar) * (1 - 0.85 * S(b, 0.4, 0.92));
      return S(-facing, 0.15, 0.55) * mix(1.0, far, S(b, 0.18, 0.45));
    }
    if (region === 'thumb') {
      if (B < lipB + 0.0015) return 0;
      return 0.22 * S(-facing, 0.15, 0.55) * (1 - S(B / palmLen, 0.3, 0.6));
    }
    // first finger segment: a small tuft on its back, away from both knuckles
    return 0.55 * S(-facing, 0.35, 0.7) * S(t, 0.12, 0.3) * (1 - S(t, 0.55, 0.78));
  };

  // ---- candidate triangles ----
  const hg = skinned.geometry;
  const hp = hg.attributes.position, hsi = hg.attributes.skinIndex, hsw = hg.attributes.skinWeight;
  const A = new THREE.Vector3(), Bv = new THREE.Vector3(), C = new THREE.Vector3(), cen = new THREE.Vector3(), fn = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const q = new THREE.Vector3(), fnS = new THREE.Vector3(), cenS = new THREE.Vector3();
  const list = [];
  const domBone = (tri) => {
    const acc = new Map();
    for (const v of tri) for (let k = 0; k < 4; k++) { const w = hsw.getComponent(v, k); if (w > 0) { const b = hsi.getComponent(v, k); acc.set(b, (acc.get(b) || 0) + w); } }
    let best = -1, bw = -1;
    for (const [b, w] of acc) if (w > bw) { bw = w; best = b; }
    return best;
  };
  for (const tri of triList(hg)) {
    A.fromBufferAttribute(hp, tri[0]); Bv.fromBufferAttribute(hp, tri[1]); C.fromBufferAttribute(hp, tri[2]);
    e1.subVectors(Bv, A); e2.subVectors(C, A); fn.crossVectors(e1, e2);
    const area = fn.length() * 0.5;
    if (area < 1e-10) continue;
    fn.normalize();
    cen.copy(A).add(Bv).add(C).multiplyScalar(1 / 3);
    q.copy(cen).sub(wristS);
    const B = q.dot(uS), a = h * q.dot(vS) / palmW, facing = fn.dot(nS);
    const db = domBone(tri);
    let region = null, t = 0;
    if (isBack.has(db)) region = 'back';
    else if (db === thumbMeta) region = 'thumb';
    else if (fingerAxis[db]) { region = 'finger'; const fa = fingerAxis[db]; t = cen.clone().sub(fa.start).dot(fa.dir) / fa.len; }
    if (!region) continue;
    const w = growth(region, B, a, facing, t);
    if (w > 0.01) list.push({ tri, area, w, region, src: 'hand', bone: db });
  }
  const ap = ag.attributes.position;
  for (const tri of triList(ag)) {
    A.fromBufferAttribute(ap, tri[0]); Bv.fromBufferAttribute(ap, tri[1]); C.fromBufferAttribute(ap, tri[2]);
    e1.subVectors(Bv, A); e2.subVectors(C, A); fn.crossVectors(e1, e2);
    const area = fn.length() * 0.5;
    if (area < 1e-10) continue;
    fn.normalize();
    cen.copy(A).add(Bv).add(C).multiplyScalar(1 / 3);
    cenS.copy(cen).applyMatrix4(armToSkin);
    fnS.copy(fn).transformDirection(armToSkin);
    q.copy(cenS).sub(wristS);
    const w = growth('arm', q.dot(uS), h * q.dot(vS) / palmW, fnS.dot(nS), 0);
    if (w > 0.01) list.push({ tri, area, w, region: 'arm', src: 'arm' });
  }

  // ---- how many strands: area x growth x density, the same everywhere ----
  let weighted = 0;
  for (const it of list) weighted += it.area * it.w;
  const want = Math.min(LOOK.maxStrands, Math.round(weighted * 1e4 * LOOK.perCm2 * density));
  if (!want) return null;

  const aRoot = new Float32Array(want * 3), aDir = new Float32Array(want * 3), aNrm = new Float32Array(want * 3);
  const aParm = new Float32Array(want * 4), aShape = new Float32Array(want * 4), aSkI = new Float32Array(want * 4), aSkW = new Float32Array(want * 4);
  const hn = hg.attributes.normal, an = ag.attributes.normal;
  const P = new THREE.Vector3(), Nn = new THREE.Vector3(), D = new THREE.Vector3(), tmp = new THREE.Vector3();
  const ulnarArm = new THREE.Vector3().crossVectors(uArm, nArm).normalize(); // = h * towards the thumb, on the forearm
  const armAxis = uArm.clone();
  const counts = { back: 0, thumb: 0, finger: 0, arm: 0 };
  const cdf = new Float64Array(list.length);
  let acc = 0;
  for (let i = 0; i < list.length; i++) { acc += list[i].area * list[i].w; cdf[i] = acc; }
  let made = 0, guard = 0;
  while (made < want && guard++ < want * 30) {
    const r = rand() * acc;
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    const item = list[lo];
    const [i0, i1, i2] = item.tri;
    let b1 = rand(), b2 = rand();
    if (b1 + b2 > 1) { b1 = 1 - b1; b2 = 1 - b2; }
    const b0 = 1 - b1 - b2;
    const posA = item.src === 'hand' ? hp : ap, nrmA = item.src === 'hand' ? hn : an;
    P.fromBufferAttribute(posA, i0).multiplyScalar(b0)
      .add(tmp.fromBufferAttribute(posA, i1).multiplyScalar(b1))
      .add(tmp.fromBufferAttribute(posA, i2).multiplyScalar(b2));
    Nn.fromBufferAttribute(nrmA, i0).multiplyScalar(b0)
      .add(tmp.fromBufferAttribute(nrmA, i1).multiplyScalar(b1))
      .add(tmp.fromBufferAttribute(nrmA, i2).multiplyScalar(b2)).normalize();
    // patchy growth: thinner in some places than others (never bald patches)
    const nz = vnoise(P.x * 180 + 3.1, P.y * 180, P.z * 180);
    if (rand() > 0.55 + 0.8 * nz) continue;

    // Growth direction in the tangent plane: towards the hand and the little-finger side, turned by a smooth
    // flow field (neighbours lie alike) plus a small scatter of each strand's own.
    const flow = (vnoise(P.x * 40 + 11.3, P.y * 40 + 2.2, P.z * 40 + 7.7) - 0.5) * 2;
    let len, yaw, bend = 0, curv = 0;
    const lr = Math.pow(rand(), 1.3);
    if (item.region === 'arm') {
      D.copy(armAxis).addScaledVector(ulnarArm, -0.4 * h);
      yaw = flow * 0.45 + (rand() - 0.5) * 0.9;
      len = mix(LOOK.len.arm[0], LOOK.len.arm[1], lr);
    } else if (item.region === 'finger') {
      D.copy(fingerAxis[item.bone].dir).addScaledVector(vS, -0.3 * h);
      yaw = (rand() - 0.5) * 0.6;
      len = mix(LOOK.len.finger[0], LOOK.len.finger[1], lr);
    } else {
      D.copy(uS).addScaledVector(vS, -0.55 * h);
      yaw = flow * 0.35 + (rand() - 0.5) * 0.5;
      len = item.region === 'thumb' ? mix(LOOK.len.thumb[0], LOOK.len.thumb[1], lr) : mix(LOOK.len.back[0], LOOK.len.back[1], lr);
    }
    D.addScaledVector(Nn, -D.dot(Nn)).normalize();
    tmp.crossVectors(Nn, D);
    D.multiplyScalar(Math.cos(yaw)).addScaledVector(tmp, Math.sin(yaw)).normalize();
    // Follow the skin's curve: across the forearm it is an ellipse (flatter on the back, tight at the sides),
    // along it nearly straight; the back of the hand is gently curved across.
    if (item.region === 'arm') {
      const along = D.dot(armAxis);
      const zr = P.z / 0.74, R = Math.max(Math.hypot(P.x, zr), 0.015), phi = Math.atan2(zr, P.x);
      const ea = R, eb = 0.74 * R, sp = Math.sin(phi), cp = Math.cos(phi);
      const kAcross = (ea * eb) / Math.pow(ea * ea * sp * sp + eb * eb * cp * cp, 1.5);
      curv = (1 - along * along) * kAcross;
    } else if (item.region !== 'finger') { const along = D.dot(uS); curv = (1 - along * along) / 0.05; }
    bend = 0.5 * len * len * curv;

    const o3 = made * 3, o4 = made * 4;
    aRoot[o3] = P.x; aRoot[o3 + 1] = P.y; aRoot[o3 + 2] = P.z;
    aDir[o3] = D.x; aDir[o3 + 1] = D.y; aDir[o3 + 2] = D.z;
    aNrm[o3] = Nn.x; aNrm[o3 + 1] = Nn.y; aNrm[o3 + 2] = Nn.z;
    aParm[o4] = len;
    aParm[o4 + 1] = mix(LOOK.width[0], LOOK.width[1], rand()) * (item.region === 'arm' ? 1 : 0.85);
    aParm[o4 + 2] = (rand() - 0.5) * 1.0;          // sideways curl
    aParm[o4 + 3] = rand();
    aShape[o4] = mix(LOOK.lift[0], LOOK.lift[1], rand());
    aShape[o4 + 1] = bend;
    aShape[o4 + 2] = (rand() - 0.5) * 0.8;         // S-curve
    aShape[o4 + 3] = 0.75 + 0.5 * rand();          // strand to strand colour
    if (item.src === 'arm') {
      aSkI[o4] = ARM_BONE; aSkW[o4] = 1;
    } else {
      // Skin weights interpolated across the triangle, top 4 kept and renormalised.
      const accW = new Map();
      [[i0, b0], [i1, b1], [i2, b2]].forEach(([v, bw]) => {
        for (let c = 0; c < 4; c++) { const w = hsw.getComponent(v, c) * bw; if (w > 0) { const bi = hsi.getComponent(v, c); accW.set(bi, (accW.get(bi) || 0) + w); } }
      });
      const top = [...accW.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const ws = top.reduce((x, e) => x + e[1], 0) || 1;
      for (let c = 0; c < 4; c++) { aSkI[o4 + c] = top[c] ? top[c][0] : 0; aSkW[o4 + c] = top[c] ? top[c][1] / ws : 0; }
    }
    counts[item.region]++;
    made++;
  }
  const count = made;

  // ---- strand geometry: (SEG+1) rows of 2 vertices, x = side (-1/1), y = t along the strand ----
  const geo = new THREE.BufferGeometry();
  const verts = [], index = [];
  for (let r = 0; r <= SEG; r++) { const t = r / SEG; verts.push(-1, t, 0, 1, t, 0); }
  for (let r = 0; r < SEG; r++) { const a = r * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(index);
  const inst = (arr, sz) => new THREE.InstancedBufferAttribute(arr.subarray(0, count * sz), sz);
  geo.setAttribute('aRoot', inst(aRoot, 3));
  geo.setAttribute('aDir', inst(aDir, 3));
  geo.setAttribute('aNrm', inst(aNrm, 3));
  geo.setAttribute('aParm', inst(aParm, 4));
  geo.setAttribute('aShape', inst(aShape, 4));
  geo.setAttribute('aSkI', inst(aSkI, 4));
  geo.setAttribute('aSkW', inst(aSkW, 4));

  const boneMats = Array.from({ length: NB }, () => new THREE.Matrix4());
  const uniforms = {
    uTime: { value: 0 },
    uHandVel: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.13, 0.13, 0.13) },   // replaced every frame by setLighting
    uKeyDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
    uKeyColor: { value: new THREE.Color(0.3, 0.3, 0.3) },
    uColor: { value: new THREE.Color(LOOK.root) },
    uTipColor: { value: new THREE.Color(LOOK.tip) },
    uOpacity: { value: 1.0 },
    uMinPx: { value: LOOK.minPx },
    uCover: { value: LOOK.cover },
    uBones: { value: boneMats },
    uViewH: { value: 1080 },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT.replace('BONE_COUNT', String(NB)),
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(count, 1));
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.name = `${side}-hand-hair`;
  mesh.renderOrder = 1;
  // The pixel-width floor needs the real viewport height.
  const vp = new THREE.Vector4();
  mesh.onBeforeRender = (renderer) => { renderer.getCurrentViewport(vp); if (vp.w > 0) uniforms.uViewH.value = vp.w; };
  model.add(mesh);

  // Skinning matrices: bind-space (skinned local) -> hair-mesh local, plus forearm local -> hair local.
  const hairInv = new THREE.Matrix4(), m = new THREE.Matrix4();
  // Call after the bones are posed and matrixWorld is current (hand.update does root.updateMatrixWorld).
  function update(dt = 0) {
    uniforms.uTime.value += dt;
    hairInv.copy(mesh.matrixWorld).invert();
    for (let i = 0; i < bones.length; i++) {
      m.multiplyMatrices(bones[i].matrixWorld, skinned.skeleton.boneInverses[i]).multiply(skinned.bindMatrix);
      boneMats[i].multiplyMatrices(hairInv, m);
    }
    boneMats[ARM_BONE].multiplyMatrices(hairInv, arm.matrixWorld);
  }
  model.updateMatrixWorld(true);
  update();

  console.info(`[handHair] ${side}: ${count} strands (back ${counts.back}, thumb ${counts.thumb}, fingers ${counts.finger}, forearm ${counts.arm}), ${count * (SEG + 1) * 2} verts`);
  function setLighting(l) {
    uniforms.uAmbient.value.copy(l.ambient);
    uniforms.uKeyDir.value.copy(l.keyDir);
    uniforms.uKeyColor.value.copy(l.keyColor);
  }
  return { mesh, uniforms, update, setLighting, counts, count };
}
