import * as THREE from 'three';

// Deterministic random numbers so the scene looks the same on every load.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

// Value noise in 3D, range 0..1.
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

// Fractal noise, range roughly -1..1.
export function fbm(x, y, z, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (noise3(x * f, y * f, z * f) * 2 - 1);
    amp *= 0.5;
    f *= 2.03;
  }
  return sum;
}

/**
 * Surface of revolution around Y with proper hard edges and UVs.
 * profile: [[radius, y], ...] from bottom to top. A point given as [r, y, true] is a hard edge.
 * UVs: u runs 0..uRepeat around, v runs 0..1 along the profile height (or arc length with vByLength).
 */
export function lathe(profile, { segments = 64, uRepeat = 1, vByLength = false, vRange = null } = {}) {
  const rings = [];
  const n = profile.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1];
    const len = Math.hypot(dr, dy) || 1;
    segN.push([dy / len, -dr / len]);
  }
  let arc = 0;
  const arcs = [0];
  for (let i = 1; i < n; i++) {
    arc += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
    arcs.push(arc);
  }
  const y0 = vRange ? vRange[0] : profile[0][1], y1 = vRange ? vRange[1] : profile[n - 1][1];
  for (let i = 0; i < n; i++) {
    const [r, y, hard] = profile[i];
    const v = vByLength ? arcs[i] / arc : (y - y0) / (y1 - y0 || 1);
    const prev = segN[Math.max(0, i - 1)], next = segN[Math.min(n - 2, i)];
    if (hard && i > 0 && i < n - 1) {
      rings.push({ r, y, v, n: prev });
      rings.push({ r, y, v, n: next });
    } else {
      const nx = prev[0] + next[0], ny = prev[1] + next[1];
      const l = Math.hypot(nx, ny) || 1;
      rings.push({ r, y, v, n: [nx / l, ny / l] });
    }
  }
  const pos = [], nor = [], uv = [], idx = [];
  for (const ring of rings) {
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      pos.push(ring.r * c, ring.y, ring.r * sn);
      nor.push(ring.n[0] * c, ring.n[1], ring.n[0] * sn);
      uv.push((s / segments) * uRepeat, ring.v);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    if (rings[i].r === rings[i + 1].r && rings[i].y === rings[i + 1].y) continue;
    for (let s = 0; s < segments; s++) {
      const a = i * row + s, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Points along a quarter ellipse, handy for rounded shoulders in lathe profiles.
export function arcPoints(cx, cy, rx, ry, a0, a1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

export function scaleUV(geo, su, sv = su, ou = 0, ov = 0) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  uv.needsUpdate = true;
  return geo;
}

/** Box whose UVs are in metres (divided by `tile`), so textures keep one scale on every face. */
export function boxMetric(w, h, d, tile = 1, uvOffset = [0, 0]) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each.
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile + uvOffset[0], (uv.getY(i) * dims[f][1]) / tile + uvOffset[1]);
    }
  }
  return g;
}

export function shadows(obj, cast = true, receive = true) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
}

export function canvasTexture(w, h, draw, { srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

/** Box for timber: like boxMetric, but the texture's V axis (the grain) follows the longest side. */
export function beamGeo(w, h, d, tile = 1, uvOffset = [0, 0]) {
  const g = boxMetric(w, h, d, tile, uvOffset);
  const long = Math.max(w, h, d);
  const uDims = [d, d, w, w, w, w];
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    if (uDims[f] !== long) continue;
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getY(i), uv.getX(i));
    }
  }
  return g;
}

/**
 * Recomputes normals on a grid surface (rows of `cols` vertices, first and last column coincide)
 * and welds them across the seam, for lathes and tubes that were displaced after creation.
 */
export function gridNormals(geo, cols) {
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const rows = n.count / cols;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    const i = r * cols, j = i + cols - 1;
    a.fromBufferAttribute(n, i);
    b.fromBufferAttribute(n, j);
    a.add(b).normalize();
    n.setXYZ(i, a.x, a.y, a.z);
    n.setXYZ(j, a.x, a.y, a.z);
  }
  n.needsUpdate = true;
  return geo;
}

/** 2D outline of a bar that follows `centre` (array of [x, y]) with half-thickness t(u), u in 0..1. */
export function ribbonShape(centre, t) {
  const curve = new THREE.CatmullRomCurve3(centre.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const N = 28, up = [], down = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const p = curve.getPoint(u), tan = curve.getTangent(u);
    const h = typeof t === 'function' ? t(u) : t;
    up.push([p.x - tan.y * h, p.y + tan.x * h]);
    down.push([p.x + tan.y * h, p.y - tan.x * h]);
  }
  const s = new THREE.Shape();
  s.moveTo(up[0][0], up[0][1]);
  for (let i = 1; i <= N; i++) s.lineTo(up[i][0], up[i][1]);
  // rounded tip
  const [ux, uy] = up[N], [dx, dy] = down[N];
  const tip = curve.getPoint(1), tt = curve.getTangent(1), r = Math.hypot(ux - dx, uy - dy) / 2;
  s.quadraticCurveTo(ux + tt.x * r, uy + tt.y * r, tip.x + tt.x * r, tip.y + tt.y * r);
  s.quadraticCurveTo(dx + tt.x * r, dy + tt.y * r, dx, dy);
  for (let i = N - 1; i >= 0; i--) s.lineTo(down[i][0], down[i][1]);
  s.closePath();
  return s;
}
