// Motion-capture clips for the three bystanders, retargeted offline per character by tools/anim/retarget.py
// (Quaternius Universal Animation Library 1, CC0) and stored in assets/characters/anim/<name>.json. After every
// rebuild of the character GLBs run `tools/render/blender.sh -b --python tools/anim/retarget.py` (about 3 s);
// characters.js warns in the console when a body's rest pose is more than 1 cm off what the clips were baked for.
//
// A sampled clip is a pose in exactly the form characters.js' Pose uses: one quaternion per joint in the
// character's own axes (x = its left, y = up, z = forward) relative to the rest pose, a pelvis offset in character
// space and five finger curls per hand. So a clip pose can be copied into a Pose and the procedural layers
// (look-at, pointing, leg IK) run on top unchanged. A clip pose also carries the ankle positions and foot contacts
// the clip intends, for the foot planner.
//
//   const set = await loadClipSet('karim');
//   const pose = new ClipPose();
//   set.get('walk_formal').sample(t, pose);         // one clip
//   const player = new ClipPlayer(set);              // or a mix with cross-fades and rates
//   player.play('idle', { fade: 0.4, rate: 0.95 });
//   player.update(dt); player.sampleInto(pose);      // player.rootDistance: metres moved this update
//   const standing = new StandingMotion(set, { seed: 2.9 });   // idle with weight shifts and talking, per man
//
// Clips (all three men): idle, idle_m (the same, weight on the other leg), talk, talk_m (gesturing hand swapped),
// walk (0.94-1.01 m/s), walk_formal (upright, arms nearly still: Karim), interact (left hand reaches out),
// pickup (from waist height), hit_chest, hit_head (flinch material, use at a third of their strength).

import * as THREE from 'three';

const ANIM_BASE = new URL('../../assets/characters/anim/', import.meta.url);

/** Joints of a pose, in characters.js' order (parents first). */
export const CLIP_JOINTS = [
  'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
  'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l',
  'thigh_r', 'calf_r', 'foot_r', 'ball_r',
];
const NJ = CLIP_JOINTS.length;
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
/** Share of a finger's curl at its first, middle and end joint (as characters.js applies it). */
export const FINGER_JOINT_GAIN = [0.85, 1.0, 0.7];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

// ---------------------------------------------------------------------------------------------------- poses

/** A sampled clip pose; q, pelvis, fingersL and fingersR have the shape of characters.js' Pose. */
export class ClipPose {
  constructor() {
    this.q = CLIP_JOINTS.map(() => new THREE.Quaternion());
    this.pelvis = new THREE.Vector3();
    this.fingersL = new Float32Array(5);
    this.fingersR = new Float32Array(5);
    this.ankleL = new THREE.Vector3();           // where the clip puts the ankles (character space)
    this.ankleR = new THREE.Vector3();
    this.contactL = 0;                           // 1 while that foot is on the ground (heel strike to toe-off)
    this.contactR = 0;
  }

  copy(p) {
    for (let i = 0; i < NJ; i++) this.q[i].copy(p.q[i]);
    this.pelvis.copy(p.pelvis);
    this.fingersL.set(p.fingersL);
    this.fingersR.set(p.fingersR);
    if (p.ankleL) {
      this.ankleL.copy(p.ankleL); this.ankleR.copy(p.ankleR);
      this.contactL = p.contactL; this.contactR = p.contactR;
    }
    return this;
  }

  /**
   * this = this blended towards p by w (0 keeps this, 1 gives p). mask: optional per-joint factors on w (length
   * 22, CLIP_JOINTS order); the pelvis offset follows joint 0, the fingers their hand, ankles and contacts the thighs.
   */
  mixWith(p, w, mask = null) {
    if (w <= 0) return this;
    const m = (i) => (mask ? w * mask[i] : w);
    for (let i = 0; i < NJ; i++) this.q[i].slerp(p.q[i], m(i));
    this.pelvis.lerp(p.pelvis, m(0));
    const wl = m(9), wr = m(13);
    for (let i = 0; i < 5; i++) {
      this.fingersL[i] += (p.fingersL[i] - this.fingersL[i]) * wl;
      this.fingersR[i] += (p.fingersR[i] - this.fingersR[i]) * wr;
    }
    const wf = m(14);
    this.ankleL.lerp(p.ankleL, wf);
    this.ankleR.lerp(p.ankleR, wf);
    this.contactL += (p.contactL - this.contactL) * wf;
    this.contactR += (p.contactR - this.contactR) * wf;
    return this;
  }
}

// ---------------------------------------------------------------------------------------------------- clips

export class Clip {
  constructor(name, data, fps) {
    this.name = name;
    this.source = data.source;
    this.frames = data.frames;
    this.fps = fps;
    this.duration = data.duration;
    this.loop = data.loop;
    this.rootSpeed = data.rootSpeed;             // m/s along +z at rate 1 (walks); 0 for clips in place
    this.stride = data.stride;                   // metres per cycle (two steps) at any rate
    this.rightStrike = data.rightStrike;         // right heel strike as a fraction of the cycle, or null
    const n = this.frames;
    const q16 = decode(data.q, Int16Array);
    this.q = new Float32Array(q16.length);
    for (let i = 0; i < q16.length; i++) this.q[i] = q16[i] / 32767;
    const f = (b64) => { const a = decode(b64, Int16Array); const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / 10000; return o; };
    this.pelvis = f(data.pelvis);
    this.ankles = f(data.ankles);
    this.fingers = f(data.fingers);
    this.contact = decode(data.contact, Uint8Array);
    if (this.q.length !== n * NJ * 4 || this.pelvis.length !== n * 3 || this.fingers.length !== n * 10) {
      throw new Error(`clip ${name}: data does not match ${n} frames`);
    }
  }

  /** Frame position (fractional) of time t, looping or clamped. */
  frameAt(t) {
    const n = this.frames;
    const d = this.duration;
    let u;
    if (this.loop) u = (((t % d) + d) % d) / d;
    else u = clamp(t / d, 0, 1);
    return u * (n - 1);
  }

  /** Writes the pose at time t (seconds) into out (a ClipPose). */
  sample(t, out) {
    const u = this.frameAt(t);
    const i0 = Math.min(Math.floor(u), this.frames - 2);
    const a = u - i0;
    const i1 = i0 + 1;
    const q = this.q;
    for (let j = 0; j < NJ; j++) {
      const p = (i0 * NJ + j) * 4;
      const r = (i1 * NJ + j) * 4;
      const s = q[p] * q[r] + q[p + 1] * q[r + 1] + q[p + 2] * q[r + 2] + q[p + 3] * q[r + 3] < 0 ? -1 : 1;
      out.q[j].set(
        q[p] + (s * q[r] - q[p]) * a, q[p + 1] + (s * q[r + 1] - q[p + 1]) * a,
        q[p + 2] + (s * q[r + 2] - q[p + 2]) * a, q[p + 3] + (s * q[r + 3] - q[p + 3]) * a).normalize();
    }
    const lerp3 = (arr, k, v) => v.set(
      arr[i0 * k] + (arr[i1 * k] - arr[i0 * k]) * a,
      arr[i0 * k + 1] + (arr[i1 * k + 1] - arr[i0 * k + 1]) * a,
      arr[i0 * k + 2] + (arr[i1 * k + 2] - arr[i0 * k + 2]) * a);
    lerp3(this.pelvis, 3, out.pelvis);
    const an = this.ankles;
    out.ankleL.set(an[i0 * 6] + (an[i1 * 6] - an[i0 * 6]) * a, an[i0 * 6 + 1] + (an[i1 * 6 + 1] - an[i0 * 6 + 1]) * a,
      an[i0 * 6 + 2] + (an[i1 * 6 + 2] - an[i0 * 6 + 2]) * a);
    out.ankleR.set(an[i0 * 6 + 3] + (an[i1 * 6 + 3] - an[i0 * 6 + 3]) * a,
      an[i0 * 6 + 4] + (an[i1 * 6 + 4] - an[i0 * 6 + 4]) * a, an[i0 * 6 + 5] + (an[i1 * 6 + 5] - an[i0 * 6 + 5]) * a);
    const fi = this.fingers;
    for (let k = 0; k < 5; k++) {
      out.fingersL[k] = fi[i0 * 10 + k] + (fi[i1 * 10 + k] - fi[i0 * 10 + k]) * a;
      out.fingersR[k] = fi[i0 * 10 + 5 + k] + (fi[i1 * 10 + 5 + k] - fi[i0 * 10 + 5 + k]) * a;
    }
    const c = this.contact;
    out.contactL = c[i0 * 2] + (c[i1 * 2] - c[i0 * 2]) * a;
    out.contactR = c[i0 * 2 + 1] + (c[i1 * 2 + 1] - c[i0 * 2 + 1]) * a;
    return out;
  }

  /** Clip time at gait phase ph (radians, 0 = right heel strike, as characters.js counts it). */
  timeAtPhase(ph) {
    const f = ph / (Math.PI * 2) + (this.rightStrike || 0);
    return (f - Math.floor(f)) * this.duration;
  }
}

export class ClipSet {
  constructor(name, doc) {
    if (doc.format !== 'shed-clips/1') throw new Error(`${name}: unknown clip format ${doc.format}`);
    for (let i = 0; i < NJ; i++) {
      if (doc.joints[i] !== CLIP_JOINTS[i]) throw new Error(`${name}: clip joints do not match (${doc.joints[i]})`);
    }
    this.name = name;
    this.made = doc.made;
    this.rest = doc.rest;                        // rest positions of a few bones when the clips were baked
    this.hipRatio = doc.hip_ratio;
    this.clips = {};
    for (const [k, v] of Object.entries(doc.clips)) this.clips[k] = new Clip(k, v, doc.fps);
  }

  get(name) {
    const c = this.clips[name];
    if (!c) throw new Error(`${this.name}: no clip "${name}"`);
    return c;
  }

  has(name) { return !!this.clips[name]; }

  /**
   * Largest distance (m) between the rest positions the clips were baked for and the skeleton's rest now
   * (bones: map name -> world position at rest). Above a few millimetres, re-run tools/anim/retarget.py.
   */
  restMismatch(restWorld) {
    let worst = 0;
    for (const [b, p] of Object.entries(this.rest)) {
      const w = restWorld[b];
      if (w) worst = Math.max(worst, Math.hypot(w.x - p[0], w.y - p[1], w.z - p[2]));
    }
    return worst;
  }
}

/** Loads assets/characters/anim/<name>.json. */
export async function loadClipSet(name, { base = ANIM_BASE } = {}) {
  const url = new URL(`${name}.json`, base).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`clips for ${name}: HTTP ${res.status}`);
  return new ClipSet(name, await res.json());
}

// ---------------------------------------------------------------------------------------------------- mixing

/**
 * Plays clips with cross-fades. Every layer has its own clock, rate and weight; the pose is the weighted blend of
 * all layers (normalised), and rootDistance is the blended root travel of the last update. Fades are eased.
 */
export class ClipPlayer {
  constructor(set) {
    this.set = set;
    this.layers = [];
    this.rootDistance = 0;
    this._tmp = new ClipPose();
  }

  layer(name) { return this.layers.find((l) => l.clip.name === name) || null; }

  /**
   * Sets target weights, e.g. mix({ idle: 0.4, talk: 0.6 }, { fade: 0.4 }); clips not named fade out.
   * opts.rates / opts.times: per clip rate and start time (for clips not playing yet); opts.sync: start a new
   * clip at the same moment of its cycle as the named one is in its own.
   */
  mix(weights, { fade = 0.3, rates = {}, times = {}, sync = null } = {}) {
    const retarget = (l, w) => { l.from = l.weight; l.to = w; l.p = fade > 0 ? 0 : 1; l.dur = fade; if (fade <= 0) l.weight = w; };
    for (const l of this.layers) if (!(l.clip.name in weights)) retarget(l, 0);
    for (const [name, w] of Object.entries(weights)) {
      let l = this.layer(name);
      if (!l) {
        const clip = this.set.get(name);
        let time = times[name] ?? 0;
        const other = sync && this.layer(sync);
        if (other) time = (other.time / other.clip.duration) * clip.duration;
        l = { clip, time, rate: rates[name] ?? 1, weight: 0, from: 0, to: 0, p: 1, dur: 0 };
        this.layers.push(l);
      }
      if (rates[name] !== undefined) l.rate = rates[name];
      retarget(l, w);
    }
    return this;
  }

  play(name, { fade = 0.3, rate = 1, time = 0, weight = 1 } = {}) {
    return this.mix({ [name]: weight }, { fade, rates: { [name]: rate }, times: { [name]: time } });
  }

  update(dt) {
    let dist = 0;
    let wsum = 0;
    for (const l of this.layers) {
      l.time += dt * l.rate;
      if (l.p < 1) {
        l.p = Math.min(1, l.p + dt / Math.max(l.dur, 1e-3));
        l.weight = l.from + (l.to - l.from) * smooth(l.p);
      }
      dist += l.weight * l.clip.rootSpeed * l.rate * dt;
      wsum += l.weight;
    }
    this.layers = this.layers.filter((l) => l.weight > 1e-4 || l.to > 0);
    this.rootDistance = wsum > 0 ? dist / wsum : 0;
    return this;
  }

  /** Writes the blend of all layers into out (a ClipPose). */
  sampleInto(out) {
    let acc = 0;
    for (const l of this.layers) {
      if (l.weight <= 0) continue;
      if (acc === 0) { l.clip.sample(l.time, out); acc = l.weight; continue; }
      l.clip.sample(l.time, this._tmp);
      acc += l.weight;
      out.mixWith(this._tmp, l.weight / acc);
    }
    if (acc === 0 && this.layers.length) this.layers[0].clip.sample(this.layers[0].time, out);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------- standing

/**
 * Standing still as a person does: the captured idle; the weight moved onto the other leg now and then
 * (motion-speech 2.1: about two events a minute, here a shift every 20-45 s, half that when worried); talking
 * blended over it at about 60 % (2.9), one hand gesturing (85 %) and the other mostly down (25 %). Each man gets
 * his own rate, start time, intervals and gesturing hand from his seed, so the three never move in unison (2.16).
 * The talking clip follows the standing side (talk / talk_m share the idle's stance), so the feet stay where they
 * are when he starts or stops talking; no shift starts while he talks.
 *
 *   const s = new StandingMotion(set, { seed: 2.9, rate: 0.92 });
 *   each frame: s.update(dt, { talking }); s.sampleInto(pose);
 */
export class StandingMotion {
  constructor(set, { seed = 0, rate = 1, talkWeight = 0.6, shiftEvery = [20, 45], shiftTime = 1.2, hand = null,
    handWeights = [0.85, 0.25] } = {}) {
    this.set = set;
    this.seed = seed;
    this.rate = rate * (0.94 + 0.12 * hash(seed + 1));
    this.talkWeight = talkWeight;
    // the talking clip moves both hands all the time; people mostly gesture with one (motion-speech 2.9)
    this.hand = hand || (hash(seed + 7) < 0.7 ? 'right' : 'left');
    const [busy, quiet] = handWeights;
    const wl = this.hand === 'left' ? busy : quiet, wr = this.hand === 'left' ? quiet : busy;
    this.talkMask = new Float32Array(NJ).fill(1);
    for (let i = 6; i <= 9; i++) this.talkMask[i] = wl / talkWeight;
    for (let i = 10; i <= 13; i++) this.talkMask[i] = wr / talkWeight;
    this.shiftEvery = shiftEvery;
    this.shiftTime = shiftTime;
    this.worried = false;                        // halves the time between weight shifts
    this.side = hash(seed + 2) < 0.5 ? 0 : 1;    // 0: idle / talk, 1: idle_m / talk_m
    this.sideBlend = this.side;                  // eased towards side
    this._from = this.side;
    this._p = 1;
    this.talking = 0;                            // eased 0..1
    this._count = 0;
    this._next = this._interval() * hash(seed + 5);
    this.idle = [set.get('idle'), set.get('idle_m')];
    this.talk = [set.get('talk'), set.get('talk_m')];
    this.tIdle = hash(seed + 4) * this.idle[0].duration;
    this.tTalk = hash(seed + 6) * this.talk[0].duration;
    this._a = new ClipPose();
    this._b = new ClipPose();
  }

  _interval() {
    const [a, b] = this.shiftEvery;
    const t = a + (b - a) * hash(this.seed * 7.3 + this._count * 1.7);
    return this.worried ? t * 0.5 : t;
  }

  /** Moves the weight onto the other leg now. */
  shiftWeight() {
    this._from = this.sideBlend;
    this.side = 1 - this.side;
    this._p = 0;
    this._count++;
    this._next = this._interval();
  }

  update(dt, { talking = false } = {}) {
    this._next -= dt;
    if (this._next <= 0) {
      if (this.talking > 0 || talking) this._next = 2;
      else this.shiftWeight();
    }
    if (this._p < 1) {
      this._p = Math.min(1, this._p + dt / this.shiftTime);
      this.sideBlend = this._from + (this.side - this._from) * smooth(this._p);
    }
    this.talking = clamp(this.talking + (talking ? dt / 0.45 : -dt / 0.7), 0, 1);
    this.tIdle += dt * this.rate;
    this.tTalk += dt * this.rate;
    return this;
  }

  sampleInto(out) {
    const s = this.sideBlend;
    this.idle[0].sample(this.tIdle, out);
    if (s > 0) out.mixWith(this.idle[1].sample(this.tIdle, this._a), s);
    const w = smooth(this.talking) * this.talkWeight;
    if (w > 0) {
      this.talk[0].sample(this.tTalk, this._a);
      if (s > 0) this._a.mixWith(this.talk[1].sample(this.tTalk, this._b), s);
      out.mixWith(this._a, w, this.talkMask);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------- bones

/**
 * Writes a pose onto a skeleton the way characters.js' _apply does, for pages that show clips without
 * characters.js (debug-motion.html). root: the GLB scene at the origin, before it is moved.
 */
export class RigBinding {
  constructor(root) {
    root.updateMatrixWorld(true);
    const bones = {};
    root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    this.bones = bones;
    const missing = CLIP_JOINTS.filter((n) => !bones[n]);
    if (missing.length) throw new Error(`bones missing: ${missing.join(', ')}`);
    const record = (bone) => {
      const pRW = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      return { bone, restQ: bone.quaternion.clone(), restPos: bone.position.clone(), pRW, pRWinv: pRW.clone().invert(),
        wp: bone.getWorldPosition(new THREE.Vector3()) };
    };
    this.rest = CLIP_JOINTS.map((n) => record(bones[n]));
    this.restWorld = {};
    for (const [n, b] of Object.entries(bones)) this.restWorld[n] = b.getWorldPosition(new THREE.Vector3());
    // finger curl axes from the rest geometry of each hand (the same construction as characters.js)
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
    const pos = (n) => { if (!bones[n]) throw new Error(`bone ${n} missing`); return bones[n].getWorldPosition(new THREE.Vector3()); };
    const dir = (a, b) => new THREE.Vector3().subVectors(b, a).normalize();
    this.hands = {};
    for (const s of ['l', 'r']) {
      const wrist = pos(`hand_${s}`);
      const palm = new THREE.Vector3().crossVectors(v1.subVectors(pos(`index_01_${s}`), wrist), v2.subVectors(pos(`pinky_01_${s}`), wrist)).normalize();
      this.hands[s] = FINGERS.map((f) => {
        const p = [1, 2, 3].map((k) => pos(`${f}_0${k}_${s}`));
        return [0, 1, 2].map((k) => {
          const d = k < 2 ? dir(p[k], p[k + 1]) : dir(p[1], p[2]);
          let axis;
          if (f === 'thumb') {
            axis = palm.clone();
            if (v4.crossVectors(axis, d).dot(v3.subVectors(pos(`index_01_${s}`), p[0])) < 0) axis.negate();
          } else {
            axis = new THREE.Vector3().crossVectors(d, palm).normalize();
            if (v4.crossVectors(axis, d).y > 0) axis.negate();
          }
          return { ...record(bones[`${f}_0${k + 1}_${s}`]), axis };
        });
      });
    }
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  apply(pose) {
    for (let i = 0; i < NJ; i++) {
      const b = this.rest[i];
      b.bone.quaternion.copy(b.pRWinv).multiply(pose.q[i]).multiply(b.pRW).multiply(b.restQ);
    }
    const p = this.rest[0];
    p.bone.position.copy(this._v.copy(pose.pelvis).applyQuaternion(p.pRWinv)).add(p.restPos);
    for (const s of ['l', 'r']) {
      const curl = s === 'l' ? pose.fingersL : pose.fingersR;
      this.hands[s].forEach((joints, f) => joints.forEach((b, k) => {
        this._q.setFromAxisAngle(b.axis, curl[f] * FINGER_JOINT_GAIN[k] * (f === 0 && k === 0 ? 0.5 : 1));
        b.bone.quaternion.copy(b.pRWinv).multiply(this._q).multiply(b.pRW).multiply(b.restQ);
      }));
    }
  }
}
