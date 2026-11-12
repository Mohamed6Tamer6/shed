// Separate, curved fingernail meshes for the first-person hands.
// Each nail is a thin shell built in its distal bone's local frame by casting rays from the bone axis
// onto the skinned mesh in rest pose, so it sits flush on the real fingertip surface and follows it
// once attached as a child of the distal bone. A skin-coloured fold arches over the base of the plate;
// its sides sink into the skin of the finger (no frame round the plate).
//
// Proportions from the nails photo (docs/hands/visual-gaps.md, gap 8): the plate is about 0.7 of the finger's
// width and 1.2 widths long, nearly parallel-sided, its base a round arch, its free edge a narrow curved band.
// The look values here replace HAND_CONFIG.nails.clearcoat; HAND_CONFIG.nails.length still scales the free edge.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HAND_CONFIG } from './handConfig.js';

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger', 'thumb'];
// half: half-width as an angle around the finger axis, hwMax caps it (metres), bed: nail-bed length as a
// multiple of the nail width, free: free edge length (metres, scaled by HAND_CONFIG.nails.length).
const SHAPE = {
  'index-finger': { half: 0.9, hwMax: 0.0054, bed: 1.1, free: 0.0012 },
  'middle-finger': { half: 0.92, hwMax: 0.0056, bed: 1.12, free: 0.0013 },
  'ring-finger': { half: 0.9, hwMax: 0.0052, bed: 1.1, free: 0.0012 },
  'pinky-finger': { half: 0.88, hwMax: 0.0045, bed: 1.06, free: 0.001 },
  thumb: { half: 1.1, hwMax: 0.0071, bed: 0.98, free: 0.0013 },
};
// color: linear multiplier on the photographed plate so the nail comes out as much lighter than this skin as the
// photo's bed is than the skin beside it (linear 1.34 / 1.59 / 2.1), held back where it turned the plate grey.
const LOOK = { clearcoat: 0.3, clearcoatRoughness: 0.14, roughness: 0.3, color: [1.03, 1.17, 1.17], map: 'nail_plate2.png' };
const T = 0.00036;           // plate thickness
const DIP = 0.00007;         // how far the plate edges sink into the skin
const NW = 8, NA = 6, NF = 2; // columns across, rows on the nail bed, rows on the free edge
const SMILE_V = 0.78;        // texture v of the free-edge line

// ---------- shared textures and materials (one set for all nails of both hands) ----------
// nail_plate.png / nail_bump.png are unwrapped from the nail reference photo by tools/make_hand_textures.py:
// u across the nail, v from the cuticle (row 0) to the free edge, smile line at v = SMILE_V.
const ASSETS = new URL('../../../assets/hands/', import.meta.url).href;
let shared = null;
function sharedMaterials(manager) {
  if (shared) return shared;
  const loader = new THREE.TextureLoader(manager);
  const map = loader.load(ASSETS + LOOK.map);
  map.colorSpace = THREE.SRGBColorSpace; map.flipY = false; map.anisotropy = 4;
  const bump = loader.load(ASSETS + 'nail_bump.png');
  bump.flipY = false; bump.anisotropy = 4;
  // A clear keratin plate over a pink bed: the colour is the map's, the gloss is a broad sheen on the bumped
  // (ridged) normal plus a thin clear coat for the glint. No longer whitened: the old 0xfff4ee and a strong
  // coat made the thumb nail read as a white tile at play distance.
  const nail = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(...LOOK.color, THREE.LinearSRGBColorSpace), map, bumpMap: bump, bumpScale: 0.45,
    roughness: LOOK.roughness, metalness: 0, ior: 1.55,
    clearcoat: LOOK.clearcoat, clearcoatRoughness: LOOK.clearcoatRoughness,
    side: THREE.DoubleSide,
  });
  nail.name = 'nails';
  // the fold is skin: the skin's tone as the shader leaves it next to the nail (a little flushed)
  const cuticle = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(HAND_CONFIG.skin.tone).multiply(new THREE.Color(1.0, 0.95, 0.94)), roughness: 0.55, metalness: 0, vertexColors: true,
    sheen: 0.15, sheenColor: new THREE.Color(0xffe6da), sheenRoughness: 0.55,
    side: THREE.DoubleSide,
  });
  cuticle.name = 'nail-cuticle';
  // The skin round them is lit with a soft terminator (handSkin.js); lit plainly, the plate and the fold come out
  // much darker than the finger whenever the light grazes it. Give both the same wrap (no light through them).
  const wrap = (w) => (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
void RE_Direct_Wrap(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  vec3 irradiance = saturate(nl) * directLight.color;
  #ifdef USE_CLEARCOAT
    float dotNLcc = saturate(dot(geometryClearcoatNormal, directLight.direction));
    clearcoatSpecularDirect += dotNLcc * directLight.color * BRDF_GGX_Clearcoat(directLight.direction, geometryViewDir, geometryClearcoatNormal, material);
  #endif
  #ifdef USE_SHEEN
    sheenSpecularDirect += irradiance * BRDF_Sheen(directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness);
  #endif
  reflectedLight.directSpecular += irradiance * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material);
  float dw = saturate((nl + ${w.toFixed(2)}) / (1.0 + ${w.toFixed(2)}));
  reflectedLight.directDiffuse += directLight.color * dw * BRDF_Lambert(material.diffuseColor);
}
#undef RE_Direct
#define RE_Direct RE_Direct_Wrap`);
  };
  nail.onBeforeCompile = wrap(0.18);
  nail.customProgramCacheKey = () => 'nail-wrap';
  cuticle.onBeforeCompile = wrap(0.36);           // the fingertip's skin has the thin parts' softer terminator
  cuticle.customProgramCacheKey = () => 'nail-fold-wrap';
  shared = { nail, cuticle };
  return shared;
}

// ---------- surface measurement ----------
let _bu = 0, _bv = 0;
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _t = new THREE.Vector3();
// Möller–Trumbore, both sides; returns distance or Infinity.
function rayTri(o, d, a, b, c) {
  _e1.subVectors(b, a); _e2.subVectors(c, a);
  _p.crossVectors(d, _e2);
  const det = _e1.dot(_p);
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  _t.subVectors(o, a);
  const u = _t.dot(_p) * inv; if (u < -1e-6 || u > 1 + 1e-6) return Infinity;
  _q.crossVectors(_t, _e1);
  const v = d.dot(_q) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) return Infinity;
  const t = _e2.dot(_q) * inv;
  if (t <= 0) return Infinity;
  _bu = u; _bv = v;
  return t;
}

function segDist(p, a, b) {
  const ab = _e1.subVectors(b, a), ap = _e2.subVectors(p, a);
  const h = THREE.MathUtils.clamp(ap.dot(ab) / ab.lengthSq(), 0, 1);
  return ap.addScaledVector(ab, -h).length();
}

export function createNails({ model, skinned, side = 'right', n, manager }) {
  const { nail: nailMat, cuticle: cutMat } = sharedMaterials(manager);
  const lenK = HAND_CONFIG.nails.length;
  model.updateMatrixWorld(true);
  skinned.skeleton.update();
  const bone = (name) => model.getObjectByName(name);
  const segNames = [];
  for (const f of FINGERS.slice(0, 4)) segNames.push([f, 'metacarpal'], [f, 'phalanx-proximal'], [f, 'phalanx-intermediate'], [f, 'phalanx-distal']);
  segNames.push(['thumb', 'metacarpal'], ['thumb', 'phalanx-proximal'], ['thumb', 'phalanx-distal']);
  const nextOf = (f, part) => {
    const order = f === 'thumb' ? ['metacarpal', 'phalanx-proximal', 'phalanx-distal', 'tip'] : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
    return order[order.indexOf(part) + 1];
  };
  const segs = segNames.filter(([f, p]) => bone(`${f}-${p}`) && bone(`${f}-${nextOf(f, p)}`)).map(([f, p]) => ({
    f, p, a: bone(`${f}-${p}`).getWorldPosition(new THREE.Vector3()), b: bone(`${f}-${nextOf(f, p)}`).getWorldPosition(new THREE.Vector3()),
  }));

  // Rest-pose skinned vertices in world space, tagged with their nearest bone segment.
  const pos = skinned.geometry.attributes.position;
  const nv = pos.count;
  const world = new Array(nv), owner = new Int16Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = skinned.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(skinned.matrixWorld);
    world[i] = v;
    let best = 1e9, bi = -1;
    for (let k = 0; k < segs.length; k++) { const d = segDist(v, segs[k].a, segs[k].b); if (d < best) { best = d; bi = k; } }
    owner[i] = bi;
  }
  const index = skinned.geometry.index;
  const triCount = index ? index.count / 3 : nv / 3;
  const tri = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  // Smooth rest-pose normals (world), area weighted; welded by position so UV seams do not crease.
  const normW = world.map(() => new THREE.Vector3());
  const key = (v) => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;
  const acc = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = world[tri(t, 0)], b = world[tri(t, 1)], c = world[tri(t, 2)];
    const fn = new THREE.Vector3().crossVectors(_t.subVectors(b, a), _q.subVectors(c, a));
    for (let k = 0; k < 3; k++) { const kk = key(world[tri(t, k)]); let m = acc.get(kk); if (!m) acc.set(kk, (m = new THREE.Vector3())); m.add(fn); }
  }
  for (let i = 0; i < nv; i++) normW[i].copy(acc.get(key(world[i]))).normalize();

  const meshes = [];
  const nm = n.clone().transformDirection(model.matrixWorld); // model space -> world
  for (const f of FINGERS) {
    const dist = bone(`${f}-phalanx-distal`), tipB = bone(`${f}-tip`);
    if (!dist || !tipB) continue;
    const sh = SHAPE[f];
    const inv = dist.matrixWorld.clone().invert();
    const tipL = tipB.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const L = tipL.length();
    const ax = tipL.clone().normalize();                                  // along the finger
    // Dorsal direction: the WebXR joint +Y (back of the finger), checked against -n for the fingers.
    const dorsal = new THREE.Vector3(0, 1, 0);
    const nLocal = nm.clone().transformDirection(inv).negate();
    if (f !== 'thumb' && dorsal.dot(nLocal) < 0.5) dorsal.copy(nLocal);
    dorsal.addScaledVector(ax, -dorsal.dot(ax)).normalize();
    const lat = new THREE.Vector3().crossVectors(ax, dorsal).normalize();

    // Triangles of this fingertip in bone-local space.
    const own = new Set(segs.map((s, k) => (s.f === f && (s.p === 'phalanx-distal' || s.p === 'phalanx-intermediate' || (f === 'thumb' && s.p === 'phalanx-proximal')) ? k : -1)).filter((k) => k >= 0));
    const local = new Map();
    const getL = (i) => { let v = local.get(i); if (!v) { v = world[i].clone().applyMatrix4(inv); local.set(i, v); } return v; };
    const tris = [], triIdx = [];
    for (let t = 0; t < triCount; t++) {
      const i0 = tri(t, 0), i1 = tri(t, 1), i2 = tri(t, 2);
      if (!own.has(owner[i0]) && !own.has(owner[i1]) && !own.has(owner[i2])) continue;
      const a = getL(i0), b = getL(i1), c = getL(i2);
      const sm = (a.dot(ax) + b.dot(ax) + c.dot(ax)) / 3;
      if (sm < -0.012 || sm > L + 0.04) continue;
      tris.push(a, b, c); triIdx.push(i0, i1, i2);
    }
    const o = new THREE.Vector3(), dir = new THREE.Vector3();
    const radial = (th) => dir.copy(dorsal).multiplyScalar(Math.cos(th)).addScaledVector(lat, Math.sin(th));
    // Exact surface point and smooth skin normal (bone-local) along a ray from the axis.
    const castN = (s, th) => {
      if (Math.abs(th) < 1e-3) th = 1e-3;               // a ray along a mesh edge can miss both triangles
      o.copy(ax).multiplyScalar(s);
      radial(th);
      let best = Infinity, bk = -1, bu = 0, bv = 0;
      for (let k = 0; k < tris.length; k += 3) { const d = rayTri(o, dir, tris[k], tris[k + 1], tris[k + 2]); if (d < best) { best = d; bk = k; bu = _bu; bv = _bv; } }
      const nrm = new THREE.Vector3();
      if (bk >= 0) {
        nrm.addScaledVector(normW[triIdx[bk]], 1 - bu - bv).addScaledVector(normW[triIdx[bk + 1]], bu).addScaledVector(normW[triIdx[bk + 2]], bv);
        nrm.transformDirection(inv);
        if (nrm.dot(dir) < 0) nrm.negate();
      } else nrm.copy(dir);
      return { r: best, n: nrm };
    };
    const cast = (s, th) => {
      o.copy(ax).multiplyScalar(s);
      radial(th);
      let best = Infinity;
      for (let k = 0; k < tris.length; k += 3) { const d = rayTri(o, dir, tris[k], tris[k + 1], tris[k + 2]); if (d < best) best = d; }
      return best;
    };

    // Where the flesh really ends: the mesh fingertip runs well past the 'tip' joint.
    o.set(0, 0, 0); dir.copy(ax);
    let E = Infinity;
    for (let k = 0; k < tris.length; k += 3) E = Math.min(E, rayTri(o, dir, tris[k], tris[k + 1], tris[k + 2]));
    if (!isFinite(E) || E < L) E = L + 0.002;
    // Dorsal plateau height and the point where the back of the finger starts rounding over the tip.
    const plateau = [];
    for (let k = 0; k <= 8; k++) { const r = cast(E * (0.5 + 0.025 * k), 0); if (isFinite(r)) plateau.push(r); }
    plateau.sort((x, y) => x - y);
    const R0 = plateau.length ? plateau[plateau.length >> 1] : 0.006;
    let sD = E - 0.0025;
    for (let s = E * 0.7; s < E; s += 0.00025) { const r = cast(s, 0); if (!isFinite(r) || r < R0 - 0.0004) { sD = s; break; } }
    const half = Math.min(sh.half, sh.hwMax / Math.max(R0, 1e-4));
    const width = 2 * half * R0;
    // Nail outline along the bone: bed ends a little before the rounding, free edge overhangs it.
    const sAtt = sD - 0.0006, sBase0 = sAtt - sh.bed * width, sEnd = sAtt + sh.free * lenK;

    // Measure the dorsal surface on a grid (s along the bone, angle across) and smooth it lightly.
    const thMax = half * 1.7;
    const GS = 26, GT = 15, s0g = sBase0 - 0.003, s1g = sEnd + 0.0008;
    const ds = (s1g - s0g) / (GS - 1);
    const grid = [];
    for (let i = 0; i < GS; i++) {
      const row = [];
      for (let j = 0; j < GT; j++) row.push(cast(s0g + ds * i, -thMax + 2 * thMax * j / (GT - 1)));
      grid.push(row);
    }
    // Past the rounding the plate no longer follows the flesh: it carries on with a gentle downward curve.
    // Each column is cut where it drops below its own bed height (the corners round off before the middle).
    const iBed0 = Math.max(0, Math.floor((sBase0 - s0g) / ds)), iBed1 = Math.floor((sAtt - 0.002 - s0g) / ds);
    const iCd = Math.min(GS - 1, Math.max(2, Math.floor((sD - 0.0003 - s0g) / ds)));
    for (let j = 0; j < GT; j++) {
      for (let i = 0; i < GS; i++) if (!isFinite(grid[i][j])) grid[i][j] = i > 0 ? grid[i - 1][j] : R0;
      const bedH = [];
      for (let i = iBed0; i <= Math.max(iBed0, iBed1); i++) bedH.push(grid[i][j]);
      bedH.sort((x, y) => x - y);
      const ref = bedH[bedH.length >> 1];
      let iC = iCd;
      for (let i = iBed1; i <= iCd; i++) if (grid[i][j] < ref - 0.0003) { iC = Math.max(2, i - 1); break; }
      let slope = (grid[iC][j] - grid[iC - 2][j]) / (2 * ds);
      slope = THREE.MathUtils.clamp(slope, -0.06, 0.04);
      for (let i = iC + 1; i < GS; i++) {
        const x = (i - iC) * ds;
        grid[i][j] = grid[iC][j] + slope * x - 25 * x * x;
      }
    }
    const raw = grid.map((r) => r.slice());
    // Finger half-width along the bone: the nail narrows with it where the fingertip tapers.
    const wid = [];
    for (let i = 0; i < GS; i++) {
      const w = (cast(s0g + ds * i, Math.PI / 2) + cast(s0g + ds * i, -Math.PI / 2)) / 2;
      wid.push(isFinite(w) ? w : (i > 0 ? wid[i - 1] * 0.9 : R0));
    }
    const wBed = wid.slice(Math.max(0, Math.floor((sBase0 - s0g) / ds)), Math.floor((sAtt - 0.003 - s0g) / ds) + 1).sort((x, y) => x - y);
    const wRef = wBed.length ? wBed[wBed.length >> 1] : R0;
    const rowAt = (tab, s) => {
      const f = THREE.MathUtils.clamp((s - s0g) / ds, 0, GS - 1.0001), i = Math.floor(f);
      return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
    };
    // a real plate is nearly parallel-sided: it follows the fingertip's taper only a little
    const taperAt = (s) => Math.pow(THREE.MathUtils.clamp(rowAt(wid, Math.min(s, sAtt)) / wRef, 0.8, 1), 0.6) * (s > sAtt ? 1 - 0.06 * (s - sAtt) / Math.max(1e-5, sEnd - sAtt) : 1);
    const TH = (u, s) => u * half * taperAt(s);
    for (let pass = 0; pass < 4; pass++) {
      const g2 = grid.map((r) => r.slice());
      for (let i = 0; i < GS; i++) for (let j = 0; j < GT; j++) {
        const a = grid[Math.max(0, i - 1)][j], b = grid[Math.min(GS - 1, i + 1)][j];
        const c = grid[i][Math.max(0, j - 1)], d = grid[i][Math.min(GT - 1, j + 1)];
        g2[i][j] = grid[i][j] * 0.5 + (a + b + c + d) * 0.125;
      }
      for (let i = 0; i < GS; i++) grid[i] = g2[i];
    }
    const surf = (s, th) => {
      const fi = THREE.MathUtils.clamp((s - s0g) / (s1g - s0g) * (GS - 1), 0, GS - 1.0001);
      const fj = THREE.MathUtils.clamp((th + thMax) / (2 * thMax) * (GT - 1), 0, GT - 1.0001);
      const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
      return (grid[i][j] * (1 - a) + grid[i + 1][j] * a) * (1 - b) + (grid[i][j + 1] * (1 - a) + grid[i + 1][j + 1] * a) * b;
    };
    const rawSurf = (s, th) => {
      const fi = THREE.MathUtils.clamp((s - s0g) / ds, 0, GS - 1.0001);
      const fj = THREE.MathUtils.clamp((th + thMax) / (2 * thMax) * (GT - 1), 0, GT - 1.0001);
      const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
      return (raw[i][j] * (1 - a) + raw[i + 1][j] * a) * (1 - b) + (raw[i][j + 1] * (1 - a) + raw[i + 1][j + 1] * a) * b;
    };
    const point = (s, th, r) => ax.clone().multiplyScalar(s).addScaledVector(radial(th), r);

    // Nail outline in (u across, s along): the base a round arch (nails photo: the corners 0.27 widths lower
    // than the middle, |u|^2.4), the smile line and the free edge curved like the fingertip (0.15 widths).
    const baseCurve = 0.27 * width, smileCurve = 0.12 * width, endCurve = 0.14 * width;
    const sBase = (u) => sBase0 + baseCurve * Math.pow(Math.abs(u), 2.4);
    const sSmile = (u) => sAtt - smileCurve * u * u;
    const sFree = (u) => sEnd - endCurve * u * u;
    // Height of the plate's top above the axis.
    const top = (u, s) => {
      const au = Math.min(1, Math.abs(u));
      const vb = (s - sBase(u)) / Math.max(1e-5, sAtt - sBase(u));
      const attached = 1 - THREE.MathUtils.smoothstep(s, sAtt - 0.0004, sAtt + 0.0003);
      const edge = Math.min(1, (1 - au ** 4) * 1.7);
      const rise = THREE.MathUtils.smoothstep(vb, 0, 0.16);
      const lift = T * edge * rise + T * 0.75 * (1 - attached) * (1 - edge * rise);
      // past the bed the plate keeps its cross-section and only follows the centre line
      const base = s <= sAtt ? surf(s, TH(u, s)) : surf(sAtt, TH(u, s)) + surf(s, 0) - surf(sAtt, 0);
      // crown: nails curve more than the finger, and the plate must clear the ridge of vertices that the 16-sided
      // finger mesh has along its top midline (it put a notch in the base of the plate and the fold)
      return base + lift - DIP * attached + 0.00034 * (1 - au * au);
    };

    const parts = [];
    const build = (verts, uvs, idx, cols) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      if (cols) g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    // Rows: NA on the bed (base -> smile line), NF on the free edge (smile -> free end).
    const rowS = (u, r) => (r <= NA ? THREE.MathUtils.lerp(sBase(u), sSmile(u), r / NA) : THREE.MathUtils.lerp(sSmile(u), sFree(u), (r - NA) / NF));
    const rowV = (r) => (r <= NA ? SMILE_V * r / NA : SMILE_V + (1 - SMILE_V) * (r - NA) / NF);
    const NR = NA + NF;
    {
      const v = [], uv = [], id = [];
      for (let r = 0; r <= NR; r++) for (let c = 0; c <= NW; c++) {
        const u = -1 + 2 * c / NW, s = rowS(u, r);
        v.push(...point(s, TH(u, s), top(u, s)).toArray()); uv.push((u + 1) / 2, rowV(r));
      }
      for (let r = 0; r < NR; r++) for (let c = 0; c < NW; c++) {
        const a = r * (NW + 1) + c, b = a + 1, d = a + NW + 1, e = d + 1;
        id.push(a, d, b, b, d, e);
      }
      parts.push(build(v, uv, id));
    }
    {
      // Underside of the free edge and its rim (front and the two short sides).
      const v = [], uv = [], id = [];
      const bot = (u, s) => top(u, s) - T;
      for (let r = NA; r <= NR; r++) for (let c = 0; c <= NW; c++) {
        const u = -1 + 2 * c / NW, s = rowS(u, r);
        v.push(...point(s, TH(u, s), bot(u, s)).toArray()); uv.push((u + 1) / 2, rowV(r));
      }
      for (let r = 0; r < NF; r++) for (let c = 0; c < NW; c++) {
        const a = r * (NW + 1) + c, b = a + 1, d = a + NW + 1, e = d + 1;
        id.push(a, b, d, b, e, d);
      }
      parts.push(build(v, uv, id));
      const rv = [], ruv = [], rid = [];
      const rim = [];
      for (let r = NA; r <= NR; r++) rim.push([-1, r]);
      for (let c = 1; c < NW; c++) rim.push([-1 + 2 * c / NW, NR]);
      for (let r = NR; r >= NA; r--) rim.push([1, r]);
      rim.forEach(([u, r], k) => {
        const s = rowS(u, r);
        rv.push(...point(s, TH(u, s), top(u, s)).toArray(), ...point(s, TH(u, s), bot(u, s)).toArray());
        ruv.push((u + 1) / 2, rowV(r), (u + 1) / 2, rowV(r));
        if (k > 0) { const a = (k - 1) * 2; rid.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
      });
      parts.push(build(rv, ruv, rid));
    }
    const geo = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    const mesh = new THREE.Mesh(geo, nailMat);
    mesh.name = `${f}-nail`;
    mesh.frustumCulled = false;

    // The proximal nail fold: a soft skin strip arching over the base of the plate, thinning out at its ends
    // where the side folds take over (those are the finger's own skin, into which the plate's edges sink).
    {
      const path = [];
      const NB = 12;
      for (let k = 0; k <= NB; k++) { const u = -1 + 2 * k / NB; path.push({ u, s: sBase(u), w: 0.2 + 0.8 * Math.pow(Math.sin(Math.PI * k / NB), 0.5) }); }
      const Rm = R0;
      const v = [], uv = [], col = [], id = [], skinN = [];
      const rowsAt = [[], [], []];
      path.forEach((pt, k) => {
        const pa = path[Math.max(0, k - 1)], pb = path[Math.min(path.length - 1, k + 1)];
        // tangent in metric (arc, s) space; outward normal points away from the nail centre
        let tx = (pb.u - pa.u) * half * taperAt(pt.s) * Rm, ts = pb.s - pa.s;
        const tl = Math.hypot(tx, ts) || 1; tx /= tl; ts /= tl;
        const nx = ts, ns = -tx; // path runs left side (down) -> base -> right side (up), so this points outward
        const fold = 0.0001 * pt.w;
        const rows = [[-0.00045 * pt.w, 'in'], [0.0001 * pt.w, 'mid'], [0.00045 * pt.w + 0.00015, 'out']];
        rows.forEach(([off, kind], j) => {
          const u = pt.u + nx * off / (half * taperAt(pt.s) * Rm), s = pt.s + ns * off;
          const hit = castN(s, TH(u, s));
          const sk = isFinite(hit.r) ? hit.r : rawSurf(s, TH(u, s));
          // the fold must clear any skin vertex between its rows, so look a little either side
          let skNear = sk;
          const du = 0.0003 / (half * taperAt(pt.s) * Rm);
          for (const [es, eu] of [[-0.00025, 0], [0.00025, 0], [0, du], [0, -du]]) { const q = castN(s + es, TH(u + eu, s + es)).r; if (isFinite(q)) skNear = Math.max(skNear, q); }
          let r;
          if (kind === 'in') r = Math.max(top(u, s), sk) + 0.00004;
          else if (kind === 'mid') r = Math.max(top(Math.max(-1, Math.min(1, u)), s), skNear) + fold;
          else { r = Math.min(skNear, sk + 0.00012) + 0.00002; skinN.push(hit.n); }
          rowsAt[j].push({ s, th: TH(u, s), r });
          uv.push(k / (path.length - 1), j / 2);
          // the cuticle itself is a thin paler rim on the plate; the fold is the finger's skin
          const ao = kind === 'in' ? 1.04 : kind === 'mid' ? 0.98 : 1.0;
          col.push(ao, ao, ao);
        });
        if (k > 0) {
          const a = (k - 1) * 3, b = k * 3;
          id.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
        }
      });
      // A single skin vertex poking up at one point of the arch put a notch in the fold: smooth each row's height
      // along the arch (never below what it was, so the fold still clears the skin).
      for (const row of rowsAt) {
        for (let pass = 0; pass < 3; pass++) {
          const rr = row.map((q) => q.r);
          for (let k = 1; k < row.length - 1; k++) row[k].r = Math.max(rr[k], 0.25 * rr[k - 1] + 0.5 * rr[k] + 0.25 * rr[k + 1]);
          const r2 = row.map((q) => q.r);
          for (let k = 1; k < row.length - 1; k++) row[k].r = Math.max(rr[k], 0.25 * r2[k - 1] + 0.5 * r2[k] + 0.25 * r2[k + 1]);
        }
      }
      for (let k = 0; k < path.length; k++) for (let j = 0; j < 3; j++) { const q = rowsAt[j][k]; v.push(...point(q.s, q.th, q.r).toArray()); }
      const cg = build(v, uv, id, col);
      // Make sure triangles face outward (away from the axis).
      const p0 = new THREE.Vector3().fromBufferAttribute(cg.attributes.position, path.length * 3 / 2 | 0);
      const n0 = new THREE.Vector3().fromBufferAttribute(cg.attributes.normal, path.length * 3 / 2 | 0);
      if (n0.dot(p0.clone().addScaledVector(ax, -p0.dot(ax))) < 0) {
        const ix = cg.index.array; for (let q = 0; q < ix.length; q += 3) { const t = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = t; }
        cg.computeVertexNormals();
      }
      // The whole fold takes the skin's own normal (the rim on the plate only a little of its own), so it shades
      // like the finger round it and reads as skin lying over the plate, not as a separate band.
      const na = cg.attributes.normal, tmpN = new THREE.Vector3();
      skinN.forEach((sn, k) => {
        na.setXYZ(k * 3 + 2, sn.x, sn.y, sn.z);
        na.setXYZ(k * 3 + 1, sn.x, sn.y, sn.z);
        tmpN.fromBufferAttribute(na, k * 3).lerp(sn, 0.8).normalize();
        na.setXYZ(k * 3, tmpN.x, tmpN.y, tmpN.z);
      });
      const cm = new THREE.Mesh(cg, cutMat);
      cm.name = `${f}-cuticle`;
      cm.frustumCulled = false;
      mesh.add(cm);
    }
    // Same check for the nail shell: top surface must face away from the axis.
    {
      const g = mesh.geometry, c = (NR / 2 | 0) * (NW + 1) + NW / 2;
      const p0 = new THREE.Vector3().fromBufferAttribute(g.attributes.position, c);
      const n0 = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, c);
      if (n0.dot(p0.clone().addScaledVector(ax, -p0.dot(ax))) < 0) {
        const ix = g.index.array; for (let q = 0; q < ix.length; q += 3) { const t = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = t; }
        g.computeVertexNormals();
      }
    }
    mesh.userData.nail = { finger: f, side, width, length: sEnd - sBase0, R0, L, E, sD, wRef };
    dist.add(mesh);
    meshes.push(mesh);
  }

  function setSkinColor(color) { cutMat.color.copy(color); }
  return { meshes, setSkinColor, materials: [nailMat, cutMat] };
}
