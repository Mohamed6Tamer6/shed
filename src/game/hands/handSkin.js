// Skin for the first-person hands and forearms.
// Everything is computed in the mesh's rest (bind-pose) space, so nothing swims when the bones move
// and no UVs are needed. One MeshPhysicalMaterial per mesh, patched in onBeforeCompile:
//   albedo   : one tone from the fingers to the elbow; mottling, freckles and follicle dots; knuckle pads
//              (darker ovals with their own folds, not coloured bands); pinker, paler palm and finger pads;
//              flushed fingertips; a faint cast over the veins of the inner wrist
//   relief   : form the mesh does not have, as shading: the big knuckles, the dorsal veins (one network
//              that carries on over the wrist onto the forearm), the extensor tendons, the head of the ulna,
//              knuckle folds, flexion creases and palm lines as grooves; photographed / synthesised micro
//              relief (assets/hands/skin_*2.png) sampled triplanar in rest space, faded by pixel size.
//              Every thin line is pre-filtered for the pixel it falls in (wider and fainter when small).
//   lighting : a soft, nearly neutral terminator (a narrow warm band, not red shadows), light through thin
//              parts only when they are really against the light, a two-lobe specular that carries the
//              micro relief, a faint rim. Scene lights, shadows and envMap work as usual.
// Look values live in LOOK below (they replace HAND_CONFIG.skin.roughness / sss / rim / redness / veins /
// tileBack / tilePalm); HAND_CONFIG.skin.tone, .detail and .freckles still apply.
import * as THREE from 'three';
import { HAND_CONFIG } from './handConfig.js';

const C = HAND_CONFIG.skin;
const HQ = HAND_CONFIG.quality !== 'low';
const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const LOOK = {
  roughness: [0.42, 0.74],   // oily back of the hand .. creases and palm
  wrap: 0.22,                // terminator softness (thin parts get more)
  through: 0.3,              // light through fingers and webs against a light behind them
  rim: 0.14,
  sheen: 0.15,
  relief: 0.2,               // strength of the micro-relief normal (was 0.62 with coarser maps)
  tileBack: 0.028,           // metres of skin per tile of the back-of-hand micro relief
  tilePalm: 0.026,           // the same for the palm ridges
  maps: ['skin_back2.png', 'skin_palm2.png'],
};

const TONES = { natural: new THREE.Color(C.tone), white: new THREE.Color(0xf3efe8) };
const ASSETS = new URL('../../../assets/hands/', import.meta.url).href;

// The two detail maps, loaded once and shared by both hands.
let sharedMaps = null;
function detailMaps(manager) {
  if (sharedMaps) return sharedMaps;
  const loader = new THREE.TextureLoader(manager);
  const load = (name) => {
    const t = loader.load(ASSETS + name);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;                                            // data, not colour: no colour space
  };
  sharedMaps = { back: load(LOOK.maps[0]), palm: load(LOOK.maps[1]) };
  return sharedMaps;
}
const SHEENS = { natural: new THREE.Color(0xffe6da), white: new THREE.Color(0xfff6f0) };   // vellus hair and oil: nearly white

// ---------------------------------------------------------------- shared GLSL
const COMMON_GLSL = /* glsl */`
uniform float uSkinTone;
uniform float uTension;
uniform sampler2D tSkinBack;
uniform sampler2D tSkinPalm;
uniform vec3 uSkinTile;   // 1 / tile size (m) of the back and palm maps, detail strength
uniform float uPalmLen; uniform float uPalmW;
varying vec3 vRest;
varying vec3 vRestN;
varying mat3 vR2V;        // rest space -> view space, for the relief of the detail maps
#define SK_R0 ${f(LOOK.roughness[0])}
#define SK_R1 ${f(LOOK.roughness[1])}
#define SK_WRAP ${f(LOOK.wrap)}
#define SK_THROUGH ${f(LOOK.through)}
#define SK_RIM ${f(LOOK.rim)}
#define SK_RELIEF ${f(LOOK.relief)}
#define SK_FRECK ${f(C.freckles)}
// Read by the light functions below (set once per fragment in color_fragment).
float gThin = 0.0;
float gAO = 1.0;
float gSpecOcc = 1.0;
vec3 gSSSCol = vec3(0.0);
vec3 gGrad = vec3(0.0);   // slope of the micro relief, rest space

float sk_h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sk_vn(vec3 x) {
  vec3 i = floor(x), t = fract(x); t = t * t * (3.0 - 2.0 * t);
  return mix(mix(mix(sk_h31(i), sk_h31(i + vec3(1, 0, 0)), t.x), mix(sk_h31(i + vec3(0, 1, 0)), sk_h31(i + vec3(1, 1, 0)), t.x), t.y),
             mix(mix(sk_h31(i + vec3(0, 0, 1)), sk_h31(i + vec3(1, 0, 1)), t.x), mix(sk_h31(i + vec3(0, 1, 1)), sk_h31(i + vec3(1, 1, 1)), t.x), t.y), t.z);
}
float sk_lm(float s, float c, float w) { float t = (s - c) / w; return exp(-t * t); }
// A line of half-width w (m) at distance d, pre-filtered for a pixel footprint fw: wider and fainter when small.
float sk_line(float d, float w, float fw) { float we = max(w, fw * 0.75); return (w / we) * exp(-(d * d) / (we * we)); }
// The same with its derivative along d: (value, d value / d d).
vec2 sk_lineD(float d, float w, float fw) { float we = max(w, fw * 0.75); float v = (w / we) * exp(-(d * d) / (we * we)); return vec2(v, v * (-2.0 * d / (we * we))); }
// A soft ridge along segment a-b (2D), r its visible half-width: (height 0..1, a Gaussian across, its 2D gradient).
// Relief is carried as analytic gradients, not screen derivatives, so it stays smooth (no 2x2 pixel steps).
vec3 sk_tube(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a; float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  vec2 d = pa - ba * t;
  float s2 = 0.36 * r * r;                       // sigma = 0.6 r
  float hgt = exp(-0.5 * dot(d, d) / s2);
  return vec3(hgt, (-hgt / s2) * d);
}
vec3 sk_vmax(vec3 a, vec3 b) { return a.x >= b.x ? a : b; }

// The veins of the back of the hand and the forearm, as one network in the hand's frame:
// A towards the thumb, B from the wrist joint towards the fingers (metres). Returns the height (m) in x, its
// gradient along A and B in yz and how much of a vein is here (0..1) in w. back / inner: weights of the back
// side and of the palm side.
vec4 skVeins(vec2 P, float back, float inner) {
  vec2 sc = vec2(uPalmW, uPalmLen);
  P += (vec2(sk_vn(vec3(P * 45.0, 1.7)), sk_vn(vec3(P * 45.0, 8.3))) - 0.5) * 0.004;   // meander
  vec3 g = vec3(0.0);
  float m = 0.0;
  if (back > 0.001) {
    // main vein: from the little-finger side of the forearm across the wrist, forking on the back of the hand
    vec3 v1 = sk_tube(P, vec2(-0.30, -2.2) * sc, vec2(-0.34, -1.1) * sc, 0.0027);
    v1 = sk_vmax(v1, sk_tube(P, vec2(-0.34, -1.1) * sc, vec2(-0.30, -0.35) * sc, 0.0026));
    v1 = sk_vmax(v1, sk_tube(P, vec2(-0.30, -0.35) * sc, vec2(-0.18, 0.02) * sc, 0.0025));
    v1 = sk_vmax(v1, sk_tube(P, vec2(-0.18, 0.02) * sc, vec2(-0.03, 0.24) * sc, 0.0024));
    v1 = sk_vmax(v1, sk_tube(P, vec2(-0.03, 0.24) * sc, vec2(0.13, 0.43) * sc, 0.0022));
    v1 = sk_vmax(v1, sk_tube(P, vec2(0.13, 0.43) * sc, vec2(0.27, 0.6) * sc, 0.002));
    v1 = sk_vmax(v1, sk_tube(P, vec2(0.27, 0.6) * sc, vec2(0.33, 0.78) * sc, 0.0016));
    // its branch towards the gap between the middle and ring fingers
    vec3 v2 = sk_vmax(sk_tube(P, vec2(-0.03, 0.24) * sc, vec2(-0.07, 0.46) * sc, 0.0014),
                      sk_tube(P, vec2(-0.07, 0.46) * sc, vec2(-0.02, 0.68) * sc, 0.0012));
    v2 = sk_vmax(v2, sk_tube(P, vec2(-0.02, 0.68) * sc, vec2(0.0, 0.84) * sc, 0.001));
    // the thumb-side vein up the forearm, joining at the middle of the back of the hand
    vec3 v3 = sk_vmax(sk_tube(P, vec2(0.6, -2.2) * sc, vec2(0.52, -0.9) * sc, 0.0019),
                      sk_tube(P, vec2(0.52, -0.9) * sc, vec2(0.46, -0.2) * sc, 0.0017));
    v3 = sk_vmax(v3, sk_tube(P, vec2(0.46, -0.2) * sc, vec2(0.38, 0.18) * sc, 0.0015));
    v3 = sk_vmax(v3, sk_tube(P, vec2(0.38, 0.18) * sc, vec2(0.13, 0.43) * sc, 0.0014));
    // a thinner one on the little-finger side
    vec3 v4 = sk_vmax(sk_tube(P, vec2(-0.18, 0.02) * sc, vec2(-0.37, 0.32) * sc, 0.0012),
                      sk_tube(P, vec2(-0.37, 0.32) * sc, vec2(-0.35, 0.6) * sc, 0.0011));
    v4 = sk_vmax(v4, sk_tube(P, vec2(-0.35, 0.6) * sc, vec2(-0.33, 0.84) * sc, 0.0009));
    float fade = 1.0 - smoothstep(0.7, 0.92, P.y / uPalmLen);                       // dies out before the knuckles
    g = (0.00045 * v1 + 0.0003 * v2 + 0.00035 * v3 + 0.00022 * v4) * back * fade;
    m = max(max(v1.x, v2.x), max(v3.x, v4.x)) * back * fade;
  }
  if (inner > 0.001) {
    // inner wrist: two blue lines under thin skin, hardly raised
    vec3 w1 = sk_vmax(sk_tube(P, vec2(0.16, 0.08) * sc, vec2(0.12, -0.5) * sc, 0.0013), sk_tube(P, vec2(0.12, -0.5) * sc, vec2(0.2, -1.4) * sc, 0.0014));
    vec3 w2 = sk_vmax(sk_tube(P, vec2(-0.2, 0.06) * sc, vec2(-0.14, -0.6) * sc, 0.0011), sk_tube(P, vec2(-0.14, -0.6) * sc, vec2(-0.05, -1.3) * sc, 0.0012));
    vec3 wi = sk_vmax(w1, w2) * inner * (1.0 - smoothstep(0.12, 0.3, P.y / uPalmLen));
    g += 0.00015 * wi;
    m = max(m, wi.x);
  }
  return vec4(g, m);
}

struct SkinOut {
  vec3 g;         // slope of the relief (height gradient), rest space
  float crease;   // dark crease lines
  float ao;       // crease occlusion 0..1
  float thin;     // how thin the flesh is (light through it)
  float red;      // flushed areas
  float knuck;    // knuckle skin
  float palm;     // palm-side paleness
  float vein;
  float bed;      // nail bed (under the nail mesh)
  float cuticle;  // ring around the nail base
  float freck;
  float pores;
  float mot;      // fine mottling
  float blot;     // large blotches
  float follicle; // hair follicle dots (forearm, back of the hand)
  float tendon;
  float detail;   // micro relief brightness, -1 (dark line) .. 1
  float pink;     // pads of the palm and fingers
  float innerV;   // blue cast of the inner-wrist veins
};

void skinCommon(vec3 p, float fw, inout SkinOut S) {
  S.blot = sk_vn(p * 22.0) * 0.55 + sk_vn(p * 61.0 + 4.0) * 0.45;
  S.mot = sk_vn(p * 140.0) * 0.5 + sk_vn(p * 330.0 + 9.0) * 0.5;
  float dots = 1.0 - smoothstep(0.00025, 0.0009, fw);
  S.freck = max(S.freck, smoothstep(0.8, 0.92, sk_vn(p * 700.0 + 17.0)) * smoothstep(0.3, 0.7, sk_vn(p * 38.0 + 2.0)) * dots);
  // micro relief: the back-of-hand map and the palm map, mixed by where we are; each read only where needed
  {
    vec3 w = pow(abs(normalize(vRestN)), vec3(4.0));
    w /= w.x + w.y + w.z;
    float fadeT = (1.0 - smoothstep(0.0012, 0.0036, fw)) * uSkinTile.z;
    vec4 td = vec4(0.0);
    if (fadeT > 0.001) {
      vec3 pb = p * uSkinTile.x, pp = p * uSkinTile.y;
      if (S.palm < 0.98) {
        vec3 a = texture2D(tSkinBack, pb.yz).rgb - 0.5, b = texture2D(tSkinBack, pb.zx + 0.37).rgb - 0.5, c = texture2D(tSkinBack, pb.xy + 0.71).rgb - 0.5;
        td += (1.0 - S.palm) * vec4(w.x * vec3(0.0, a.r, a.g) + w.y * vec3(b.g, 0.0, b.r) + w.z * vec3(c.r, c.g, 0.0), dot(w, vec3(a.b, b.b, c.b)));
      }
      if (S.palm > 0.02) {
        vec3 a = texture2D(tSkinPalm, pp.yz).rgb - 0.5, b = texture2D(tSkinPalm, pp.zx + 0.37).rgb - 0.5, c = texture2D(tSkinPalm, pp.xy + 0.71).rgb - 0.5;
        td += S.palm * vec4(w.x * vec3(0.0, a.r, a.g) + w.y * vec3(b.g, 0.0, b.r) + w.z * vec3(c.r, c.g, 0.0), dot(w, vec3(a.b, b.b, c.b))) * vec4(0.8, 0.8, 0.8, 0.8);
      }
      td *= 2.0 * fadeT;
    }
    gGrad = td.xyz;
    S.detail = td.w;
  }
#ifdef SKIN_HQ
  float fade = 1.0 - smoothstep(0.00025, 0.0009, fw);
  // pores: small dark pits on a ~0.5 mm lattice, fewer on the palm (its ridges hide them); relief from the maps
  S.pores = smoothstep(0.74, 0.92, sk_vn(p * 2100.0)) * fade * (0.6 - 0.4 * S.palm);
#endif
}
`;

// ---------------------------------------------------------------- hand detail (rest space of the skinned mesh)
const HAND_GLSL = /* glsl */`
uniform vec3 uJ[20];
uniform vec3 uHV; uniform vec3 uHU; uniform vec3 uHN; uniform vec3 uWrist;
// Bend of the joint at the start of each segment (index, middle, ring, little: knuckle, middle, end joint;
// thumb: base, knuckle, end joint), radians, as hand.js poses them. All 0 until hand.js writes them (see
// createSkinMaterials): then folds over a bent joint stretch smooth and the creases under it close up.
uniform float uBend[15];
float sk_seg(vec2 p, vec2 a, vec2 b, out float t) { vec2 pa = p - a, ba = b - a; t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * t); }
float sk_poly(vec2 p, vec2 P[6], int n) { float d = 1e3, t; for (int i = 0; i < 5; i++) { if (i >= n - 1) break; d = min(d, sk_seg(p, P[i], P[i + 1], t)); } return d; }

// Folds of a knuckle: lines across the finger, bowed, broken, a little wavy. s along the finger, lat across.
// Returns (darkness of the fold lines, their slope along w); w grows along the finger, so the slope's direction
// is d + 0.9 lat / halfW * (across).
vec2 skFolds(float s, float lat, float sp, float halfW, vec3 pn, float seed, float fw) {
  float w = s + 0.45 * lat * lat / halfW + (sk_vn(pn * 650.0 + seed) - 0.5) * 0.0007;
  float ph = w / sp;
  float id = floor(ph);
  float d = (fract(ph) - 0.5) * sp;
  float str = (0.35 + 0.65 * sk_h31(vec3(id, seed, 3.7))) * smoothstep(0.25, 0.6, sk_vn(vec3(id * 3.1, lat * 900.0, seed)));
  return sk_lineD(d, 0.00016, fw) * str;
}
vec3 sk_polyD(vec2 p, vec2 P[6], int n) {      // distance to a polyline and the unit direction away from it
  float best = 1e3; vec2 dir = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    if (i >= n - 1) break;
    vec2 pa = p - P[i], ba = P[i + 1] - P[i];
    float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    vec2 dv = pa - ba * t; float dd = length(dv);
    if (dd < best) { best = dd; dir = dv / max(dd, 1e-7); }
  }
  return vec3(best, dir);
}

void handFields(vec3 p, vec3 nr, vec3 pn, float fw, inout SkinOut S) {
  float palmN = dot(nr, uHN);                 // +1 palm side, -1 back of the hand
  S.palm = smoothstep(0.05, 0.6, palmN);
  float back = smoothstep(-0.05, -0.5, palmN);
  vec3 q = p - uWrist;
  float A = dot(q, uHV), B = dot(q, uHU), Nn = dot(q, uHN);
  float a = A / uPalmW, b = B / uPalmLen;
  float lineK = 1.0 - smoothstep(0.0004, 0.0012, fw);   // relief of fine lines only where a pixel can show it

  for (int fi = 0; fi < 5; fi++) {
    bool thumb = fi == 4;
    for (int k = 0; k < 3; k++) {
      vec3 J0 = uJ[fi * 4 + k], J1 = uJ[fi * 4 + k + 1];
      vec3 d = J1 - J0; float L = length(d); d /= L;
      float s = dot(p - J0, d);
      if (s < -0.018 || s > L + (k == 2 ? 0.022 : 0.008)) continue;
      vec3 r = p - J0 - s * d; float rl = length(r);
      if (rl > 0.021) continue;
      vec3 rn = r / max(rl, 1e-5);
      float rf = 1.0 - smoothstep(0.013, 0.02, rl);   // fade everything out before the cut-off
      float side = dot(rn, uHN);
      float brk = 0.45 + 0.55 * sk_vn(pn * 350.0 + float(fi * 3 + k));  // creases are broken, not drawn
      vec3 latD = normalize(cross(d, uHN));
      float lat = dot(r, latD);
      float t = s / L;
      bool mcp = k == 0 && !thumb;
      float bendK = uBend[fi * 3 + k];

      // thinness: the finger itself, more at its edges and toward the tip
      float mem = (1.0 - smoothstep(0.0095, 0.015, rl)) * (k == 0 ? smoothstep(-0.004, 0.008, s) : 1.0);
      float edge = smoothstep(0.45, 0.95, abs(lat) / max(rl, 1e-5));
      float th = mem * (0.35 + 0.35 * edge + (k == 2 ? 0.4 * smoothstep(0.3, 1.0, t) : 0.0) + (k == 1 ? 0.1 : 0.0));
      if (!(thumb && k == 0)) S.thin = max(S.thin, th * (thumb ? 0.75 : 1.0));

      // palm side: narrow flexion creases (grooves), the flesh bulging between them, occlusion at the roots
      if (side > 0.2 && !(thumb && k == 0)) {
        float pw = smoothstep(0.2, 0.55, side) * rf;
        vec2 cr = vec2(0.0);
        if (mcp) cr = sk_lineD(s - 0.0085, 0.00028, fw) + 0.55 * sk_lineD(s - 0.0112, 0.00022, fw);
        else if (k == 1) cr = sk_lineD(s + 0.0011, 0.00025, fw) + sk_lineD(s - 0.0011, 0.00025, fw);
        else if (k == 2) cr = 0.8 * sk_lineD(s - 0.0004, 0.00025, fw);
        cr *= pw * brk * (1.0 - smoothstep(0.55, 0.95, abs(lat) / max(rl, 1e-5))) * (1.0 + 0.8 * smoothstep(0.2, 1.2, bendK));
        S.crease += cr.x;
        S.g -= d * (cr.y * 0.00012 * lineK);
        if (mcp) S.ao = max(S.ao, sk_lm(s, 0.003, 0.006) * pw * 0.35);
        if (k >= 1) S.ao = max(S.ao, sk_lm(s, 0.0, 0.0018) * pw * 0.22);
        // fleshy pad of each segment, between its creases
        float seg0 = mcp ? 0.012 : 0.002, mid = 0.5 * (seg0 + L), hl = 0.5 * (L - seg0) + 0.001;
        float uu = (s - mid) / hl, pad = exp(-uu * uu * uu * uu);
        S.g += d * (pad * pw * 0.0005 * (k == 2 ? 1.0 : 0.7) * (-4.0 * uu * uu * uu / hl));
        S.pink = max(S.pink, pad * pw * (k == 2 ? 1.0 : 0.6));
      }
      // knuckle pads on the back: a darker oval of folded skin over each joint
      if (side < -0.05 && (k >= 1 || mcp)) {
        float dw = smoothstep(0.05, 0.5, -side) * rf;
        float aL = mcp ? 0.011 : (k == 1 ? 0.0082 : 0.0058);
        float aW = mcp ? 0.0095 : (k == 1 ? 0.007 : 0.0056);
        float sc = s + (mcp ? 0.0025 : 0.0);
        float e = length(vec2(sc / aL, lat / aW)) + (sk_vn(pn * 260.0 + float(fi * 7 + k)) - 0.5) * 0.35;
        float pad = (1.0 - smoothstep(0.3, 1.1, e)) * dw * (thumb ? 0.75 : 1.0) * (0.75 + 0.5 * sk_vn(pn * 520.0 + 4.0));
        float sp = mcp ? 0.0017 : (k == 1 ? 0.0013 : 0.001);
        float stretch = smoothstep(0.25, 1.3, bendK);              // skin over a bent joint is pulled smooth and pale
        vec2 folds = skFolds(sc, lat, sp, aW, pn, float(fi * 3 + k), fw) * (1.0 - smoothstep(0.3, 0.95, e)) * dw * (1.0 - 0.75 * stretch);
        S.knuck = max(S.knuck, pad * (mcp ? 0.5 : (k == 2 ? 0.65 : 0.85)) * (1.0 - 0.45 * stretch));
        S.crease += folds.x * (mcp ? 0.7 : 1.1);
        S.g -= (d + latD * (0.9 * lat / aW)) * (folds.y * 0.00005 * lineK);
        // the joint itself stands up under the skin
        float kk = mcp ? 0.000045 : 0.000018;
        float bump = exp(-(sc * sc + lat * lat) / kk) * dw * (mcp ? 0.0016 : (k == 1 ? 0.0007 : 0.0003));
        S.g += (d * sc + latD * lat) * (-2.0 / kk) * bump;
      }
      // flushed fingertips
      if (k == 2) S.red = max(S.red, smoothstep(0.45, 1.0, t) * (0.45 + 0.55 * smoothstep(-0.2, 0.6, side)));
      // nail bed (pinker, hidden under the nail mesh) + a soft ring around the nail base
      if (k == 2 && side < -0.1) {
        float hw = thumb ? 0.0072 : (fi == 3 ? 0.0048 : 0.006);
        float yy = (t - 0.33) / 0.62;
        float br = yy < 0.3 ? length(vec2(abs(lat) / hw, (0.3 - yy) / 0.3)) : abs(lat) / hw;
        float sw = smoothstep(0.15, 0.4, -side);
        float inside = (1.0 - smoothstep(0.85, 1.0, br)) * step(0.0, yy) * (1.0 - smoothstep(1.0, 1.06, t)) * sw;
        float ring = smoothstep(0.8, 1.0, br) * (1.0 - smoothstep(1.0, 1.35, br)) * smoothstep(-0.2, -0.05, yy) * (1.0 - smoothstep(0.8, 0.98, t)) * sw
                   * mix(0.3, 1.0, 1.0 - smoothstep(0.15, 0.4, yy));   // mostly the proximal fold
        S.bed = max(S.bed, inside);
        S.cuticle = max(S.cuticle, ring);
        S.red = max(S.red, (1.0 - smoothstep(1.0, 1.6, br)) * smoothstep(-0.25, 0.05, yy) * sw * 0.5);
      }
      // the sides of neighbouring fingers shade each other near their roots
      if (mcp) {
        float face = 0.0;
        if (fi < 3) face = max(face, dot(rn, normalize(uJ[fi * 4 + 4] - J0)));
        if (fi > 0) face = max(face, dot(rn, normalize(uJ[fi * 4 - 4] - J0)));
        S.ao = max(S.ao, smoothstep(0.3, 0.9, face) * (1.0 - smoothstep(0.003, 0.024, s)) * mem * 0.6 * rf);
      }
    }
  }

  // webs between the fingers: occluded and thin (they glow when back-lit)
  for (int fi = 0; fi < 3; fi++) {
    vec3 W = 0.5 * (uJ[fi * 4] + uJ[fi * 4 + 4]) + uHU * 0.004;
    float dw = length(p - W);
    S.ao = max(S.ao, exp(-dw * dw / 0.000072) * 0.7);
    S.thin = max(S.thin, exp(-dw * dw / 0.00012) * 0.8);
  }
  {
    vec3 W = mix(uJ[17], uJ[0], 0.45) - uHU * 0.008;
    float dw = length(p - W);
    S.ao = max(S.ao, exp(-dw * dw / 0.00012) * 0.3);
    S.thin = max(S.thin, exp(-dw * dw / 0.0002) * 0.55);
  }

  // palm lines (thin grooves with a little occlusion), minor creases, wrist bracelets, pinker pads
  if (Nn > 0.002 && palmN > 0.0 && b > -0.25 && b < 1.0 && abs(a) < 0.62) {
    vec2 m = vec2(A, B);
    vec2 sc = vec2(uPalmW, uPalmLen);
    vec2 heart[6]; heart[0] = vec2(-0.56, 0.79) * sc; heart[1] = vec2(-0.3, 0.80) * sc; heart[2] = vec2(-0.06, 0.83) * sc; heart[3] = vec2(0.12, 0.89) * sc; heart[4] = vec2(0.22, 0.97) * sc; heart[5] = heart[4];
    vec2 head[6]; head[0] = vec2(0.5, 0.69) * sc; head[1] = vec2(0.3, 0.63) * sc; head[2] = vec2(0.06, 0.57) * sc; head[3] = vec2(-0.2, 0.52) * sc; head[4] = vec2(-0.42, 0.47) * sc; head[5] = head[4];
    vec2 life[6]; life[0] = vec2(0.48, 0.68) * sc; life[1] = vec2(0.3, 0.6) * sc; life[2] = vec2(0.19, 0.45) * sc; life[3] = vec2(0.16, 0.3) * sc; life[4] = vec2(0.2, 0.15) * sc; life[5] = vec2(0.28, 0.04) * sc;
    vec3 l1 = sk_polyD(m, heart, 5), l2 = sk_polyD(m, head, 5), l3 = sk_polyD(m, life, 6);
    vec3 ld = l1.x < l2.x ? l1 : l2; ld = ld.x < l3.x ? ld : l3;
    float dl = ld.x + (sk_vn(pn * 500.0) - 0.5) * 0.0003;
    float pw = smoothstep(0.0, 0.4, palmN);
    vec2 main = sk_lineD(dl, 0.00026 + 0.00012 * S.blot, fw) * pw * (0.5 + 0.5 * sk_vn(pn * 260.0));
    S.crease += main.x * 0.9;
    S.g -= (uHV * ld.y + uHU * ld.z) * (main.y * 0.00008 * lineK);
    S.ao = max(S.ao, exp(-pow(dl / 0.0011, 2.0)) * 0.1 * pw);
    vec2 wristLine = sk_lineD(B + 0.006, 0.0003, fw) + 0.7 * sk_lineD(B + 0.013, 0.0003, fw);
    wristLine *= (1.0 - smoothstep(0.35, 0.5, abs(a))) * pw * (0.35 + 0.65 * sk_vn(pn * 220.0 + 8.0));
    S.crease += wristLine.x * 0.8;
    S.g -= uHU * (wristLine.y * 0.0001 * lineK);
    float thenar = smoothstep(0.08, 0.35, a) * (1.0 - smoothstep(0.25, 0.6, b));
    float hypo = smoothstep(-0.2, -0.45, a) * smoothstep(0.1, 0.3, b) * (1.0 - smoothstep(0.55, 0.8, b));
    float pads = smoothstep(0.78, 0.95, b);
    S.pink = max(S.pink, (0.8 * thenar + 0.6 * hypo + 0.7 * pads) * (0.6 + 0.4 * S.blot));
    // the ball of the thumb and the heel of the hand are rounded
    vec2 th0 = (vec2(A, B) - vec2(0.3, 0.2) * vec2(uPalmW, uPalmLen)) / vec2(0.016, 0.022);
    vec2 hy0 = (vec2(A, B) - vec2(-0.38, 0.4) * vec2(uPalmW, uPalmLen)) / vec2(0.012, 0.022);
    float tb = exp(-dot(th0, th0)) * 0.0012 * pw, hb = exp(-dot(hy0, hy0)) * 0.0007 * pw;
    S.g += uHV * (-2.0 * (tb * th0.x / 0.016 + hb * hy0.x / 0.012)) + uHU * (-2.0 * (tb * th0.y / 0.022 + hb * hy0.y / 0.022));
  }

  // palm side, palm and fingers: a net of small creases between the main lines, short nearly straight lines in
  // three crossing directions, broken and of uneven strength (pre-filtered for the pixel); and patchy pink
  if (S.palm > 0.01) {
    vec2 P2 = vec2(A, B) + (vec2(sk_vn(pn * 60.0 + 1.0), sk_vn(pn * 60.0 + 9.0)) - 0.5) * 0.0015;
    float net = 0.0;
    for (int j = 0; j < 4; j++) {
      float ang = j == 0 ? 0.35 : (j == 1 ? -0.6 : (j == 2 ? 1.35 : -1.1));
      float sp = j == 0 ? 0.0026 : (j == 1 ? 0.0031 : (j == 2 ? 0.0042 : 0.0036));
      float t = dot(P2, vec2(cos(ang), sin(ang))) / sp + float(j) * 0.37;
      float id = floor(t + 0.5);
      float dd = (t - id) * sp;
      vec2 along = vec2(-sin(ang), cos(ang));
      float on = smoothstep(0.5, 0.68, sk_vn(vec3(dot(P2, along) * 420.0, id * 1.7, float(j) * 5.0)));
      net += sk_line(dd, 0.00014, fw) * on * (0.4 + 0.6 * sk_h31(vec3(id, float(j), 2.0)));
    }
    S.crease += net * S.palm * 0.75;
    S.pink = max(S.pink, smoothstep(0.45, 0.85, sk_vn(pn * 85.0 + 21.0)) * S.palm * 0.8);
  }
  // veins (one network with the forearm), extensor tendons, the big knuckles' hollows
  vec4 vh = skVeins(vec2(A, B), back * smoothstep(0.04, 0.12, b), S.palm * (1.0 - smoothstep(0.1, 0.3, b)));
  S.g += uHV * vh.y + uHU * vh.z;
  S.vein = vh.w * back;
  S.innerV = vh.w * S.palm;
  vec3 ten = vec3(0.0);
  for (int fi = 0; fi < 4; fi++) {
    vec3 kq = uJ[fi * 4] - uWrist;
    vec2 K = vec2(dot(kq, uHV), dot(kq, uHU));
    ten = sk_vmax(ten, sk_tube(vec2(A, B), vec2(K.x * 0.3, 0.015), K - vec2(0.0, 0.01), 0.0035) * smoothstep(0.25, 0.55, B / K.y));
  }
  S.tendon = ten.x * back;
  ten *= back * (0.00032 + 0.0005 * uTension);
  S.g += uHV * ten.y + uHU * ten.z;
  // hair follicles: small dark dots where hair grows (the little-finger half of the back, near the wrist)
  S.follicle = smoothstep(0.86, 0.95, sk_vn(pn * 1500.0 + 3.0)) * back * (1.0 - smoothstep(0.45, 0.9, b))
             * mix(0.35, 1.0, smoothstep(0.2, -0.3, a)) * 0.7 * (1.0 - smoothstep(0.0003, 0.0009, fw));
}
`;

// ---------------------------------------------------------------- forearm (lathe: +Y wrist -> elbow, +Z back of arm)
const ARM_GLSL = /* glsl */`
void armFields(vec3 p, vec3 nr, vec3 pn, float fw, inout SkinOut S) {
  float inner = smoothstep(0.1, 0.7, -nr.z);
  float outer = smoothstep(0.1, 0.7, nr.z);
  float y = p.y;
  // the same frame as the hand: A towards the thumb, B from the wrist joint towards the fingers
  vec2 P = vec2(SK_SIDE * p.x, 0.004 - y);
  S.palm = inner * 0.5;                       // the inner forearm is paler, like the palm side of the wrist
  float wristEnd = 1.0 - smoothstep(0.03, 0.2, y);
  // gradients in (A, B) turn into the lathe's x and y: dA/dx = SK_SIDE, dB/dy = -1
  vec4 vh = skVeins(P, smoothstep(-0.25, 0.35, nr.z), inner);
  S.g += vec3(SK_SIDE * vh.y, -vh.z, 0.0);
  S.vein = vh.w * smoothstep(-0.25, 0.35, nr.z);
  S.innerV = vh.w * inner;
  // the head of the ulna on the back of the wrist, little-finger side
  vec2 ul = (P - vec2(-0.42 * uPalmW, -0.012)) / vec2(0.008, 0.009);
  float ub = 0.0016 * exp(-dot(ul, ul)) * smoothstep(-0.3, 0.3, nr.z);
  S.g += vec3(SK_SIDE * (-2.0 * ub * ul.x / 0.008), 2.0 * ub * ul.y / 0.009, 0.0);
  // flexor tendons at the inner wrist, visible when the hand is tense
  float t1 = (p.x - 0.005) / 0.0028, t2 = (p.x + 0.007) / 0.0032;
  float e1 = exp(-t1 * t1), e2 = 0.7 * exp(-t2 * t2);
  float tw = inner * (1.0 - smoothstep(0.02, 0.1, y)) * smoothstep(-0.015, 0.0, y);
  S.tendon = (e1 + e2) * tw;
  S.g.x += (-2.0 * e1 * t1 / 0.0028 - 2.0 * e2 * t2 / 0.0032) * tw * (0.0001 + 0.0005 * uTension);
  S.thin = 0.03 + 0.06 * inner * wristEnd;
#ifdef SKIN_UPPER
  // the same skin on the upper arm and neck of the body: no wrist veins or tendons there
  S.vein *= 0.2; S.innerV *= 0.2; S.tendon = 0.0; S.thin = 0.03; S.g = vec3(0.0);
#endif
#ifdef SKIN_HQ
  float fade = 1.0 - smoothstep(0.0003, 0.0011, fw);
  S.follicle = smoothstep(0.83, 0.94, sk_vn(pn * 1500.0 + 3.0)) * fade * mix(0.15, 1.0, outer);
#endif
}
`;

// ---------------------------------------------------------------- fragment chunks
const COLOR_CHUNK = (isHand) => /* glsl */`#include <color_fragment>
  float skFw = length(fwidth(vRest));
  vec3 skNr = normalize(vRestN);
  vec3 skPn = vRest + SKIN_SEED;
  SkinOut S = SkinOut(vec3(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0);
  ${isHand ? 'handFields(vRest, skNr, skPn, skFw, S);' : 'armFields(vRest, skNr, skPn, skFw, S);'}
  skinCommon(skPn, skFw, S);
  S.crease = clamp(S.crease, 0.0, 1.0);
  S.red = clamp(S.red, 0.0, 1.0);
  {
    float ts = mix(0.3, 1.0, uSkinTone);           // chromatic effects fade on the white tone
    vec3 col = diffuseColor.rgb;
    col *= 0.93 + 0.14 * S.mot;
    col *= 1.0 + vec3(0.07, -0.03, -0.06) * (S.blot - 0.5) * 2.0 * ts;   // blotches: warmer and cooler patches
    col *= 0.92 + 0.16 * S.blot;
    // palm side: paler and pinker (palm photo against the back photo, linear: 1.14 / 1.39 / 1.71, softened)
    col *= mix(vec3(1.0), vec3(1.05, 1.1, 1.22), S.palm);
    col *= mix(vec3(1.0), vec3(1.03, 0.9, 0.95), clamp(S.pink, 0.0, 1.0) * 0.8 * ts);
    // micro relief: lines and pores a little darker, the skin between them a little lighter
    col *= 1.0 + max(S.detail, 0.0) * 0.12;
    col *= mix(vec3(1.0), vec3(0.8, 0.72, 0.7), clamp(-S.detail * 0.3, 0.0, 1.0));
    col *= mix(vec3(1.0), vec3(1.0, 0.86, 0.84), S.red * 0.55 * ts);
    // knuckles: darker and only a little redder (photo: x 0.83 / 0.76 / 0.79), whitening as the grip tightens
    col *= mix(vec3(1.0), vec3(0.84, 0.77, 0.8), S.knuck * mix(0.6, 1.0, ts) * (1.0 - 0.7 * uTension));
    float lum = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(lum) * vec3(1.16, 1.06, 0.9), S.knuck * uTension * 0.35);
    col *= mix(vec3(1.0), vec3(0.98, 0.74, 0.72), S.bed * 0.5 * ts);
    col *= mix(vec3(1.0), vec3(0.9, 0.82, 0.8), S.cuticle * 0.3);
    col *= mix(vec3(1.0), vec3(0.78, 0.66, 0.56), S.freck * SK_FRECK * 1.6 * (1.0 - 0.8 * S.palm) * ts);
    col *= mix(vec3(1.0), vec3(0.55, 0.45, 0.4), S.follicle * 0.5);
    col *= mix(vec3(1.0), vec3(0.92, 0.88, 0.87), S.pores);
    // veins: their raised top catches light (relief); the skin over them is a touch cooler, much more at the inner wrist
    col *= mix(vec3(1.0), vec3(0.95, 0.96, 1.0), clamp(S.vein, 0.0, 1.0) * 0.6 * ts);
    col *= mix(vec3(1.0), vec3(0.8, 0.88, 1.0), clamp(S.innerV, 0.0, 1.0) * 0.55 * ts);
    col *= mix(vec3(1.0), mix(vec3(0.6), vec3(0.6, 0.47, 0.43), uSkinTone), clamp(S.crease, 0.0, 1.0) * 0.42);
    diffuseColor.rgb = col;
  }
  gThin = clamp(S.thin, 0.0, 1.0);
  gAO = 1.0 - clamp(S.ao + S.cuticle * 0.18 + S.crease * 0.12 + max(-S.detail, 0.0) * 0.12, 0.0, 0.85);
  gSpecOcc = 1.0 - clamp(S.crease * 0.5 + max(-S.detail, 0.0) * 0.5 + S.pores * 0.5, 0.0, 0.9);
  gSSSCol = mix(vec3(0.5, 0.45, 0.42), vec3(1.0, 0.3, 0.12), uSkinTone) * SK_THROUGH;
`;

const ROUGH_CHUNK = /* glsl */`#include <roughnessmap_fragment>
  {
    // oily, smoother skin on the back and over the knuckles and veins; drier palm, creases and pores
    float rk = 0.42 + (S.mot - 0.5) * 0.3 + S.pores * 0.3 + S.crease * 0.5 + S.palm * 0.3 - S.knuck * 0.12
             - clamp(S.vein, 0.0, 1.0) * 0.05 + S.cuticle * 0.2 + S.follicle * 0.2 - S.detail * 0.35;
    roughnessFactor = mix(SK_R0, SK_R1, clamp(rk, 0.0, 1.0));
    // relief too fine for the pixel: fold it into a slightly rougher surface
    roughnessFactor = min(1.0, roughnessFactor + 0.07 * smoothstep(0.0003, 0.0012, skFw));
  }
`;

const NORMAL_CHUNK = /* glsl */`#include <normal_fragment_maps>
  {
    // the relief's rest-space slope (analytic forms + detail maps), turned into view space and kept tangent
    vec3 gv = vR2V * (S.g + gGrad * SK_RELIEF) * faceDirection;
    gv -= normal * dot(gv, normal);
    normal = normalize(normal - gv);
  }
`;

// Direct light: a soft terminator that stays the colour of the skin (only a narrow warm band where light
// turns into shade), light shining through thin parts only when the light is really behind them, and a
// two-lobe specular (a broad sheen and a tighter one) on the bumped normal, so the skin lines break it up.
const LIGHT_PARS_CHUNK = /* glsl */`#include <lights_physical_pars_fragment>
void RE_Direct_Skin(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float nl = dot(geometryNormal, directLight.direction);
  float dotNL = saturate(nl);
  vec3 irradiance = dotNL * directLight.color;
  #ifdef USE_SHEEN
    sheenSpecularDirect += irradiance * BRDF_Sheen(directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness);
  #endif
  PhysicalMaterial tight = material;
  tight.roughness = max(material.roughness * 0.7, 0.2);
  vec3 spec = 0.85 * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, material)
            + 0.18 * BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, tight);
  reflectedLight.directSpecular += irradiance * spec * gSpecOcc;
  float w = SK_WRAP * (1.0 + 0.9 * gThin);
  float dw = saturate((nl + w) / (1.0 + w));
  float band = smoothstep(-w, 0.02, nl) * (1.0 - smoothstep(0.02, 0.5, nl));
  vec3 tint = mix(vec3(1.0), vec3(1.0, 0.92, 0.86), band * uSkinTone);
  reflectedLight.directDiffuse += directLight.color * dw * tint * BRDF_Lambert(material.diffuseColor);
  // light through thin flesh: only when the light is behind the hand as seen from the eye
  vec3 Lt = normalize(directLight.direction + geometryNormal * 0.3);
  float through = pow(saturate(dot(geometryViewDir, -Lt)), 4.0) * saturate(0.3 - nl);
  reflectedLight.directDiffuse += directLight.color * through * gThin * gSSSCol * gAO * 0.5;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Skin
`;

const LIGHT_END_CHUNK = /* glsl */`#include <lights_fragment_end>
  {
    float skNV = saturate(dot(geometryNormal, geometryViewDir));
    float fres = pow(1.0 - skNV, 3.0);
    vec3 ambI = (irradiance + iblIrradiance) * RECIPROCAL_PI;
    // soft rim (light scattered by the outermost skin layer and fine vellus hair)
    vec3 rimCol = mix(diffuseColor.rgb, vec3(1.0, 0.8, 0.7) * max(diffuseColor.r, 0.3), 0.3 * uSkinTone);
    reflectedLight.indirectDiffuse += ambI * fres * SK_RIM * rimCol;
    // ambient light diffusing through thin parts
    reflectedLight.indirectDiffuse += ambI * gSSSCol * gThin * 0.12 * diffuseColor.rgb;
    // analytic crease occlusion, slightly warm like real skin shadows
    vec3 aoC = pow(vec3(gAO), vec3(0.8, 1.0, 1.1));
    reflectedLight.indirectDiffuse *= aoC;
    reflectedLight.indirectSpecular *= gAO * gSpecOcc;
    reflectedLight.directDiffuse *= mix(vec3(1.0), aoC, 0.45);
  }
`;

function patch(uniforms, isHand, seed, side) {
  return (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nvarying vec3 vRestN;\nvarying mat3 vR2V;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvRestN = objectNormal;')
      .replace('#include <skinnormal_vertex>', '#include <skinnormal_vertex>\n#ifdef USE_SKINNING\nvR2V = normalMatrix * mat3(skinMatrix);\n#else\nvR2V = normalMatrix;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;');
    const head = `#include <common>\n#define SKIN_SEED vec3(${f(seed)}, ${f(seed * 0.7)}, ${f(seed * 1.3)})\n#define SK_SIDE ${side === 'left' ? '-1.0' : '1.0'}\n`
      + COMMON_GLSL + (isHand ? HAND_GLSL : ARM_GLSL);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', head)
      .replace('#include <color_fragment>', COLOR_CHUNK(isHand))
      .replace('#include <roughnessmap_fragment>', ROUGH_CHUNK)
      .replace('#include <normal_fragment_maps>', NORMAL_CHUNK)
      .replace('#include <lights_physical_pars_fragment>', LIGHT_PARS_CHUNK)
      .replace('#include <lights_fragment_end>', LIGHT_END_CHUNK);
  };
}

/**
 * createSkinMaterials({ detailUniforms, side })
 *   detailUniforms: { uJ, uHV, uHU, uHN, uWrist, uPalmLen, uPalmW, uSkinTone } in the skinned mesh's rest space
 *   side: 'right' | 'left' (mirrors the forearm's frame and shifts the noise so the two hands are not identical)
 * Returns { hand, arm, upper, uniforms: { uTension, uSkinTone, ... }, setTone(name) }.
 */
export function createSkinMaterials({ detailUniforms = {}, side = 'right', manager } = {}) {
  const maps = detailMaps(manager);
  const uniforms = {
    uTension: { value: 0 },
    uSkinTone: detailUniforms.uSkinTone ?? { value: 1 },
    tSkinBack: { value: maps.back },
    tSkinPalm: { value: maps.palm },
    uSkinTile: { value: new THREE.Vector3(1 / LOOK.tileBack, 1 / LOOK.tilePalm, (HQ ? 1 : 0.6) * (C.detail ?? 1)) },
    // joint bends for the folds; hand.js may write them every frame: skin.uniforms.uBend.value.set(angles)
    uBend: { value: new Float32Array(15) },
    // the forearm needs the hand's size for the veins that cross the wrist
    uPalmLen: detailUniforms.uPalmLen ?? { value: 0.092 },
    uPalmW: detailUniforms.uPalmW ?? { value: 0.061 },
  };
  const seed = side === 'left' ? 0.731 : 0.0;
  const make = () => new THREE.MeshPhysicalMaterial({
    color: TONES.natural.clone(), roughness: (LOOK.roughness[0] + LOOK.roughness[1]) / 2, metalness: 0,
    ior: 1.4, specularIntensity: 1,
    sheen: LOOK.sheen, sheenColor: SHEENS.natural.clone(), sheenRoughness: 0.55,
  });
  const hand = make();
  const arm = make();
  const upper = make();
  if (HQ) { hand.defines = { SKIN_HQ: '' }; arm.defines = { SKIN_HQ: '' }; }
  upper.defines = { SKIN_UPPER: '' };
  upper.onBeforeCompile = patch(uniforms, false, seed + 0.61, side);
  upper.customProgramCacheKey = () => `handskin3-upper-${side}`;
  upper.name = 'skin-upper-arm';
  hand.onBeforeCompile = patch({ ...detailUniforms, ...uniforms }, true, seed, side);
  arm.onBeforeCompile = patch(uniforms, false, seed + 0.37, side);
  hand.customProgramCacheKey = () => `handskin3-hand-${HQ ? 'hq' : 'lq'}-${side}`;
  arm.customProgramCacheKey = () => `handskin3-arm-${HQ ? 'hq' : 'lq'}-${side}`;
  hand.name = `skin-hand-${side}`;
  arm.name = `skin-arm-${side}`;

  function setTone(name) {
    const key = name === 'white' ? 'white' : 'natural';
    for (const m of [hand, arm, upper]) { m.color.copy(TONES[key]); m.sheenColor.copy(SHEENS[key]); }
    uniforms.uSkinTone.value = key === 'natural' ? 1 : 0;
  }
  setTone(uniforms.uSkinTone.value === 0 ? 'white' : 'natural');
  return { hand, arm, upper, uniforms, setTone };
}
