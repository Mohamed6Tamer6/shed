import * as THREE from 'three';
import { canvasTexture, rng } from '../util.js';

/**
 * Fire, smoke, extinguisher discharge and their sound for the fire-safety scenario.
 *
 *   const fx = createFx({ scene, camera, renderer, noAO });      // optional: manager (a THREE.LoadingManager)
 *   await fx.ready;                                               // optional: the three sprite sheets are loaded
 *   each frame: fx.ambient = roomBrightness; fx.update(dt, time);
 *
 *   const fire = fx.addFire({ parent, position, height, width, light });   // also: intensity, ceiling, drift
 *   fire.intensity = 1;  fire.setSize(0.6, 0.4);  fire.dispose();
 *   const blaze = fx.addStrawBlaze({ parent, points, light });             // also: intensity, height, glowSize, ceiling, drift
 *   blaze.intensity = 0.5;                                                 // points[0] catches first
 *   const jet = fx.createDischarge('powder' | 'water' | 'co2');
 *   jet.setEmitter(origin, direction);  jet.setTarget(point | null, surfaceNormal?);  jet.start();  jet.stop();
 *   fx.audio.unlock();  fx.audio.fire(level);  fx.audio.discharge(kind | null);  fx.audio.alarmShout();  fx.audio.volume = 1;
 *
 * Fires and blazes are created unlit (intensity 0) unless `intensity` is given. `ceiling` is a height in the
 * parent's space under which the smoke flattens and creeps towards +z instead of rising through the roof.
 * The two fire lights sit at least FX_TUNING.lightForward in front of the fire (the parent's +z) and are
 * capped at FX_TUNING.lightMax, so the surface a fire stands on is not burnt out.
 *
 * Everything that moves is computed in vertex shaders from a time uniform; the only per-frame
 * JavaScript is a handful of uniform writes and, while an extinguisher sprays, a few spawn
 * records written into a ring buffer. Nothing is allocated per frame.
 *
 * Sprites: a fire is 7 flames + 10 embers + 22 smoke puffs (2 draw calls); a straw blaze of n
 * points is up to 2n flames (20 at most) + 40 embers + 28 smoke puffs + n glowing patches
 * (3 draw calls); a discharge is one draw call over a ring of 160 (powder), 112 (water) or
 * 108 (CO2) records, of which about two thirds are alive while spraying.
 */

// ---- tuning: edit here, or change FX_TUNING before createFx() / before adding an effect
export const FX_TUNING = {
  flameFps: 13,             // playback speed of the 16-frame flame sheet (each sprite varies it a little)
  flameBody: 0.32,          // scene-linear gain of the orange body
  flameCore: 1.9,           // extra gain where the sheet is yellow: cores reach 2..6 and burn out to yellow-white
  flameOcclude: 0.55,       // how much a flame hides what is behind it (0 = purely additive); keeps it orange against a bright wall
  emberColor: [3.2, 0.95, 0.12],
  smokeThin: [0.3, 0.3, 0.315],     // smoke colour, as a fraction of fx.ambient, at low intensity
  smokeThick: [0.16, 0.155, 0.15],  // ... and at full intensity (a blaze is darker still)
  smokeGlow: 0.014,         // how strongly the fire lights its own smoke, the powder and the fog
  lightGain: 1.0,           // multiplies the fire lights (candela = lightGain * intensity * (0.25 + flame height))
  lightMax: 2.5,            // ... but never more than this, so the wall next to a fire is not burnt out
  lightForward: 0.45,       // metres the light of a fire sits out from it, along the parent's +z (away from a wall)
  lightColor: 0xff8a3a,
  powderColor: [1.12, 1.05, 0.82],  // discharge colours, as multiples of fx.ambient
  waterColor: [1.7, 1.85, 2.0],     // drops catch highlights, so they sit above a diffuse white
  mistColor: [0.95, 1.0, 1.05],
  co2Color: [1.25, 1.33, 1.45],
  residualSmoke: 4.0,       // seconds a fire keeps smouldering after its intensity reaches 0
};

const FLAME_ASPECT = 176 / 248;   // width / height of one cell of flame_4x4.png (see tools/make_fx_atlases.py)
const SMOKE_ASPECT = 300 / 252;
const asset = (name) => new URL(`../../assets/fx/${name}`, import.meta.url).href;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ZERO = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------
// shader pieces

const GLSL_COMMON = /* glsl */`
  // Cell of frame i (0..15) in a 4x4 sheet whose frame 0 is top-left.
  vec2 cellOf(float i) { return vec2(mod(i, 4.0), 3.0 - floor(i / 4.0)); }
  mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
  float hash(float n) { return fract(sin(n * 127.1 + 1.7) * 43758.5453); }
  // Projects a view-space point, but writes the depth it would have 'bias' metres nearer the camera:
  // a camera-facing sprite next to a wall then is not cut along the wall.
  vec4 projectBiased(vec3 mv, float bias) {
    vec4 clip = projectionMatrix * vec4(mv, 1.0);
    float len = length(mv);
    vec4 nearer = projectionMatrix * vec4(mv * (max(len - bias, len * 0.5) / max(len, 1e-4)), 1.0);
    clip.z = nearer.z / nearer.w * clip.w;
    return clip;
  }`;

const GLSL_FIRELIGHT = /* glsl */`
  uniform vec3 uLightPos[2];
  uniform vec3 uLightCol[2];
  // Light the two fire lights throw on a puff at a world position.
  vec3 fireGlow(vec3 world) {
    vec3 d0 = uLightPos[0] - world, d1 = uLightPos[1] - world;
    return uLightCol[0] / (dot(d0, d0) + 0.25) + uLightCol[1] / (dot(d1, d1) + 0.25);
  }`;

const FLAME_VERT = /* glsl */`
  attribute vec4 aBase;    // xyz: where it stands (times uSpread), w: 0 flame, 1 ember
  attribute vec4 aShape;   // x: height (times uSize.x), y: width relative to the sheet's, z: intensity at which it lights, w: mirror
  attribute vec4 aSeed;
  uniform float uTime, uIntensity, uFps, uEmberRise, uEmberSize, uEmberLife, uDrift;
  uniform vec2 uSize;      // height, width of the fire in metres
  uniform vec3 uSpread;
  varying vec2 vUv;
  varying vec2 vCell0;
  varying vec2 vCell1;
  varying vec4 vMix;       // frame blend, brightness, ember?, seed
  ${GLSL_COMMON}
  void main() {
    vUv = uv; vCell0 = vec2(0.0); vCell1 = vec2(0.0); vMix = vec4(0.0);
    float lit = smoothstep(aShape.z, aShape.z + 0.22, uIntensity);
    if (lit <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 anchor = aBase.xyz * uSpread;
    if (aBase.w < 0.5) {
      // A flame: an upright sprite turned about the vertical towards the camera.
      vec3 upV = normalize(mat3(modelViewMatrix) * vec3(0.0, 1.0, 0.0));
      vec4 mvA = modelViewMatrix * vec4(anchor, 1.0);
      vec3 rightV = normalize(cross(upV, -mvA.xyz) + vec3(1e-5, 0.0, 0.0));
      float lick = 1.0 + 0.10 * sin(uTime * (7.0 + 5.0 * aSeed.y) + aSeed.x * 31.0) + 0.06 * sin(uTime * 17.0 + aSeed.z * 50.0);
      float h = uSize.x * aShape.x * (0.45 + 0.55 * lit) * lick;
      float w = h * ${FLAME_ASPECT.toFixed(4)} * aShape.y;
      float sway = (sin(uTime * 2.1 + aSeed.z * 20.0) * 0.07 + sin(uTime * 4.7 + aSeed.x * 11.0) * 0.04) * h * uv.y * uv.y;
      vec3 mv = mvA.xyz + rightV * (position.x * w + sway) + upV * (position.y * h);
      gl_Position = projectBiased(mv, 0.5 * w);
      float f = uTime * uFps * (0.85 + 0.3 * aSeed.y) + aSeed.x * 16.0;
      float i0 = mod(floor(f), 16.0);
      vCell0 = cellOf(i0);
      vCell1 = cellOf(mod(i0 + 1.0, 16.0));
      vUv.x = aShape.w < 0.0 ? 1.0 - uv.x : uv.x;
      vMix = vec4(smoothstep(0.1, 0.9, fract(f)), lit, 0.0, aSeed.w);
    } else {
      // An ember: a tiny spark carried up by the heat.
      float life = fract(uTime * (0.6 + 0.8 * aSeed.y) / uEmberLife + aSeed.x);
      float rise = uEmberRise * (0.45 + 0.85 * aSeed.z);
      vec3 p = anchor;
      p.y += uSize.x * 0.2 + rise * life * (1.6 - 0.6 * life);
      float sw = 0.03 + rise * 0.2 * life;
      p.x += sin(life * 9.0 + aSeed.x * 40.0 + uTime * 1.3) * sw;
      p.z += cos(life * 7.0 + aSeed.y * 33.0 + uTime * 0.9) * sw + uDrift * life * life;
      float size = uEmberSize * (0.6 + 0.8 * aSeed.w) * (1.0 - 0.5 * life);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      mv.xy += (position.xy - vec2(0.0, 0.5)) * size;
      gl_Position = projectBiased(mv.xyz, 0.05);
      float twinkle = 0.55 + 0.45 * sin(uTime * 23.0 + aSeed.x * 90.0);
      vMix = vec4(0.0, lit * smoothstep(0.0, 0.06, life) * pow(1.0 - life, 1.4) * twinkle, 1.0, aSeed.w);
    }
  }`;

const FLAME_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float uTime, uBody, uCore, uOcclude;
  uniform vec3 uEmberColor;
  varying vec2 vUv;
  varying vec2 vCell0;
  varying vec2 vCell1;
  varying vec4 vMix;
  void main() {
    vec2 uv = vUv;
    // a little heat wobble, growing towards the tip, so the 16 frames never look like a loop
    uv.x += (sin(uv.y * 9.0 - uTime * 7.0 + vMix.w * 40.0) * 0.016 + sin(uv.y * 21.0 - uTime * 13.0 + vMix.w * 17.0) * 0.007) * uv.y;
    uv = clamp(uv, 0.006, 0.994);
    vec3 c = mix(texture2D(uTex, (uv + vCell0) * 0.25).rgb, texture2D(uTex, (uv + vCell1) * 0.25).rgb, vMix.x);
    // red is full all over a flame; it is the green that tells the yellow core from the orange body
    float heat = smoothstep(0.16, 0.62, c.g);
    float foot = smoothstep(0.0, 0.1, vUv.y);                           // no hard line where it stands
    vec3 flame = c * (uBody + uCore * heat * heat) * foot;
    float d = length(vUv - 0.5) * 2.0;
    vec3 ember = uEmberColor * pow(max(1.0 - d, 0.0), 1.5);
    // added to what is behind, which is first dimmed a little where the flame is dense
    float cover = uOcclude * min(max(c.r, c.b) * 1.6, 1.0) * foot * (1.0 - vMix.z);
    gl_FragColor = vec4(mix(flame, ember, vMix.z) * vMix.y, cover * vMix.y);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const SMOKE_VERT = /* glsl */`
  attribute vec4 aBase;    // xyz: where it leaves the fire (times uSpread), w: intensity at which that spot burns
  attribute vec4 aSeed;
  uniform float uTime, uAmbient, uLevel, uLevelLag, uLifetime, uRise, uDrift, uCeiling, uSize0, uSize1, uOpacity, uGlow, uFrame0;
  uniform vec2 uSize;
  uniform vec3 uSpread, uThin, uThick;
  varying vec2 vUv;
  varying vec2 vCell0;
  varying vec2 vCell1;
  varying vec4 vMix;       // frame blend, opacity, thickness, unused
  varying vec3 vColor;
  ${GLSL_COMMON}
  ${GLSL_FIRELIGHT}
  void main() {
    vUv = uv; vCell0 = vec2(0.0); vCell1 = vec2(0.0); vMix = vec4(0.0); vColor = vec3(0.0);
    float life = fract(uTime / uLifetime * (0.8 + 0.4 * aSeed.y) + aSeed.x);
    // what the fire was doing when this puff left it: old puffs remember the past
    float level = mix(uLevel, uLevelLag, smoothstep(0.0, 0.7, life)) * smoothstep(aBase.w - 0.05, aBase.w + 0.2, max(uLevel, uLevelLag));
    float alpha = smoothstep(0.0, 0.05, life) * pow(1.0 - life, 1.25) * smoothstep(0.0, 0.14, level);
    if (alpha <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float thick = smoothstep(0.15, 1.0, level);
    vec3 p = aBase.xyz * uSpread;
    float eased = 1.0 - (1.0 - life) * (1.0 - life);                  // slowing a little as it cools
    p.y += uSize.x * (0.25 + 0.35 * aSeed.z) + uRise * (0.75 * life + 0.25 * eased) * (0.75 + 0.5 * aSeed.w);
    float spread = (0.04 + 0.4 * life) * (uSize.y + 0.22 * uRise * life);
    p.x += sin(life * 5.0 + aSeed.x * 37.0 + uTime * 0.5) * spread * 0.5 + (aSeed.w - 0.5) * spread;
    p.z += cos(life * 4.0 + aSeed.y * 29.0 + uTime * 0.4) * spread * 0.4 + uDrift * life * life;
    // under a ceiling the plume stops rising and creeps outwards instead
    float over = max(p.y - (uCeiling - 0.35), 0.0);
    p.y -= over - 0.35 * over / (over + 0.35);
    p.z += over * 0.7;
    p.x += (aSeed.x - 0.5) * over * 1.2;
    float size = mix(uSize0, uSize1, pow(life, 0.75)) * (0.75 + 0.5 * aSeed.z) * (0.6 + 0.4 * level);
    float turn = (aSeed.x - 0.5) * (0.5 + 1.2 * life) + (aSeed.y - 0.5) * uTime * 0.12;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    mv.xy += rot2(turn) * ((position.xy - vec2(0.0, 0.3)) * vec2(${SMOKE_ASPECT.toFixed(4)}, 1.0)) * size + vec2(0.0, 0.3 * size);
    gl_Position = projectBiased(mv.xyz, min(0.4 * size, 0.45));
    float f = mix(uFrame0 * thick, 15.0, life), i0 = floor(f);            // thick smoke skips the thinnest wisps
    vCell0 = cellOf(i0);
    vCell1 = cellOf(min(i0 + 1.0, 15.0));
    vUv.x = aSeed.w > 0.5 ? 1.0 - uv.x : uv.x;
    vMix = vec4(fract(f), alpha * uOpacity * mix(0.6, 1.0, thick), thick, 0.0);
    vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;
    vColor = mix(uThin, uThick, thick) * mix(0.75, 1.0, life) * uAmbient + fireGlow(world) * uGlow * mix(1.0, 0.3, thick);
  }`;

const SMOKE_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float uWisp, uBody, uBlob;
  varying vec2 vUv;
  varying vec2 vCell0;
  varying vec2 vCell1;
  varying vec4 vMix;
  varying vec3 vColor;
  void main() {
    vec2 uv = clamp(vUv, 0.004, 0.996);
    vec2 a = (uv + vCell0) * 0.25, b = (uv + vCell1) * 0.25;
    float wisp = mix(texture2D(uTex, a).r, texture2D(uTex, b).r, vMix.x);
    // a blurred copy of the same frames gives thick smoke a body behind its wisps
    float body = mix(texture2D(uTex, a, 3.0).r, texture2D(uTex, b, 3.0).r, vMix.x);
    vec2 e = smoothstep(vec2(0.0), vec2(0.1), uv) * (1.0 - smoothstep(vec2(0.9), vec2(1.0), uv));
    // ... and a soft puff under both makes it heavy; the wisps stay visible as lighter streaks in it
    float blob = 1.0 - smoothstep(0.0, 1.0, length(uv - vec2(0.5, 0.52)) * 2.0);
    float density = wisp * uWisp + (body * uBody + blob * uBlob * (0.5 + 1.5 * wisp + 2.0 * body)) * e.x * e.y * (0.25 + 0.75 * vMix.z);
    float alpha = (1.0 - exp(-1.5 * density)) * vMix.y;
    gl_FragColor = vec4(vColor * (0.8 + 0.6 * wisp), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const GLOW_VERT = /* glsl */`
  attribute vec4 aBase;    // xyz: the burning spot, w: intensity at which it catches
  attribute vec4 aSeed;
  uniform float uLevel, uGlowSize;
  varying vec2 vUv;
  varying vec2 vTexUv;
  varying vec2 vInfo;      // how far alight, seed
  ${GLSL_COMMON}
  void main() {
    vUv = uv; vTexUv = uv; vInfo = vec2(0.0);
    float lit = smoothstep(aBase.w - 0.08, aBase.w + 0.2, uLevel);
    if (lit <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float size = uGlowSize * (0.8 + 0.5 * aSeed.z) * (0.45 + 0.55 * lit);
    vec4 mv = modelViewMatrix * vec4(aBase.xyz, 1.0);
    mv.xy += rot2((aSeed.x - 0.5) * 1.4) * position.xy * size;
    gl_Position = projectBiased(mv.xyz, 0.45 * size);
    vTexUv = vec2(0.01 + aSeed.x * 0.6, 0.02 + aSeed.y * 0.24) + uv * vec2(0.37, 0.72);   // a square window of the 2:1 photo
    vInfo = vec2(lit, aSeed.w);
  }`;

const GLOW_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform float uTime, uAmbient, uGlow;
  varying vec2 vUv;
  varying vec2 vTexUv;
  varying vec2 vInfo;
  void main() {
    vec3 c = texture2D(uTex, vTexUv).rgb;
    float lum = max(c.r, max(c.g, c.b));
    float r = length(vUv * 2.0 - 1.0);
    float mask = 1.0 - smoothstep(0.3, 1.0, r + (0.45 - lum) * 0.4);    // ragged edge that follows the straws
    float hot = smoothstep(0.1, 0.7, lum);
    float flicker = 0.72 + 0.28 * sin(uTime * (4.0 + 6.0 * vInfo.y) + lum * 18.0 + vInfo.y * 60.0);
    vec3 col = c * uAmbient * 0.8 + c * hot * uGlow * flicker * vInfo.x;
    gl_FragColor = vec4(col, mask * smoothstep(0.0, 0.5, vInfo.x) * (0.6 + 0.4 * hot));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// One vertex shader for the three extinguishing agents; KIND picks the motion.
const JET_VERT = /* glsl */`
  attribute vec4 aOrigin;  // xyz: nozzle when it left, w: time it left
  attribute vec4 aDir;     // xyz: direction, w: random seed
  attribute vec4 aTarget;  // xyz: where the stream lands, w: distance to it
  attribute vec4 aMisc;    // xyz: surface normal there, w: 1 if it lands on something, +2 for a cloud puff
  uniform float uTime, uAmbient, uGlow;
  uniform vec3 uColor, uColor2;
  varying vec2 vUv;
  varying vec4 vInfo;      // opacity, 0 puff / 1 drop, puff variant, shading (-0.7 bottom .. 0.7 top)
  varying vec3 vColor;
  ${GLSL_COMMON}
  ${GLSL_FIRELIGHT}
  const vec3 G = vec3(0.0, -9.8, 0.0);
  void main() {
    vUv = uv; vInfo = vec4(0.0); vColor = vec3(0.0);
    float age = uTime - aOrigin.w;
    if (age < 0.0 || age > 6.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float seed = aDir.w;
    float r1 = hash(seed + 0.11), r2 = hash(seed + 0.37), r3 = hash(seed + 0.59), r4 = hash(seed + 0.83);
    float hit = mod(aMisc.w, 2.0), cloud = step(1.5, aMisc.w);
    vec3 dir = aDir.xyz, n = aMisc.xyz;
    vec3 side = normalize(cross(dir, abs(dir.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 upv = cross(side, dir);
    vec3 lat = (side * cos(r1 * 6.2832) + upv * sin(r1 * 6.2832)) * sqrt(r2);   // a point of the unit disc across the stream
    float reach = aTarget.w;
    vec3 p, vel = dir, col = uColor;
    float size, alpha, life, drop = 0.0, len = 0.0;

  #if KIND == 2
    // ---- water: drops fly a shallow arc as streaks, burst into spray where they land, and leave a mist
    const float SPEED = 11.0;
    float tHit = reach / SPEED, t2 = age - tHit;
    if (cloud < 0.5) {
      drop = 1.0;
      col *= 0.5 + 0.9 * r1;                                            // some drops catch the light, some do not
      if (t2 < 0.0) {
        vec3 v0 = dir * SPEED - 0.5 * G * tHit;                         // aimed a touch high, so it lands on the target
        life = tHit;
        p = aOrigin.xyz + v0 * age + 0.5 * G * age * age + lat * (0.003 + 0.014 * SPEED * age);
        vel = v0 + G * age;
        size = 0.006 + 0.005 * r4;
        len = 0.14 + 0.12 * r3;
        alpha = 0.6 * smoothstep(0.0, 0.012, age) * (1.0 - (1.0 - hit) * smoothstep(0.55, 1.0, age / tHit));
      } else {
        life = tHit + (0.2 + 0.28 * r3) * hit;
        float t3 = max(life - tHit, 1e-3);
        vec3 skim = lat - n * dot(lat, n);                              // mostly sideways along the surface
        vec3 v1 = normalize(n * (0.08 + 0.3 * r3) + skim * 1.3 + vec3(0.0, 0.2, 0.0)) * (0.5 + 1.9 * r4);
        p = aTarget.xyz + n * 0.012 + v1 * t2 + 0.5 * G * t2 * t2;
        vel = v1 + G * t2;
        size = 0.005 + 0.005 * r4;
        len = 0.015 + 0.04 * r3;
        alpha = 0.55 * (1.0 - t2 / t3) * hit;
      }
    } else {
      life = tHit + 0.6 + 0.5 * r3;
      float t3 = life - tHit, tt = max(t2, 0.0);
      p = aTarget.xyz + n * (0.05 + 0.4 * r4 * tt) + lat * (0.04 + 0.35 * tt);
      p.y += 0.06 * tt - 0.2 * tt * tt;
      size = 0.12 + 0.5 * tt;
      alpha = hit * step(0.0, t2) * smoothstep(0.0, 0.08, tt) * pow(max(1.0 - tt / t3, 0.0), 1.5) * 0.2;
      col = uColor2;
    }
  #else
    #if KIND == 0
      // ---- dry powder: a fast dense cone that slows to a stop and billows into a cloud that hangs
      const float SPEED = 12.0, CONE = 0.07;
    #else
      // ---- CO2: a white fog jet that widens fast and is gone within a second
      const float SPEED = 13.0, CONE = 0.14;
    #endif
    float k = SPEED / reach;
    float slow = exp(-age * k);
    float s = reach * (1.0 - slow);                                     // starts at SPEED, comes to rest at 'reach'
    float f = s / reach;
    float tArr = max(age - 2.2 / k, 0.0);                               // seconds since it more or less arrived
    vec3 along = lat - n * dot(lat, n) * hit;                           // the same, laid flat on what it lands on
    col *= 0.84 + 0.3 * r2;                                             // puffs differ a little, so a cloud has lumps
    p = aOrigin.xyz + dir * s;
    if (cloud < 0.5) {
      p += lat * (0.004 + s * CONE) + (side * sin(age * 31.0 + seed * 50.0) + upv * cos(age * 27.0 + seed * 70.0)) * 0.02 * s;
      vel = dir * SPEED * slow;
      len = SPEED * slow * 0.014;                                       // smeared along its flight while it is fast
      #if KIND == 0
        life = 0.45 + 0.3 * r3;
        size = 0.03 + s * 0.17 * (0.7 + 0.6 * r4);
        alpha = smoothstep(0.0, 0.02, age) * (1.0 - smoothstep(0.5, 1.0, age / life)) * mix(1.6, 0.8, f);   // above 1: packed solid
      #else
        life = 0.32 + 0.4 * r3;
        p.y -= 0.5 * age * age;
        size = 0.03 + s * 0.3 * (0.7 + 0.6 * r4);
        alpha = smoothstep(0.0, 0.015, age) * pow(1.0 - age / life, 1.3) * mix(1.3, 0.5, f);
      #endif
    } else {
      #if KIND == 0
        life = 3.0 + 1.6 * r3;
        float b = 1.0 - exp(-tArr * 1.1);                               // billowing out, ever slower
        p += lat * (s * CONE) + along * (0.42 * b) + n * (0.06 + (0.1 + 0.35 * r4) * b);
        p.y += 0.1 * tArr * (r1 - 0.2) - 0.02 * tArr * tArr;            // hangs, then slowly settles
        p += vec3(sin(tArr * 0.9 + seed * 40.0), sin(tArr * 0.7 + seed * 23.0), cos(tArr * 0.8 + seed * 31.0)) * 0.06 * b;
        size = 0.14 + s * 0.06 + 0.5 * b * (0.7 + 0.6 * r4);
        alpha = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.3, 1.0, age / life)) * 0.3;
      #else
        life = 0.85 + 0.5 * r3;
        float b = 1.0 - exp(-tArr * 3.0);
        p += lat * (s * CONE) + along * (0.55 * b) + n * (0.06 + 0.22 * r4 * b);
        p.y -= 0.4 * tArr;                                              // cold and heavy: it rolls down
        size = 0.16 + s * 0.14 + 0.45 * b;
        alpha = smoothstep(0.0, 0.1, age) * pow(max(1.0 - age / life, 0.0), 1.2) * 0.26;
      #endif
    }
    // nothing passes through what the stream lands on
    p += n * max(0.03 - dot(p - aTarget.xyz, n), 0.0) * hit;
  #endif

    if (age > life || alpha <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec2 off;
    if (cloud < 0.5) {
      // something in flight: laid along the way it moves
      vec3 vv = mat3(modelViewMatrix) * vel;
      vec2 d2 = normalize(vv.xy + vec2(1e-5, 0.0));
      float stretch = len * length(vv.xy) / max(length(vv), 1e-4) + size;
      off = d2 * (position.y * stretch) + vec2(-d2.y, d2.x) * (position.x * size);
    } else {
      off = rot2(seed * 6.2832 + age * (r1 - 0.5) * 1.6) * position.xy * size;
    }
    mv.xy += off;
    gl_Position = projectBiased(mv.xyz, min(0.35 * size, 0.3) * (1.0 - drop));
    vInfo = vec4(alpha, drop, floor(r3 * 3.999), clamp(off.y / size, -0.7, 0.7));
    vColor = col * uAmbient + fireGlow(p) * uGlow * (1.0 - drop);
  }`;

const JET_FRAG = /* glsl */`
  uniform sampler2D uPuff;
  varying vec2 vUv;
  varying vec4 vInfo;
  varying vec3 vColor;
  void main() {
    float a, shade = 1.0;
    if (vInfo.y < 0.5) {
      float variant = floor(vInfo.z + 0.5);
      vec2 cell = vec2(mod(variant, 2.0), floor(variant * 0.5));
      a = texture2D(uPuff, (clamp(vUv, 0.02, 0.98) + cell) * 0.5).a;
      shade = (0.86 + 0.26 * a) * (1.0 + 0.24 * vInfo.w);              // denser in the middle, darker underneath
    } else {
      vec2 q = vUv * 2.0 - 1.0;
      a = pow(max(1.0 - q.x * q.x, 0.0), 1.5) * (1.0 - smoothstep(0.25, 1.0, abs(q.y)));
    }
    gl_FragColor = vec4(vColor * shade, min(a * vInfo.x, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// ---------------------------------------------------------------------------------------------
// geometry and textures

function quadGeometry(count, standing) {
  const base = new THREE.PlaneGeometry(1, 1);
  if (standing) base.translate(0, 0.5, 0);              // origin at bottom-centre
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  g.instanceCount = count;
  return g;
}

function instanced(g, name, array, size = 4) {
  g.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
}

/** Four different soft, lumpy puffs in a 2x2 sheet (alpha only): powder, fog and mist. */
function puffSheet() {
  const N = 128;
  return canvasTexture(N * 2, N * 2, (c) => {
    const rand = rng(31);
    c.clearRect(0, 0, N * 2, N * 2);
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * N, oy = Math.floor(cell / 2) * N;
      c.save();
      c.beginPath();
      c.rect(ox, oy, N, N);
      c.clip();
      // a broad soft body first, then smaller, firmer lumps on it
      for (let i = 0; i < 30; i++) {
        const lump = i >= 12, a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * N * (lump ? 0.27 : 0.19);
        const x = ox + N / 2 + Math.cos(a) * d, y = oy + N / 2 + Math.sin(a) * d, r = N * (lump ? 0.07 + rand() * 0.07 : 0.15 + rand() * 0.11);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${lump ? 0.3 : 0.16})`);
        g.addColorStop(0.6, `rgba(255,255,255,${lump ? 0.1 : 0.06})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(ox, oy, N, N);
      }
      c.restore();
    }
  }, { srgb: false });
}

// ---------------------------------------------------------------------------------------------
// sound: everything is noise through filters, no files

const MASTER_GAIN = 0.5;

function noiseBuffer(ctx, seconds, colour, seed) {
  const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0), rand = rng(seed);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    if (colour === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  if (colour === 'brown') {                              // close the loop without a step
    const fade = Math.min(n >> 2, 2048), jump = d[n - 1] - d[0];
    for (let i = 0; i < fade; i++) d[n - 1 - i] -= jump * (1 - i / fade);
  }
  return buf;
}

/** A loop of crackles: many faint ticks, a few sharp snaps, now and then a pop with a thump under it. */
function crackleBuffer(ctx, seconds, perSecond, seed) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), rand = rng(seed);
  const pops = Math.floor(seconds * perSecond);
  for (let k = 0; k < pops; k++) {
    const at = Math.floor(rand() * (n - sr * 0.08)), r = rand(), amp = 0.12 + 0.88 * r * r * r;
    const tau = sr * (0.0005 + 0.005 * amp * rand()), len = Math.min(Math.floor(tau * 7), n - at - 1);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const w = rand() * 2 - 1, e = Math.exp(-i / tau);
      d[at + i] += (amp < 0.4 ? w - prev : w) * e * amp;   // faint ticks are thinner (differenced noise)
      prev = w;
    }
    if (amp > 0.7) {
      const f = 80 + rand() * 120, tl = Math.min(Math.floor(sr * 0.06), n - at - 1);
      for (let i = 0; i < tl; i++) d[at + i] += Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (sr * 0.014)) * amp * 0.5;
    }
  }
  return buf;
}

/**
 * Builds the whole sound graph on any (offline or live) audio context and returns its controls.
 * Exported so a test can render it offline; the game uses fx.audio.
 */
export function buildFxAudioGraph(ctx, destination = ctx.destination) {
  const now = () => ctx.currentTime;
  const node = (type, frequency, Q = 0.7, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    f.gain.value = gain;
    return f;
  };
  const gainNode = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const loop = (buffer, rate = 1) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start();
    return s;
  };
  const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };

  const master = gainNode(MASTER_GAIN), limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  chain(master, limiter, destination);

  const white = loop(noiseBuffer(ctx, 2.3, 'white', 11)), brown = loop(noiseBuffer(ctx, 3.7, 'brown', 12));

  // ---- fire: a low roar that breathes, a soft whoosh, and two layers of crackle
  const roarFilter = node('lowpass', 220, 0.6), roar = gainNode(), whoosh = gainNode(), ticks = gainNode(), snaps = gainNode();
  chain(brown, roarFilter, roar, master);
  chain(white, node('bandpass', 650, 0.5), whoosh, master);
  chain(loop(crackleBuffer(ctx, 5.3, 9, 21)), node('highpass', 900), ticks, master);
  chain(loop(crackleBuffer(ctx, 7.1, 26, 22), 0.93), node('highpass', 500), snaps, master);
  const breath = ctx.createOscillator(), breathDepth = gainNode();
  breath.frequency.value = 0.37;
  chain(breath, breathDepth, roar.gain);
  breath.start();

  // ---- extinguishers: one voice each, faded in and out
  const voices = {};
  const voice = (kind, attack, ...parts) => {
    const out = gainNode();
    for (const [source, level, ...filters] of parts) chain(source, ...filters, gainNode(level), out);
    out.connect(master);
    voices[kind] = { out, attack };
  };
  voice('powder', 0.03,
    [white, 0.38, node('highpass', 1500), node('peaking', 4500, 0.8, 8)],
    [white, 0.17, node('bandpass', 350, 1)]);
  const spray = gainNode(1), wobble = ctx.createOscillator(), wobbleDepth = gainNode(0.18);
  wobble.frequency.value = 11;
  chain(wobble, wobbleDepth, spray.gain);
  wobble.start();
  voice('water', 0.07,
    [white, 0.42, node('bandpass', 2200, 0.6), node('lowpass', 5500), spray],
    [brown, 0.7, node('bandpass', 480, 0.8)]);
  voice('co2', 0.012,
    [white, 0.5, node('highpass', 350), node('peaking', 1600, 1.2, 10), node('highshelf', 6000, 0.7, 6)],
    [brown, 0.95, node('bandpass', 220, 0.7)]);

  return {
    master,
    setFire(level) {
      const v = clamp01(level), t = now();
      roar.gain.setTargetAtTime(0.9 * Math.pow(v, 1.2), t, 0.25);
      breathDepth.gain.setTargetAtTime(0.25 * v, t, 0.25);
      roarFilter.frequency.setTargetAtTime(160 + 520 * v, t, 0.25);
      whoosh.gain.setTargetAtTime(0.1 * v, t, 0.25);
      ticks.gain.setTargetAtTime(0.7 * Math.min(1, v * 4), t, 0.2);
      snaps.gain.setTargetAtTime(1.1 * Math.max(0, v - 0.2), t, 0.3);
    },
    setDischarge(kind) {
      const t = now();
      for (const name in voices) {
        const on = name === kind;
        voices[name].out.gain.setTargetAtTime(on ? 1 : 0, t, on ? voices[name].attack : 0.05);
      }
    },
    /** A short two-note whoop to mark the alarm being raised. */
    shout() {
      const t = now(), osc = ctx.createOscillator(), env = gainNode(0);
      osc.type = 'sawtooth';
      for (const [k, f] of [[0, 640], [0.3, 860]]) {
        osc.frequency.setValueAtTime(f, t + k);
        osc.frequency.linearRampToValueAtTime(f * 1.25, t + k + 0.24);
        env.gain.setValueAtTime(0, t + k);
        env.gain.linearRampToValueAtTime(0.22, t + k + 0.03);
        env.gain.setTargetAtTime(0, t + k + 0.2, 0.03);
      }
      chain(osc, node('lowpass', 2400), env, master);
      osc.start(t);
      osc.stop(t + 0.75);
    },
  };
}

function createAudio() {
  let ctx = null, graph = null, fireLevel = 0, fireSent = -1, kindNow = null, volume = 1;
  return {
    /** Call from a click or key press: browsers only start sound from a user gesture. */
    unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) {
        ctx = new AC();
        graph = buildFxAudioGraph(ctx);
        graph.master.gain.value = MASTER_GAIN * volume;
        graph.setFire(fireLevel);
        graph.setDischarge(kindNow);
        fireSent = fireLevel;
      }
      if (ctx.state === 'suspended') ctx.resume();
    },
    fire(level) {
      fireLevel = clamp01(level || 0);
      if (graph && Math.abs(fireLevel - fireSent) > 0.012) {
        graph.setFire(fireLevel);
        fireSent = fireLevel;
      }
    },
    discharge(kind) {
      const k = kind || null;
      if (k === kindNow) return;
      kindNow = k;
      if (graph) graph.setDischarge(k);
    },
    alarmShout() { if (graph && ctx.state === 'running') graph.shout(); },
    get volume() { return volume; },
    set volume(v) {
      volume = Math.max(0, v);
      if (graph) graph.master.gain.setTargetAtTime(MASTER_GAIN * volume, ctx.currentTime, 0.05);
    },
    get context() { return ctx; },
  };
}

// ---------------------------------------------------------------------------------------------

export function createFx({ scene, camera, renderer, noAO = [], manager } = {}) {
  const T = FX_TUNING;
  const shared = {
    uTime: { value: 0 },
    uAmbient: { value: 0.2 },
    uLightPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uLightCol: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  };

  // ---- textures
  const loader = new THREE.TextureLoader(manager);
  const sheet = (name, srgb) => new Promise((resolve) => {
    const t = loader.load(asset(name), () => { if (renderer) renderer.initTexture(t); resolve(); }, undefined, () => {
      console.error(`fx: could not load ${name}`);
      resolve();
    });
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    sheet.last = t;
  });
  const loading = [];
  const load = (name, srgb) => { loading.push(sheet(name, srgb)); return sheet.last; };
  const flameTex = load('flame_4x4.png', true), smokeTex = load('smoke_4x4.png', false), strawTex = load('burning_straw.jpg', true);
  const puffTex = puffSheet();
  puffTex.anisotropy = 1;

  // ---- the two fire lights exist from the start: adding a light later recompiles every material
  const lights = [0, 1].map(() => {
    const l = new THREE.PointLight(T.lightColor, 0, 4, 2);
    scene.add(l);
    return l;
  });
  const lightClaim = [0, 0], lightBase = new THREE.Color(T.lightColor);

  const effects = [];                                   // fires, blazes and discharges: each has _update(dt, time)
  const meshes = [];                                    // every sprite batch made here
  const drop = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };

  function addMesh(parent, geometry, material, renderOrder) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.userData.noAO = true;
    mesh.userData.drawn = false;
    mesh.onBeforeRender = function onBeforeRender() { this.userData.drawn = true; };
    parent.add(mesh);
    noAO.push(mesh);
    meshes.push(mesh);
    return mesh;
  }
  function removeMesh(mesh) {
    mesh.removeFromParent();
    drop(noAO, mesh);
    drop(meshes, mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  // An idle effect costs nothing, but it stays in the scene until it has been drawn once so that
  // its shader is compiled with everything else rather than at the moment the fire starts.
  const show = (mesh, wanted) => { mesh.visible = wanted || !mesh.userData.drawn; };

  function flameMaterial(extra) {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uTime: shared.uTime, uTex: { value: flameTex }, uIntensity: { value: 0 }, uFps: { value: T.flameFps },
        uSize: { value: new THREE.Vector2(0.35, 0.25) }, uSpread: { value: new THREE.Vector3(1, 1, 1) },
        uBody: { value: T.flameBody }, uCore: { value: T.flameCore }, uOcclude: { value: T.flameOcclude }, uEmberColor: { value: new THREE.Vector3(...T.emberColor) },
        uEmberRise: { value: 0.6 }, uEmberSize: { value: 0.008 }, uEmberLife: { value: 1.2 }, uDrift: { value: 0.1 },
        ...extra,
      },
      vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    });
  }

  function smokeMaterial(extra) {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime: shared.uTime, uAmbient: shared.uAmbient, uLightPos: shared.uLightPos, uLightCol: shared.uLightCol,
        uTex: { value: smokeTex }, uLevel: { value: 0 }, uLevelLag: { value: 0 },
        uSize: { value: new THREE.Vector2(0.35, 0.25) }, uSpread: { value: new THREE.Vector3(1, 1, 1) },
        uLifetime: { value: 3.4 }, uRise: { value: 1.8 }, uDrift: { value: 0.5 }, uCeiling: { value: 1e6 },
        uSize0: { value: 0.3 }, uSize1: { value: 1.1 }, uOpacity: { value: 0.75 }, uGlow: { value: T.smokeGlow },
        uThin: { value: new THREE.Vector3(...T.smokeThin) }, uThick: { value: new THREE.Vector3(...T.smokeThick) },
        uWisp: { value: 1.9 }, uBody: { value: 1.6 }, uBlob: { value: 0.35 }, uFrame0: { value: 2.5 },
        ...extra,
      },
      vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
    });
  }

  /** Strongest fire that wants a light gets it; called by each burning effect every frame. */
  function claimLight(index, group, height, forward, power, time) {
    power = Math.min(power, T.lightMax);
    if (index < 0 || index >= lights.length || power <= lightClaim[index]) return;
    lightClaim[index] = power;
    group.updateWorldMatrix(true, false);
    const flicker = 0.8 + 0.14 * Math.sin(time * 11.3 + index * 2.1) + 0.09 * Math.sin(time * 23.7 + index) + 0.06 * Math.sin(time * 5.1);
    lights[index].intensity = power * flicker;
    lights[index].position.set(0, height, forward).applyMatrix4(group.matrixWorld);
  }

  // ---- a fire: flames with a few embers (one draw call) and its smoke (another)
  function addFire({ parent = scene, position = ZERO, height = 0.35, width = 0.25, light = 0, intensity = 0, ceiling = Infinity, drift = 0.5 } = {}) {
    const group = new THREE.Group();
    group.position.copy(position);
    parent.add(group);
    const rand = rng(900 + effects.length * 17);

    // x (in widths), height, width factor, lights at intensity, z (in widths)
    const FLAMES = [[0, 1, 1, 0, 0], [-0.24, 0.62, 1, 0.05, 0.03], [0.26, 0.55, 1, 0.12, -0.02], [-0.42, 0.36, 1.1, 0.3, 0.05],
      [0.43, 0.4, 1.1, 0.22, 0.04], [0.07, 0.34, 1.25, 0.02, 0.1], [0.1, 0.8, 0.8, 0.6, -0.04]];
    const EMBERS = 10, nFlame = FLAMES.length + EMBERS;
    const base = new Float32Array(nFlame * 4), shape = new Float32Array(nFlame * 4), seed = new Float32Array(nFlame * 4);
    for (let i = 0; i < nFlame; i++) {
      const f = FLAMES[i];
      if (f) {
        base.set([f[0], 0, f[4], 0], i * 4);
        shape.set([f[1], f[2], f[3], rand() < 0.5 ? -1 : 1], i * 4);
      } else {
        base.set([(rand() - 0.5) * 0.7, 0, (rand() - 0.5) * 0.2, 1], i * 4);
        shape.set([1, 1, 0.1 + rand() * 0.5, 1], i * 4);
      }
      seed.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const fg = quadGeometry(nFlame, true);
    instanced(fg, 'aBase', base);
    instanced(fg, 'aShape', shape);
    instanced(fg, 'aSeed', seed);
    const flame = addMesh(group, fg, flameMaterial(), 8);

    const PUFFS = 22;
    const sBase = new Float32Array(PUFFS * 4), sSeed = new Float32Array(PUFFS * 4);
    for (let i = 0; i < PUFFS; i++) {
      sBase.set([(rand() - 0.5) * 0.5, 0, 0, 0], i * 4);
      sSeed.set([(i + rand()) / PUFFS, rand(), rand(), rand()], i * 4);
    }
    const sg = quadGeometry(PUFFS, true);
    instanced(sg, 'aBase', sBase);
    instanced(sg, 'aSeed', sSeed);
    const smoke = addMesh(group, sg, smokeMaterial(), 7);

    const fu = flame.material.uniforms, su = smoke.material.uniforms;
    let level = clamp01(intensity), smokeFast = level, smokeLag = level, residual = 0, h = height, w = width;
    const fire = {
      intensity, group, flame, smoke, light,
      setSize(newHeight, newWidth = w) { h = newHeight; w = newWidth; },
      get height() { return h; },
      get width() { return w; },
      dispose() {
        removeMesh(flame);
        removeMesh(smoke);
        group.removeFromParent();
        drop(effects, fire);
      },
      _update(dt, time) {
        const want = clamp01(fire.intensity);
        level += (want - level) * (1 - Math.exp(-dt * 8));
        if (want < 0.003 && level < 0.003) level = 0;
        if (want > 0.02) residual = 1;
        else residual = Math.max(0, residual - dt / T.residualSmoke);
        const smokeNow = Math.max(level, 0.2 * Math.min(1, residual * 2));
        smokeFast += (smokeNow - smokeFast) * (1 - Math.exp(-dt * 3));
        smokeLag += (smokeNow - smokeLag) * (1 - Math.exp(-dt * 0.7));
        if (smokeNow === 0 && smokeLag < 0.004) smokeFast = smokeLag = 0;

        fu.uIntensity.value = level;
        fu.uSize.value.set(h, w);
        fu.uSpread.value.set(w, h, w);
        fu.uEmberRise.value = 0.35 + h * 1.2;
        fu.uEmberSize.value = 0.005 + h * 0.008;
        su.uLevel.value = smokeFast;
        su.uLevelLag.value = smokeLag;
        su.uSize.value.set(h * (0.4 + 0.6 * level), w);
        su.uSpread.value.set(w, h, w);
        su.uRise.value = 1.3 + h * 1.4;
        su.uDrift.value = drift;
        su.uCeiling.value = Number.isFinite(ceiling) ? ceiling - group.position.y : 1e6;
        su.uSize0.value = 0.1 + w * 0.9;
        su.uSize1.value = 0.55 + h * 1.3;
        su.uOpacity.value = 0.55 + 0.3 * level;
        show(flame, level > 0);
        show(smoke, smokeFast > 0 || smokeLag > 0);
        if (level > 0.01) claimLight(fire.light, group, h * 0.45, T.lightForward + 0.6 * h, T.lightGain * level * (0.25 + h), time);
      },
    };
    effects.push(fire);
    return fire;
  }

  // ---- burning straw: flames standing on glowing patches, embers flying, heavy dark smoke
  function addStrawBlaze({ parent = scene, points = [ZERO], light = 1, intensity = 0, height = 1.5, glowSize = 0.6, ceiling = Infinity, drift = 0.9 } = {}) {
    const group = new THREE.Group();
    parent.add(group);
    const rand = rng(4100 + effects.length * 13), n = points.length;
    const centre = new THREE.Vector3();
    for (const p of points) centre.addScaledVector(p, 1 / n);
    let far = 1e-3;
    for (const p of points) far = Math.max(far, p.distanceTo(centre));
    const catches = (i) => (i / n) * 0.62;              // point 0 burns first; the rest follow as intensity rises

    const perPoint = n <= 10 ? 2 : 1, EMBERS = 40;
    const nFlame = Math.min(n * perPoint, 20), nAll = nFlame + EMBERS;
    const base = new Float32Array(nAll * 4), shape = new Float32Array(nAll * 4), seed = new Float32Array(nAll * 4);
    for (let i = 0; i < nAll; i++) {
      const pi = i < nFlame ? i % n : Math.floor(rand() * n), p = points[pi];
      const middle = 1 - p.distanceTo(centre) / far;    // flames are tallest in the middle of the heap
      if (i < nFlame) {
        const main = i < n;
        base.set([p.x + (main ? 0 : (rand() - 0.5) * 0.36), p.y - 0.02, p.z + (main ? 0 : (rand() - 0.5) * 0.24), 0], i * 4);
        shape.set([(main ? 0.62 + 0.38 * middle : 0.38 + 0.25 * middle) * (0.85 + 0.15 * rand()), 0.95 + 0.25 * rand(),
          catches(pi) + (main ? 0 : 0.1), rand() < 0.5 ? -1 : 1], i * 4);
      } else {
        base.set([p.x + (rand() - 0.5) * 0.3, p.y, p.z + (rand() - 0.5) * 0.3, 1], i * 4);
        shape.set([1, 1, catches(pi) + 0.05, 1], i * 4);
      }
      seed.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const fg = quadGeometry(nAll, true);
    instanced(fg, 'aBase', base);
    instanced(fg, 'aShape', shape);
    instanced(fg, 'aSeed', seed);
    const flame = addMesh(group, fg, flameMaterial(), 8);

    const PUFFS = 28;
    const sBase = new Float32Array(PUFFS * 4), sSeed = new Float32Array(PUFFS * 4);
    for (let i = 0; i < PUFFS; i++) {
      const pi = i % n, p = points[pi];
      sBase.set([p.x + (rand() - 0.5) * 0.25, p.y, p.z + (rand() - 0.5) * 0.25, catches(pi)], i * 4);
      sSeed.set([(i + rand()) / PUFFS, rand(), rand(), rand()], i * 4);
    }
    const sg = quadGeometry(PUFFS, true);
    instanced(sg, 'aBase', sBase);
    instanced(sg, 'aSeed', sSeed);
    const smoke = addMesh(group, sg, smokeMaterial({
      uThin: { value: new THREE.Vector3(0.34, 0.33, 0.33) }, uThick: { value: new THREE.Vector3(0.13, 0.125, 0.12) },
      uLifetime: { value: 4.2 }, uBody: { value: 1.6 }, uWisp: { value: 1.2 }, uBlob: { value: 1.3 }, uFrame0: { value: 7 },
    }), 7);

    const gBase = new Float32Array(n * 4), gSeed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      gBase.set([points[i].x, points[i].y + 0.03, points[i].z, catches(i)], i * 4);
      gSeed.set([rand(), rand(), rand(), rand()], i * 4);
    }
    const gg = quadGeometry(n, false);
    instanced(gg, 'aBase', gBase);
    instanced(gg, 'aSeed', gSeed);
    const glow = addMesh(group, gg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: shared.uTime, uAmbient: shared.uAmbient, uTex: { value: strawTex }, uLevel: { value: 0 }, uGlowSize: { value: glowSize }, uGlow: { value: 1.0 } },
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    }), 6);

    const fu = flame.material.uniforms, su = smoke.material.uniforms;
    let level = clamp01(intensity), smokeFast = level, smokeLag = level, residual = 0;
    const blaze = {
      intensity, group, flame, smoke, glow, light, height,
      dispose() {
        removeMesh(flame);
        removeMesh(smoke);
        removeMesh(glow);
        group.removeFromParent();
        drop(effects, blaze);
      },
      _update(dt, time) {
        const want = clamp01(blaze.intensity), h = blaze.height;
        level += (want - level) * (1 - Math.exp(-dt * 5));
        if (want < 0.003 && level < 0.003) level = 0;
        if (want > 0.02) residual = 1;
        else residual = Math.max(0, residual - dt / (T.residualSmoke * 1.5));
        const smokeNow = Math.max(level, 0.22 * Math.min(1, residual * 2));
        smokeFast += (smokeNow - smokeFast) * (1 - Math.exp(-dt * 2.5));
        smokeLag += (smokeNow - smokeLag) * (1 - Math.exp(-dt * 0.6));
        if (smokeNow === 0 && smokeLag < 0.004) smokeFast = smokeLag = 0;

        const grown = h * (0.4 + 0.6 * level);
        fu.uIntensity.value = level;
        fu.uSize.value.set(grown, 0.3);
        fu.uEmberRise.value = 0.8 + 1.4 * level;
        fu.uEmberSize.value = 0.014;
        fu.uEmberLife.value = 2.2;
        fu.uDrift.value = drift * 0.5;
        su.uLevel.value = smokeFast;
        su.uLevelLag.value = smokeLag;
        su.uSize.value.set(grown * 0.75, 0.35);
        su.uRise.value = 1.4 + 1.3 * level;
        su.uDrift.value = drift;
        su.uCeiling.value = Number.isFinite(ceiling) ? ceiling : 1e6;
        su.uSize0.value = 0.65;
        su.uSize1.value = 1.1 + 0.8 * level;
        su.uOpacity.value = 0.7 + 0.25 * level;
        glow.material.uniforms.uLevel.value = Math.max(level, 0.6 * smokeLag * (want > 0.02 ? 0 : 1));   // embers outlive the flames a little
        show(flame, level > 0);
        show(smoke, smokeFast > 0 || smokeLag > 0);
        show(glow, glow.material.uniforms.uLevel.value > 0);
        if (level > 0.01) {
          const power = Math.min(T.lightGain * level * (0.25 + grown), T.lightMax);
          if (blaze.light >= 0 && blaze.light < lights.length && power > lightClaim[blaze.light]) {
            claimLight(blaze.light, group, 0, 0, power, time);
            lights[blaze.light].position.set(centre.x, centre.y + 0.35 + 0.3 * grown, centre.z + T.lightForward).applyMatrix4(group.matrixWorld);
          }
        }
      },
    };
    effects.push(blaze);
    return blaze;
  }

  // ---- what comes out of an extinguisher
  const JETS = {
    //        jets per second, ring;  cloud puffs per second, ring;  free range, longest shot that still lands
    powder: { kind: 0, rate: 140, ring: 108, cloudRate: 11, cloudRing: 52, range: 4.5, maxHit: 6.5, linger: 4.8, color: T.powderColor, color2: T.powderColor },
    co2: { kind: 1, rate: 110, ring: 80, cloudRate: 16, cloudRing: 28, range: 2.6, maxHit: 3.2, linger: 1.5, color: T.co2Color, color2: T.co2Color },
    water: { kind: 2, rate: 95, ring: 80, cloudRate: 22, cloudRing: 32, range: 7, maxHit: 9, linger: 2.2, color: T.waterColor, color2: T.mistColor },
  };
  const jetRand = rng(77123);

  function createDischarge(kind) {
    const cfg = JETS[kind];
    if (!cfg) throw new Error(`fx.createDischarge: unknown kind "${kind}" (powder, water or co2)`);
    const N = cfg.ring + cfg.cloudRing, STRIDE = 16;
    const data = new Float32Array(N * STRIDE);
    for (let i = 0; i < N; i++) data[i * STRIDE + 3] = -1e6;            // born long ago: dead
    const buffer = new THREE.InstancedInterleavedBuffer(data, STRIDE);
    buffer.setUsage(THREE.DynamicDrawUsage);
    const g = quadGeometry(N, false);
    g.setAttribute('aOrigin', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
    g.setAttribute('aDir', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
    g.setAttribute('aTarget', new THREE.InterleavedBufferAttribute(buffer, 4, 8));
    g.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(buffer, 4, 12));
    const mesh = addMesh(scene, g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      defines: { KIND: cfg.kind },
      uniforms: {
        uTime: shared.uTime, uAmbient: shared.uAmbient, uLightPos: shared.uLightPos, uLightCol: shared.uLightCol,
        uPuff: { value: puffTex }, uColor: { value: new THREE.Vector3(...cfg.color) }, uColor2: { value: new THREE.Vector3(...cfg.color2) },
        uGlow: { value: T.smokeGlow },
      },
      vertexShader: JET_VERT, fragmentShader: JET_FRAG,
    }), 9);

    const origin = new THREE.Vector3(), dir = new THREE.Vector3(0, 0, -1), target = new THREE.Vector3(), normal = new THREE.Vector3();
    let hasTarget = false, hasNormal = false, active = false, head = 0, cloudHead = 0, owed = 0, cloudOwed = 0, lastSpawn = -1e6;

    function spawn(birth, cloud) {
      let dx = dir.x, dy = dir.y, dz = dir.z, reach = cfg.range, hit = 0;
      if (hasTarget) {
        const tx = target.x - origin.x, ty = target.y - origin.y, tz = target.z - origin.z, d = Math.hypot(tx, ty, tz);
        if (d > 0.05 && d <= cfg.maxHit) {
          dx = tx / d; dy = ty / d; dz = tz / d;
          reach = d;
          hit = 1;
        }
      }
      let slot;
      if (cloud) {
        slot = cfg.ring + cloudHead;
        cloudHead = (cloudHead + 1) % cfg.cloudRing;
      } else {
        slot = head;
        head = (head + 1) % cfg.ring;
      }
      const o = slot * STRIDE, useNormal = hit && hasNormal;
      data[o] = origin.x; data[o + 1] = origin.y; data[o + 2] = origin.z; data[o + 3] = birth;
      data[o + 4] = dx; data[o + 5] = dy; data[o + 6] = dz; data[o + 7] = jetRand();
      data[o + 8] = origin.x + dx * reach; data[o + 9] = origin.y + dy * reach; data[o + 10] = origin.z + dz * reach; data[o + 11] = reach;
      data[o + 12] = useNormal ? normal.x : -dx; data[o + 13] = useNormal ? normal.y : -dy; data[o + 14] = useNormal ? normal.z : -dz;
      data[o + 15] = hit + (cloud ? 2 : 0);
    }

    const jet = {
      kind, mesh,
      get active() { return active; },
      /** Nozzle position and the way it points (world space). Call every frame while spraying. */
      setEmitter(newOrigin, direction) {
        origin.copy(newOrigin);
        if (direction.lengthSq() > 1e-8) dir.copy(direction).normalize();
      },
      /** Where the stream lands, or null if it hits nothing. The surface normal there is optional. */
      setTarget(point, surfaceNormal) {
        hasTarget = !!point;
        if (point) target.copy(point);
        hasNormal = !!surfaceNormal;
        if (surfaceNormal) normal.copy(surfaceNormal).normalize();
      },
      start() { active = true; },
      stop() { active = false; },
      dispose() {
        removeMesh(mesh);
        drop(effects, jet);
      },
      _update(dt, time) {
        if (active && dt > 0) {
          owed += cfg.rate * dt;
          cloudOwed += cfg.cloudRate * dt;
          // spread the births over the frame, so the stream is even at any frame rate
          const count = Math.min(Math.floor(owed), cfg.ring), cloudCount = Math.min(Math.floor(cloudOwed), cfg.cloudRing);
          for (let i = 0; i < count; i++) spawn(time - (dt * (i + jetRand())) / count, false);
          for (let i = 0; i < cloudCount; i++) spawn(time - (dt * (i + jetRand())) / cloudCount, true);
          owed -= Math.floor(owed);
          cloudOwed -= Math.floor(cloudOwed);
          if (count + cloudCount > 0) {
            buffer.needsUpdate = true;
            lastSpawn = time;
          }
        }
        if (time < lastSpawn) lastSpawn = time;         // the clock was reset
        show(mesh, time - lastSpawn < cfg.linger);
      },
    };
    effects.push(jet);
    return jet;
  }

  // ---- public
  const audio = createAudio();
  let clock = 0;
  const fx = {
    ambient: 0.2,
    lights,
    audio,
    /** Resolves when the three sprite sheets are on the GPU. Effects may be created before that. */
    ready: Promise.all(loading).then(() => undefined),
    addFire,
    addStrawBlaze,
    createDischarge,
    update(dt, time) {
      clock = time === undefined ? clock + dt : time;
      shared.uTime.value = clock;
      shared.uAmbient.value = fx.ambient;
      lightClaim[0] = lightClaim[1] = 0;
      for (let i = 0; i < effects.length; i++) effects[i]._update(dt, clock);
      for (let i = 0; i < lights.length; i++) {
        if (lightClaim[i] === 0) lights[i].intensity = 0;
        const l = lights[i], k = l.intensity * 1.0;
        shared.uLightPos.value[i].copy(l.position);
        shared.uLightCol.value[i].set(lightBase.r * k, lightBase.g * k, lightBase.b * k);
      }
    },
    /** Sprites currently submitted to the GPU (visible effects only), for the debug overlay. */
    spriteCount() {
      let total = 0;
      for (let i = 0; i < meshes.length; i++) if (meshes[i].visible) total += meshes[i].geometry.instanceCount;
      return total;
    },
    dispose() {
      while (effects.length) effects[effects.length - 1].dispose();
      for (const l of lights) l.removeFromParent();
      flameTex.dispose();
      smokeTex.dispose();
      strawTex.dispose();
      puffTex.dispose();
    },
  };
  return fx;
}
