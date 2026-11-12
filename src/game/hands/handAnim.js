import * as THREE from 'three';
import { HAND_CONFIG } from './handConfig.js';

// Procedural life for one first-person hand, driven by the real player state.
//
//   const anim = new HandAnimator('right');
//   const o = anim.update(dt, { speed, bobPhase, onGround, yawVel, pitchVel, fistTarget, inView });
//
// o.pos   camera-space offset (m) to ADD to the blended wrist position
// o.rot   camera-space rotation to PRE-MULTIPLY onto the blended hand rotation
// o.curl  Float32Array(5) index, middle, ring, pinky, thumb: 0 open .. 1 full fist
// o.spread 0..1 (1 relaxed open spread, 0 fingers together)
// o.tension 0..1 (fist squeezed: knuckles whiten, tendons show)
// o.walkPhase  arm-swing phase: this arm is forward when sin(walkPhase) > 0 (opposite to the same-side leg)
//
// Every returned object is reused; nothing is allocated per frame.

const WALK = 1.9, RUN = 3.8; // the shed player's walking and running speeds
const FINGERS = 5; // index, middle, ring, pinky, thumb
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Seeded 1D value noise in [-1, 1] with quintic interpolation (C2, so no visible kinks).
function hash(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash(i, seed), b = hash(i + 1, seed);
  return a + (b - a) * u;
}
// Three octaves at unrelated ratios so it never reads as a loop.
function fbm(x, seed) {
  return 0.6 * noise1(x, seed) + 0.28 * noise1(x * 2.31 + 17.3, seed + 101) + 0.12 * noise1(x * 5.17 + 41.9, seed + 202);
}

// Relaxed curls per finger (index, middle, ring, pinky, thumb): index most extended, pinky most curled.
const IDLE_CURL = [0.07, 0.1, 0.13, 0.16, 0.06];
const WALK_CURL = [0.11, 0.17, 0.22, 0.27, 0.1];
const RUN_CURL = [0.46, 0.54, 0.6, 0.65, 0.4]; // loose half fist
const WALK_FLEX = [0.025, 0.03, 0.035, 0.04, 0.018]; // per-finger swing flex while walking
const FLEX_PHASE = [0.0, 0.35, 0.7, 1.05, -0.5];
// Fist close order: pinky and ring first, then middle, index, and the thumb wraps last over the fingers.
const CLOSE_ORDER = [3, 2, 1, 0, 4.6]; // in units of fistStagger
const OPEN_ORDER = [1, 1.6, 2.2, 2.8, 0]; // opening: thumb lets go first, then index .. pinky (scaled by 0.5)

const HIST = 256;

export class HandAnimator {
  constructor(side = 'right') {
    this.side = side;
    this.h = side === 'left' ? -1 : 1;
    this.seed = side === 'left' ? 7919 : 1237;
    // Per-hand random offsets so the two hands never line up.
    const r = (k) => (hash(k, this.seed) + 1) * 0.5;
    this.breathRate = 0.235 + 0.02 * r(1); // Hz
    this.breathPh = r(2) * Math.PI * 2;
    this.tOff = r(3) * 100;
    this.finFreq = new Float32Array(FINGERS * 3);
    for (let i = 0; i < FINGERS * 3; i++) this.finFreq[i] = [0.31, 0.93, 2.4][i % 3] * (0.8 + 0.4 * r(10 + i));

    this.time = 0;
    this.sp = 0;          // damped speed
    this.spPrev = 0;
    this.accF = 0;        // smoothed forward acceleration
    this.air = 0;         // damped airborne factor
    this.wasGround = true; this.landKick = 0;
    this.yawPrev = 0; this.pitchPrev = 0; this.yawAcc = 0; this.pitchAcc = 0;
    this.first = true;

    // Spring-damper offset (position) and its velocity: slow base pose + inertia.
    this.sx = new THREE.Vector3(); this.sv = new THREE.Vector3();
    // Fist command history (for the per-finger stagger) and per-finger spring state.
    this.histT = new Float32Array(HIST); this.histV = new Float32Array(HIST); this.histN = 0; this.histI = 0;
    this.cmd = 0; this.cmdVel = 0;
    this.fz = new Float32Array(FINGERS); this.fzv = new Float32Array(FINGERS);
    this.tension = 0;

    this.e = new THREE.Euler();
    this.out = {
      pos: new THREE.Vector3(),
      rot: new THREE.Quaternion(),
      curl: new Float32Array(FINGERS),
      spread: 1,
      tension: 0,
      walkPhase: 0,
    };
  }

  // Fist command value `delay` seconds ago (linear interpolation in the history ring).
  cmdAt(delay) {
    const target = this.time - delay;
    let prevT = this.time, prevV = this.cmd;
    for (let n = 0; n < this.histN; n++) {
      const j = (this.histI - 1 - n + HIST) % HIST;
      const t = this.histT[j], v = this.histV[j];
      if (t <= target) {
        const k = prevT > t ? (target - t) / (prevT - t) : 0;
        return v + (prevV - v) * k;
      }
      prevT = t; prevV = v;
    }
    return prevV;
  }

  update(dt, s) {
    const A = HAND_CONFIG.anim;
    const o = this.out, h = this.h, seed = this.seed;
    dt = clamp(dt || 0, 0, 0.1);
    this.time += dt;
    const t = this.time + this.tOff;
    const speed = Math.max(0, s.speed || 0);
    const bp = s.bobPhase || 0;
    const onGround = s.onGround !== false;
    const inView = clamp(s.inView ?? 1, 0, 1);
    const fistTarget = clamp(s.fistTarget || 0, 0, 1);
    const yawVel = s.yawVel || 0, pitchVel = s.pitchVel || 0;

    // ---- Damped locomotion parameters (never snap) ----
    if (this.first) { this.sp = speed; this.spPrev = speed; this.yawPrev = yawVel; this.pitchPrev = pitchVel; this.cmd = fistTarget; }
    this.sp += (speed - this.sp) * (1 - Math.exp(-dt * 5));
    const sp = this.sp;
    const dts = Math.max(dt, 1e-4);
    const acc = (sp - this.spPrev) / dts; this.spPrev = sp;
    this.accF += (acc - this.accF) * (1 - Math.exp(-dt * 12));
    this.air += ((onGround ? 0 : 1) - this.air) * (1 - Math.exp(-dt * (onGround ? 10 : 6)));
    const yAcc = (yawVel - this.yawPrev) / dts, pAcc = (pitchVel - this.pitchPrev) / dts;
    this.yawPrev = yawVel; this.pitchPrev = pitchVel;
    this.yawAcc += (clamp(yAcc, -200, 200) - this.yawAcc) * (1 - Math.exp(-dt * 20));
    this.pitchAcc += (clamp(pAcc, -200, 200) - this.pitchAcc) * (1 - Math.exp(-dt * 20));

    const g = smooth(0.05, WALK, sp);                 // 0 still .. 1 walking
    const r = smooth(WALK * 0.95, RUN, sp);           // 0 walking .. 1 full run (continuous)
    const grounded = 1 - 0.65 * this.air;
    const idle = 1 - g;

    // ---- Gait phase with a little per-step variation in rhythm and amplitude ----
    const step = bp / Math.PI;                         // one unit per footstep
    const jitter = (0.05 + 0.1 * r) * fbm(step * 0.9, seed + 5);
    const wp = bp + (h > 0 ? Math.PI : 0) + jitter;    // right arm swings with the left leg
    o.walkPhase = wp;
    const ampJ = 1 + (0.06 + 0.1 * r) * fbm(step * 1.1 + 3.7, seed + 9);
    const sw = Math.sin(wp), cw = Math.cos(wp);
    const swingAmp = (A.walkSwing + (A.runSwing - A.walkSwing) * r) * g * ampJ * grounded;

    // Footstep contact: camera lowest when cos(2·bobPhase) = -1. p = 0 at contact .. 1 at the next.
    let p = (2 * bp - Math.PI) / (2 * Math.PI); p -= Math.floor(p);
    // Fast-attack, slower-release pulse peaking at p = 0.2 and returning to exactly 0 at the next contact.
    const q = p / 0.2, q1 = 1 / 0.2, impact = q * q * Math.exp(2 - 2 * q) - p * q1 * q1 * Math.exp(2 - 2 * q1); // C1 onset

    // ---- Slow part: spring-damper toward a base offset, plus inertial forces ----
    // Base: running brings the hands up and forward (elbows bent) and a touch inward.
    const tx = -h * 0.016 * r + clamp(yawVel * 0.006, -0.025, 0.025);
    const ty = 0.05 * r - clamp(pitchVel * 0.005, -0.02, 0.02);
    const tz = -0.04 * r;
    // Landing: a short downward push (a force over ~50 ms, not a velocity jump, so the wrist never snaps).
    if (this.wasGround !== onGround) { if (onGround && !this.first) this.landKick = 7; this.wasGround = onGround; }
    this.landKick *= Math.exp(-dt * 20);
    // Inertia: turning the camera drags the hand behind; braking throws it forward; accelerating pulls it back.
    // (gains are m/s² per rad/s² and per m/s²; spring k = 90 turns 1 m/s² into ~1.1 cm of static offset)
    const fx = clamp(this.yawAcc * 0.035, -3.5, 3.5);
    const fy = -clamp(this.pitchAcc * 0.03, -3, 3) - clamp(this.accF, -15, 15) * 0.12 - this.landKick;
    const fz = clamp(this.accF, -15, 15) * 0.3;
    if (this.first) this.sx.set(tx, ty, tz);
    const k = A.stiffness, c = A.damping;
    const nSub = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h2 = dt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.sv.x += (k * (tx - this.sx.x) - c * this.sv.x + fx) * h2;
      this.sv.y += (k * (ty - this.sx.y) - c * this.sv.y + fy) * h2;
      this.sv.z += (k * (tz - this.sx.z) - c * this.sv.z + fz) * h2;
      this.sx.addScaledVector(this.sv, h2);
    }
    this.sx.x = clamp(this.sx.x, -0.08, 0.08); this.sx.y = clamp(this.sx.y, -0.08, 0.1); this.sx.z = clamp(this.sx.z, -0.1, 0.08);

    // ---- Fast part: swing, bob, sway, breathing, noise ----
    let px = this.sx.x, py = this.sx.y, pz = this.sx.z;
    // Forward/back swing (forward = -z), on an arc that rises at both ends and pumps up when running.
    pz += -sw * swingAmp;
    py += swingAmp * (0.25 * sw * sw + 0.3 * r * sw);
    // Forward swing crosses slightly toward the body midline; body sway carries both hands the same way.
    px += -h * A.lateral * g * (1 + 1.2 * r) * (0.5 + 0.5 * sw) * grounded;
    px += A.lateral * 0.6 * g * Math.sin(bp - 0.5) * grounded;
    // Up-down bob lagging the camera bob, and a sharp drop on each footfall when running.
    py += A.bob * g * 0.55 * Math.cos(2 * bp - 0.7) * grounded;
    py -= A.bob * (0.3 + 0.8 * r) * g * impact * (1 - this.air);
    // Breathing: slow rise/fall, mostly when still; tiny forward component.
    const br = Math.sin(t * Math.PI * 2 * this.breathRate + this.breathPh) + 0.25 * noise1(t * 0.3, seed + 31);
    const bAmp = A.idleBreath * (1 - 0.6 * g);
    py += br * bAmp;
    pz += br * bAmp * 0.3;
    // Small drift so the hand is never perfectly still.
    px += 0.0025 * fbm(t * 0.21, seed + 41) * (1 - 0.5 * g);
    py += 0.0018 * fbm(t * 0.17, seed + 43) * (1 - 0.5 * g);

    // ---- Fist (staggered) ----
    this.cmd += (fistTarget - this.cmd) * (1 - Math.exp(-dt * 30));
    const cmdVel = (fistTarget - this.cmd);
    this.cmdVel += (cmdVel - this.cmdVel) * (1 - Math.exp(-dt * 20));
    this.histT[this.histI] = this.time; this.histV[this.histI] = this.cmd;
    this.histI = (this.histI + 1) % HIST; this.histN = Math.min(this.histN + 1, HIST);
    const closing = this.cmdVel >= 0;
    const W = 26; // per-finger critically damped spring (rad/s): eased in/out curl
    let fistMin = 1, fistAvg = 0;
    for (let i = 0; i < FINGERS; i++) {
      const delay = closing ? CLOSE_ORDER[i] * A.fistStagger : OPEN_ORDER[i] * A.fistStagger * 0.5;
      const target = this.first ? this.cmd : this.cmdAt(delay);
      if (this.first) { this.fz[i] = target; this.fzv[i] = 0; }
      const w = i === 4 ? W * 0.85 : W;
      for (let j = 0; j < nSub; j++) {
        this.fzv[i] += (w * w * (target - this.fz[i]) - 2 * w * this.fzv[i]) * h2;
        this.fz[i] += this.fzv[i] * h2;
      }
      this.fz[i] = clamp(this.fz[i], 0, 1);
      fistMin = Math.min(fistMin, this.fz[i]);
      fistAvg += this.fz[i] / FINGERS;
    }
    // Tension builds once every finger is closed, and lets go quickly.
    const tWant = smooth(0.82, 0.99, fistMin) * fistTarget;
    this.tension += (tWant - this.tension) * (1 - Math.exp(-dt * (tWant > this.tension ? 4 : 9)));
    const tens = clamp(this.tension, 0, 1);
    o.tension = tens;
    // Tremble while squeezing.
    const tr = A.tremble * tens;
    px += tr * noise1(t * 13.0, seed + 61);
    py += tr * noise1(t * 14.7, seed + 63);
    pz += tr * 0.6 * noise1(t * 12.1, seed + 65);

    o.pos.set(px * inView, py * inView, pz * inView);

    // ---- Wrist rotation ----
    // Swing pitch with a whip at the end of each stroke (the wrist keeps going and snaps back).
    const lagS = Math.sin(wp - 0.9);
    const whip = r * 0.2 * lagS * lagS * lagS * grounded;
    let rx = -(0.1 + 0.08 * r) * g * sw * ampJ * grounded - whip;
    rx += -0.06 * r;                                         // pumping: knuckles tilt up a little
    rx += -this.sv.y * 0.5 + this.sv.z * 0.4;                // inertia shows in the wrist too
    rx += A.wristRoll * 0.25 * fbm(t * 0.13, seed + 71) * (1 - 0.5 * g);
    let ry = h * 0.05 * g * sw + this.sx.x * 1.2 - this.sv.x * 0.35;
    ry += A.wristRoll * 0.2 * fbm(t * 0.11, seed + 73) * (1 - 0.5 * g);
    // Roll in sync with the camera bob, plus a little with the swing.
    let rz = h * A.wristRoll * g * (0.6 * Math.cos(2 * bp) + 0.4 * sw) * grounded;
    rz += -this.sv.x * 0.5 + A.wristRoll * 0.3 * fbm(t * 0.17, seed + 75) * (1 - 0.5 * g);
    rz += 0.04 * tens * noise1(t * 11.0, seed + 77);
    this.e.set(rx * inView, ry * inView, rz * inView, 'XYZ');
    o.rot.setFromEuler(this.e);

    // ---- Fingers ----
    const micro = A.microMotion / 1.45; // radians -> normalised curl (prox joint range ≈ 1.45 rad)
    for (let i = 0; i < FINGERS; i++) {
      const relaxedWalk = IDLE_CURL[i] + (WALK_CURL[i] - IDLE_CURL[i]) * g;
      let relaxed = relaxedWalk + (RUN_CURL[i] - relaxedWalk) * r;
      // Walking: each finger flexes with the swing, own phase and amplitude.
      relaxed += WALK_FLEX[i] * g * (1 - r) * Math.sin(wp + FLEX_PHASE[i]);
      // Running: flutter that is not a clean sine (noise + a step-locked flick with jitter).
      relaxed += r * (0.05 * fbm(t * (3.1 + 0.4 * i), seed + 300 + i) + 0.035 * Math.sin(2 * wp + FLEX_PHASE[i] * 2 + 0.8 * fbm(step * 0.7, seed + 310 + i)));
      // Idle micro-movements: three frequencies per finger, never synced across hands.
      const f0 = this.finFreq[i * 3], f1 = this.finFreq[i * 3 + 1], f2 = this.finFreq[i * 3 + 2];
      const mn = 0.55 * noise1(t * f0, seed + 400 + i) + 0.3 * noise1(t * f1, seed + 410 + i) + 0.15 * noise1(t * f2, seed + 420 + i);
      relaxed += micro * mn * (1 - 0.6 * r);
      relaxed = clamp(relaxed, 0, 0.85);
      const f = this.fz[i];
      let curl = relaxed + (1 - relaxed) * f;
      curl -= 0.015 * tens * (0.5 + 0.5 * noise1(t * 16 + i * 3.1, seed + 500 + i)); // squeeze tremble (below the clamp)
      o.curl[i] = clamp(curl, 0, 1);
    }
    const spreadBase = 0.85 - 0.15 * g - 0.4 * r + 0.06 * fbm(t * 0.2, seed + 600) * idle;
    o.spread = clamp(spreadBase * (1 - fistAvg), 0, 1);

    this.first = false;
    return o;
  }
}
