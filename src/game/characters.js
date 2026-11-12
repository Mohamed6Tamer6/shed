// The three people of the scenario: Mahmoud (student), Uncle Fathy (farm worker), Karim (engineer).
//
// The GLBs (assets/characters/*.glb, built by tools/characters/build_characters.py with MPFB / MakeHuman) hold a
// skinned A-pose. Standing, talking and slow walking come from motion capture (clips.js: Quaternius UAL 1, CC0,
// retargeted per man by tools/anim/retarget.py into assets/characters/anim/; re-run that after every rebuild of the
// GLBs). Running, alarm, pointing, looking, the feet when standing and the face are computed here, every frame, on
// top of it, straight onto the bones:
//
//   - a pose is one rotation per joint, written in the character's own axes (x = its left, y = up, z = forward)
//     relative to the rest pose, so the code below never needs to know how a bone is oriented in the file;
//   - legs are solved with two-bone IK from foot targets, so a planted foot stays planted while the hips move;
//   - walking and running plan the feet first (stance travels back at exactly the body's speed, swing arcs
//     forward), then put the hips as high as both legs allow, then swing the arms against the legs.
//
//   const people = await loadCharacters(manager);
//   scene.add(people.karim.group);              // origin at the feet, facing +Z
//   people.karim.setAction('talk');             // idle | talk | alarm | walk | run
//   people.karim.lookAt(camera.position);       // null to stop
//   people.karim.pointAt(extinguisher.position);
//   people.mahmoud.walkTo([a, b, c], { run: true, onArrive: () => {} });
//   people.fathy.setMood('worried');            // neutral | worried | alarm | stern | relieved | pleased
//   people.karim.speak('ماذا حدث؟', 1.4);        // the mouth moves for the line, starting now; returns its length
//   each frame: for (const p of Object.values(people)) p.update(dt);
//
// The face (blink, gaze, moods, the mouth) is face.js: morph targets on the head and the parts on it, two eye bones.
// Without clip files (or with ?nocharacters stand-ins) the procedural actions below do everything.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Face } from './face.js';
import { loadClipSet, ClipPose, StandingMotion } from './clips.js';

const ASSET_BASE = new URL('../../assets/characters/', import.meta.url);
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);

// How each person carries himself. armOut: how far the hanging arms stand off the body (sine of the angle),
// stride: walking stride as a fraction of body height, stoop: forward curve of the back (radians per vertebra),
// tempo: speed of the idle fidgeting, seed: de-synchronises the three. Captured motion: walkClip, clipRate (speed
// of his standing clips), hand (the one he gestures with), walkSpeed (m/s; motion-speech 1.11: an older man about
// 1.0-1.1, a man in his forties 1.3-1.4; under CLIP_LEGS_UNDER he walks on the captured legs).
const PROFILES = {
  mahmoud: { armOut: 0.17, stride: 0.82, stoop: 0.012, tempo: 1.15, seed: 0.3, bounce: 1.1,
    walkClip: 'walk', clipRate: 1.05, hand: 'right', walkSpeed: 1.3 },
  fathy: { armOut: 0.27, stride: 0.74, stoop: 0.05, tempo: 0.85, seed: 2.9, bounce: 0.85,
    walkClip: 'walk', clipRate: 0.9, hand: 'left', walkSpeed: 1.05 },
  karim: { armOut: 0.22, stride: 0.84, stoop: 0.0, tempo: 1.0, seed: 5.2, bounce: 1.0,
    walkClip: 'walk_formal', clipRate: 1.0, hand: 'right', walkSpeed: 1.15 },
};

export const WALK_SPEED = 1.4;
export const RUN_SPEED = 3.4;
// Captured motion (clips.js). Walking: a man whose walking speed is below CLIP_LEGS_UNDER walks on the captured
// legs, faster walkers on the procedural legs with the captured upper body (the captured walks are 0.94-1.01 m/s;
// played much faster they take short hurried steps, motion-speech 1.11). Chosen per walk, never mixed: a blend of
// two different leg solutions drags the planted foot.
const CLIP_LEGS_UNDER = 1.2;
// Standing: turning on the spot (people turn 180 degrees in 3-4 steps and about 1.4 s, motion-speech 1.13) and
// re-planting a foot. dist is for a 1.75 m man; jump: farther than that and the foot is put down at once (teleport).
const TURN_RATE = 2.4;
const STEP = { time: 0.38, dist: 0.2, yaw: 30 * DEG, lift: 0.05, lead: 0.6, jump: 0.8 };

// Joints driven by a pose, in parent-before-child order.
const JOINTS = [
  'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
  'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l',
  'thigh_r', 'calf_r', 'foot_r', 'ball_r',
];
const J = Object.fromEntries(JOINTS.map((name, i) => [name, i]));
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const FINGER_JOINT_GAIN = [0.85, 1.0, 0.7];

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3();

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const smoothstep = (a, b, x) => smooth((x - a) / (b - a));
const softMin = (a, b, k = 80) => {                 // smooth minimum, so the hips do not hit a corner
  const m = Math.min(a, b);
  return m - Math.log(Math.exp(-k * (a - m)) + Math.exp(-k * (b - m))) / k;
};
const hash = (n) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const angleDelta = (from, to) => {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
// A pulse that is 1 for `duty` of every `period` seconds, with soft shoulders.
const envelope = (t, period, duty, phase) => {
  const x = frac(t / period + phase);
  return smoothstep(0, 0.16, x) * (1 - smoothstep(duty, duty + 0.16, x));
};

/** Rotation of rx about x, then ry about y, then rz about z (character axes), written into out. */
function euler(out, rx, ry, rz) {
  out.setFromAxisAngle(AX, rx);
  if (ry) out.premultiply(_q3.setFromAxisAngle(AY, ry));
  if (rz) out.premultiply(_q3.setFromAxisAngle(AZ, rz));
  return out;
}

class Pose {
  constructor() {
    this.q = JOINTS.map(() => new THREE.Quaternion());
    this.pelvis = new THREE.Vector3();
    this.fingersL = new Float32Array(5);
    this.fingersR = new Float32Array(5);
  }

  reset() {
    for (const q of this.q) q.identity();
    this.pelvis.set(0, 0, 0);
    this.fingersL.fill(0);
    this.fingersR.fill(0);
    return this;
  }

  copy(p) {
    for (let i = 0; i < this.q.length; i++) this.q[i].copy(p.q[i]);
    this.pelvis.copy(p.pelvis);
    this.fingersL.set(p.fingersL);
    this.fingersR.set(p.fingersR);
    return this;
  }

  /** this = from blended towards this by w (0 keeps from, 1 keeps this). */
  blendFrom(from, w) {
    for (let i = 0; i < this.q.length; i++) this.q[i].copy(_q1.copy(from.q[i]).slerp(this.q[i], w));
    this.pelvis.lerpVectors(from.pelvis, this.pelvis, w);
    for (let i = 0; i < 5; i++) {
      this.fingersL[i] = lerp(from.fingersL[i], this.fingersL[i], w);
      this.fingersR[i] = lerp(from.fingersR[i], this.fingersR[i], w);
    }
    return this;
  }
}

export class Character {
  constructor(name, gltf, clips = null) {
    this.name = name;
    this.profile = PROFILES[name] || PROFILES.karim;
    this.group = new THREE.Group();
    this.group.name = name;
    this.materials = [];
    this.moving = false;

    const root = gltf.scene;
    root.updateMatrixWorld(true);                     // still at the origin: world space is the character's space
    this._readSkeleton(root);
    this.group.add(root);

    const seen = new Set();
    let top = 0;
    const softHair = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.isSkinnedMesh) o.frustumCulled = false;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (seen.has(m)) continue;
        seen.add(m);
        this.materials.push(m);
        const shell = /_beard(\d+)$/.exec(m.name);
        if (shell && m.alphaTest > 0) softShell(m);
        if (m.transparent) { m.depthWrite = false; o.renderOrder = shell ? 1 + 0.01 * Number(shell[1]) : 2; o.castShadow = false; }
        if (m.alphaTest > 0) m.shadowSide = THREE.DoubleSide;
        // the inside of a mouth is in its own shade, which no light here knows about
        if (/_tongue$/.test(m.name)) { m.color.multiplyScalar(0.45); m.envMapIntensity = 0.3; }
        if (/_teeth$/.test(m.name)) { m.color.multiplyScalar(0.72); m.envMapIntensity = 0.5; }
      }
      if (o.isSkinnedMesh && /_hair$/.test(o.material.name) && o.material.alphaTest > 0) softHair.push(o);
      if (/_(body|head)$/.test(o.name)) {
        // the rest positions themselves: a bounding box would also grow by every morph target (three r169)
        const a = o.geometry.attributes.position;
        for (let i = 0; i < a.count; i++) top = Math.max(top, a.getY(i));
      }
    });
    for (const o of softHair) this.materials.push(addSoftEdges(o));
    this.height = top || this.rest[J.head].wp.y + 0.2;
    this.scale = this.height / 1.75;                  // lengths below are written for a 1.75 m person

    this.time = this.profile.seed * 10;               // action clock
    this.phase = 0;                                   // gait cycle, 0 = right heel strike
    this.gaitScale = 1;                               // stride shortening while starting, stopping, turning
    this.speed = 0;
    this.action = 'idle';
    this._fade = 1;
    this._fadeTime = 0.25;
    this._from = new Pose().reset();
    this._pose = new Pose().reset();
    this._path = null;
    this._faceYaw = null;
    this._look = { target: null, yaw: 0, pitch: 0, weight: 0 };
    this._point = { target: new THREE.Vector3(), on: false, weight: 0 };
    this._headModel = new THREE.Vector3(0, this.height * 0.93, 0);
    this.face = new Face(root, name);
    this.face.hasEyes = !!(this.eyes[0] && this.eyes[1]);
    this._eyeQ = [new THREE.Quaternion(), new THREE.Quaternion()];
    // captured motion (clips.js); null keeps the procedural actions below for everything, as before
    this.clips = clips;
    this._clipPose = new ClipPose();
    this._feet = { l: null, r: null };                // planted feet: { x, z, yaw } in the group's parent space
    this._steps = { l: null, r: null };               // a step in progress per foot
    this._fromGait = false;                           // the feet were last placed by a walk or a run
    this._release = { l: null, r: null };             // a walking foot just lifted, easing from its lock to the clip
    this._legSolve = [];                              // planted legs of this frame, solved again after a fade
    this._legBuf = { l: new THREE.Vector3(), r: new THREE.Vector3() };
    this._walked = 0;                                 // metres walked, for feet planted while walking
    if (clips) {
      const restWorld = Object.fromEntries(JOINTS.map((n, i) => [n, this.rest[i].wp]));
      const off = clips.restMismatch(restWorld);
      if (off > 0.01) console.warn(`${name}: motion clips were baked for another build of this body (${(off * 100).toFixed(1)} cm off): run tools/anim/retarget.py`);
      this.standing = new StandingMotion(clips, { seed: this.profile.seed, rate: this.profile.clipRate || 1, hand: this.profile.hand });
      this._walkClip = clips.has(this.profile.walkClip) ? clips.get(this.profile.walkClip) : clips.get('walk');
    }
    this._evaluate(this._pose, this.action);
    this._overlays(this._pose, 0);
    this._apply(this._pose);
    this.face.commit();
  }

  // ------------------------------------------------------------------------------------------------ public API

  /** 'idle' | 'talk' | 'alarm' | 'walk' | 'run' (walk and run on the spot unless walkTo drives them). */
  setAction(name, { fade = 0.25 } = {}) {
    if (!ACTIONS[name]) throw new Error(`unknown action "${name}"`);
    if (name === this.action) return this;
    this._from.copy(this._pose);                      // blend from whatever is on screen now
    this._fade = fade > 0 ? 0 : 1;
    this._fadeTime = fade;
    this.action = name;
    return this;
  }

  /** Raise the right arm and point at a world position; null lowers it again. */
  pointAt(worldPoint) {
    if (worldPoint) { this._point.target.copy(worldPoint); this._point.on = true; } else this._point.on = false;
    return this;
  }

  /** Look at a world position (the eyes first, head, neck and a little of the chest after); null looks ahead. */
  lookAt(worldPoint) {
    this._look.target = worldPoint ? (this._look.target || new THREE.Vector3()).copy(worldPoint) : null;
    this.face.lookTarget = this._look.target;
    return this;
  }

  /** Say an Arabic line: the mouth moves for it from now on. Returns how long the mouth needs (seconds). */
  speak(text, seconds) {
    return this.face.speak(text, seconds);
  }

  /** 'neutral' | 'worried' | 'alarm' | 'stern' | 'relieved' | 'pleased' (eased in; the face keeps it). */
  setMood(name) {
    this.face.setMood(name);
    if (this.standing) this.standing.worried = name === 'worried' || name === 'alarm';   // shifts his weight more often
    return this;
  }

  /** Turn the whole body to face a world position (with steps, about 2.4 rad/s; 4 rad/s without clips). */
  faceTowards(worldPoint) {
    const p = _v1.copy(worldPoint);
    if (this.group.parent) { this.group.parent.updateWorldMatrix(true, false); this.group.parent.worldToLocal(p); }
    const dx = p.x - this.group.position.x;
    const dz = p.z - this.group.position.z;
    if (dx * dx + dz * dz > 1e-6) this._faceYaw = Math.atan2(dx, dz);
    return this;
  }

  /** Walk (or run) along a polyline given in the space of the group's parent, then go idle and call onArrive. */
  walkTo(points, { run = false, onArrive } = {}) {
    const path = points.map((p) => p.clone());
    if (!path.length) { if (onArrive) onArrive(); return this; }
    this._path = { points: path, index: 0, run, onArrive };
    this._faceYaw = null;
    this.moving = true;
    this.setAction(run ? 'run' : 'walk');
    return this;
  }

  /** Stop where he is (onArrive is not called). */
  stop() {
    this._path = null;
    this.moving = false;
    if (this.action === 'walk' || this.action === 'run') this.setAction('idle');
    return this;
  }

  /** Centre of the head in world space (add about 0.2 m for a bubble above it). */
  headWorldPosition(target = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, false);
    return target.copy(this._headModel).applyMatrix4(this.group.matrixWorld);
  }

  update(dt) {
    dt = clamp(dt, 0, 0.1);
    this.face.tick(dt);
    this.time += dt * (this.action === 'idle' || this.action === 'talk' ? this.profile.tempo : 1);
    if (this.standing) this.standing.update(dt, { talking: this.action === 'talk' });
    this._locomotion(dt);
    const pose = this._pose;
    this._evaluate(pose, this.action, dt);
    if (this._fade < 1) {
      this._fade = Math.min(1, this._fade + dt / Math.max(this._fadeTime, 1e-3));
      pose.blendFrom(this._from, smooth(this._fade));
      if (this._legSolve.length) this._solveLegs(pose);   // a fade must not drag planted feet along
    }
    this._overlays(pose, dt);
    this._apply(pose);
    this.face.commit();
  }

  // ------------------------------------------------------------------------------------------------ rest pose

  _readSkeleton(root) {
    const bones = {};
    root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    this.bones = bones;
    const missing = JOINTS.filter((n) => !bones[n]);
    if (missing.length) throw new Error(`${this.name}: bones missing from the GLB: ${missing.join(', ')}`);

    const record = (bone) => {
      const pRW = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      return {
        bone,
        restQ: bone.quaternion.clone(),
        restPos: bone.position.clone(),
        pRW,
        pRWinv: pRW.clone().invert(),
        wp: bone.getWorldPosition(new THREE.Vector3()),
      };
    };
    this.rest = JOINTS.map((n) => record(bones[n]));
    // eye bones (GLBs built with the face): the gaze turns them; older files have none
    this.eyes = ['eye_l', 'eye_r'].map((n) => (bones[n] && bones[n].parent === bones.head ? record(bones[n]) : null));
    const wp = (n) => this.rest[J[n]].wp;
    const dir = (a, b) => new THREE.Vector3().subVectors(b, a).normalize();

    this.legs = {};
    this.arms = {};
    this.hands = {};
    for (const s of ['l', 'r']) {
      const hip = wp('thigh_' + s), knee = wp('calf_' + s), ankle = wp('foot_' + s), ball = wp('ball_' + s);
      this.legs[s] = {
        hip, knee, ankle, ball,
        l1: hip.distanceTo(knee), l2: knee.distanceTo(ankle),
        t0: dir(hip, knee), s0: dir(knee, ankle),
        heel: 0.05, toe: Math.hypot(ball.x - ankle.x, ball.z - ankle.z),
        thigh: J['thigh_' + s], calf: J['calf_' + s], foot: J['foot_' + s], ballJ: J['ball_' + s],
      };
      const shoulder = wp('upperarm_' + s), elbow = wp('lowerarm_' + s), wrist = wp('hand_' + s);
      const u0 = dir(shoulder, elbow), f0 = dir(elbow, wrist);
      // The rest pose already has the elbow bent (about 40 degrees in MakeHuman's A-pose). That bend gives the
      // hinge axis; poses ask for an absolute elbow angle (0 = straight arm) and the hinge turns by the difference.
      const restBend = Math.acos(clamp(u0.dot(f0), -1, 1));
      const hinge = new THREE.Vector3().crossVectors(u0, f0);
      if (restBend > 5 * DEG) hinge.normalize(); else hinge.crossVectors(u0, AZ).normalize();
      const straight = new THREE.Quaternion().setFromAxisAngle(hinge, -restBend);
      // with the elbow straight, the direction from the shoulder to the tip of the index finger (for pointing)
      const tip = bones[`index_03_${s}`] ? bones[`index_03_${s}`].getWorldPosition(new THREE.Vector3()) : wrist;
      const aim = tip.clone().sub(elbow).applyQuaternion(straight).add(elbow).sub(shoulder).normalize();
      this.arms[s] = {
        shoulder, elbow, wrist, u0, f0, aim,
        elbowAxis: hinge, restBend, straight,
        clavicle: J['clavicle_' + s], upper: J['upperarm_' + s], lower: J['lowerarm_' + s], hand: J['hand_' + s],
      };

      // fingers: curl axes from the rest geometry of the hand
      const need = (n) => { if (!bones[n]) throw new Error(`${this.name}: bone ${n} missing`); return bones[n]; };
      const pos = (n) => need(n).getWorldPosition(new THREE.Vector3());
      const palm = new THREE.Vector3().crossVectors(
        _v1.subVectors(pos(`index_01_${s}`), wrist), _v2.subVectors(pos(`pinky_01_${s}`), wrist)).normalize();
      const fingers = [];
      for (const f of FINGERS) {
        const p = [1, 2, 3].map((k) => pos(`${f}_0${k}_${s}`));
        const joints = [];
        for (let k = 0; k < 3; k++) {
          const d = k < 2 ? dir(p[k], p[k + 1]) : dir(p[1], p[2]);
          let axis;
          if (f === 'thumb') {
            axis = palm.clone();                              // the thumb folds across the palm
            const towards = _v3.subVectors(pos(`index_01_${s}`), p[0]);
            if (_v4.crossVectors(axis, d).dot(towards) < 0) axis.negate();
          } else {
            axis = new THREE.Vector3().crossVectors(d, palm).normalize();
            if (_v4.crossVectors(axis, d).y > 0) axis.negate();   // in the A-pose the palm faces down: curl goes down
          }
          joints.push({ ...record(need(`${f}_0${k + 1}_${s}`)), axis });
        }
        fingers.push(joints);
      }
      this.hands[s] = fingers;
    }
    this.standHalf = 0.105;                           // half the distance between the ankles when standing (1.75 m)
  }

  // ------------------------------------------------------------------------------------------------ locomotion

  _locomotion(dt) {
    const g = this.group;
    const path = this._path;
    if (path) {
      const nominal = path.run ? RUN_SPEED : (this.profile.walkSpeed || WALK_SPEED);
      const target = path.points[path.index];
      const dx = target.x - g.position.x;
      const dz = target.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      const last = path.index === path.points.length - 1;
      let remaining = dist;
      for (let i = path.index; i < path.points.length - 1; i++) remaining += path.points[i].distanceTo(path.points[i + 1]);

      let yawErr = 0;
      if (dist > 1e-4) {
        yawErr = angleDelta(g.rotation.y, Math.atan2(dx, dz));
        const turn = (path.run ? 8 : 6) * dt;
        g.rotation.y += clamp(yawErr, -turn, turn);
      }
      // slow down in sharp turns and before the end, speed up gently
      const accel = path.run ? 7 : 3.5;
      let want = nominal * clamp(Math.cos(yawErr), 0.15, 1);
      want = Math.min(want, Math.sqrt(2 * accel * 0.8 * remaining) + 0.25);
      this.speed += clamp(want - this.speed, -accel * 1.6 * dt, accel * dt);
      const step = Math.min(this.speed * dt, dist);
      this._walked += step;
      if (dist > 1e-6) {
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
        g.position.y = lerp(g.position.y, target.y, clamp(step / dist, 0, 1));
      }
      this.gaitScale = clamp(0.4 + 0.6 * this.speed / nominal, 0.4, 1.1);
      this.phase += TAU * step / this._stride(path.run);
      if (dist - step < (last ? 0.02 : 0.12)) {
        path.index++;
        if (path.index >= path.points.length) {
          const done = path.onArrive;
          this._path = null;
          this.moving = false;
          this.speed = 0;
          this.setAction('idle', { fade: 0.35 });
          if (done) done();
        }
      }
    } else {
      this.speed = 0;
      if (this.action === 'walk' || this.action === 'run') {         // on the spot
        const run = this.action === 'run';
        this.gaitScale = 1;
        this.phase += TAU * (run ? RUN_SPEED : WALK_SPEED) / this._stride(run) * dt;
      }
      if (this._faceYaw !== null) {
        const err = angleDelta(g.rotation.y, this._faceYaw);
        const turn = Math.min(this.clips ? TURN_RATE : 4, 2 + 10 * Math.abs(err)) * dt;   // easing into the last degrees; steps: _plantedLegs
        g.rotation.y += clamp(err, -turn, turn);
        if (Math.abs(err) < 0.004) this._faceYaw = null;
      }
    }
    this.phase %= TAU;
  }

  _stride(run) {
    const base = run ? 1.32 : this.profile.stride;
    const own = base * this.height * this.gaitScale;
    if (run || !this._walkClip) return own;
    // a captured step cannot be shortened, so with clip legs the cadence follows the speed
    return lerp(this._walkClip.stride, own, this._procLegs());
  }

  // ------------------------------------------------------------------------------------------------ pose pieces

  _evaluate(pose, action, dt = 0) {
    pose.reset();
    this._legSolve.length = 0;
    if (this.clips && (action === 'idle' || action === 'talk')) {
      pose.copy(this.standing.sampleInto(this._clipPose));
      this._plantedLegs(pose, this._clipPose.ankleL, this._clipPose.ankleR, dt);
      return;
    }
    if (this.clips && action === 'walk') { this._clipWalk(pose, dt); return; }
    if (action === 'walk' || action === 'run') {     // the procedural gait plans the feet: nothing stays planted
      if (action === 'walk') this._releaseFeet();     // a walk eases them out; a run starts with the action fade
      else { this._feet.l = this._feet.r = null; this._release.l = this._release.r = null; }
      this._steps.l = this._steps.r = null;
      this._fromGait = true;
    }
    ACTIONS[action](this, pose, this.time);
    if (this.clips && action === 'walk') this._gaitRelease(pose, dt);
    if (this.clips && action === 'alarm') {           // the alarm's wide stance, reached with steps
      const sc = this.scale;
      this._plantedLegs(pose, this._flatFoot(_pl[5], 'l', 0.16 * sc, 0.07 * sc), this._flatFoot(_pl[6], 'r', -0.16 * sc, -0.06 * sc), dt);
    }
  }

  /** Walking from the captured walk, its clock driven by the distance walked (phase); procedural legs when fast. */
  _clipWalk(pose, dt) {
    const clip = this._walkClip;
    const cp = clip.sample(clip.timeAtPhase(this.phase), this._clipPose);
    const w = this._procLegs();
    if (w > 0) gait(this, pose, WALK, false);         // legs and pelvis planned by footAt
    for (let i = 0; i < JOINTS.length; i++) {
      const lower = i === J.pelvis || i >= J.thigh_l;
      pose.q[i].slerp(cp.q[i], lower ? 1 - w : 1);    // upper body always from the clip
    }
    pose.pelvis.lerp(cp.pelvis, 1 - w);
    pose.fingersL.set(cp.fingersL);
    pose.fingersR.set(cp.fingersR);
    this._steps.l = this._steps.r = null;
    this._fromGait = true;
    if (w < 1) this._walkLocks(pose, cp, 1 - w, dt);
    else { this._releaseFeet(); this._gaitRelease(pose, dt); }
  }

  /** Planted feet let go: each eases from where it stands into whatever the legs do next (see _gaitRelease). */
  _releaseFeet() {
    const g = this.group;
    for (const s of ['l', 'r']) {
      const f = this._feet[s];
      if (!f) continue;
      let x = f.x, z = f.z;
      if (f.a0) {                                     // a walking lock: where its foot is now, roll included
        const ankle = s === 'l' ? this._clipPose.ankleL : this._clipPose.ankleR;
        const yaw = g.rotation.y;
        _pl[3].set(f.x - g.position.x, 0, f.z - g.position.z).applyAxisAngle(AY, -yaw);
        _pl[3].x += ankle.x - f.a0.x;
        _pl[3].z += ankle.z - f.a0.z + (this._walked - f.d0);
        _pl[3].applyAxisAngle(AY, yaw);
        x = _pl[3].x + g.position.x;
        z = _pl[3].z + g.position.z;
      }
      this._release[s] = { x, z, yaw: f.yaw, u: 0 };
      this._feet[s] = null;
    }
  }

  /** Feet let go by _releaseFeet ease over 0.25 s into the procedural gait's footholds (footAt), not dragged by the fade. */
  _gaitRelease(pose, dt) {
    const g = this.group;
    const yaw = g.rotation.y;
    let any = false;
    for (const s of ['l', 'r']) {
      const r = this._release[s];
      if (!r) continue;
      r.u = Math.min(1, r.u + dt / 0.25);
      const e = smooth(r.u);
      const to = (s === 'l' ? _footL : _footR).pos;
      const buf = this._legBuf[s].set(r.x - g.position.x, 0, r.z - g.position.z).applyAxisAngle(AY, -yaw);
      buf.set(lerp(buf.x, to.x, e), lerp(this.legs[s].ankle.y, to.y, e), lerp(buf.z, to.z, e));
      this._legSolve.push({ s, pos: buf, yaw: angleDelta(yaw, r.yaw) * (1 - e), w: 1 - e, keepFoot: true });
      if (r.u >= 1) this._release[s] = null;
      any = true;
    }
    if (any) this._solveLegs(pose);
  }

  /**
   * Feet planted in the world while the clip legs walk: a foot the clip has down stays where it came down (round
   * turns, and the stance foot when a walk starts from standing), with the clip's own roll over heel and ball added
   * on top; when the clip lifts it, it eases from there into the clip's swing. k: share of the clip legs.
   */
  _walkLocks(pose, cp, k, dt) {
    const g = this.group;
    const yaw = g.rotation.y;
    for (const s of ['l', 'r']) {
      const down = (s === 'l' ? cp.contactL : cp.contactR) >= 0.5;
      const ankle = s === 'l' ? cp.ankleL : cp.ankleR;
      const buf = this._legBuf[s];
      if (down) {
        this._release[s] = null;
        let f = this._feet[s];
        if (!f || f.a0 === undefined) {               // comes down now (or was standing): from where the clip has it
          const keep = f;
          const p = _pl[2].set(ankle.x, 0, ankle.z).applyAxisAngle(AY, yaw);
          f = this._feet[s] = keep ? { ...keep } : { x: p.x + g.position.x, z: p.z + g.position.z, yaw };
          f.a0 = ankle.clone();
          f.d0 = this._walked;
        }
        // where it came down, in today's model space, plus the clip's roll since then (its ankle against a point
        // that travels back with the walk)
        buf.set(f.x - g.position.x, 0, f.z - g.position.z).applyAxisAngle(AY, -yaw);
        buf.x += ankle.x - f.a0.x;
        buf.z += ankle.z - f.a0.z + (this._walked - f.d0);
        buf.y = ankle.y;
        this._legSolve.push({ s, pos: buf, yaw: angleDelta(yaw, f.yaw), w: k, keepFoot: true });
      } else {
        const f = this._feet[s];
        if (f) {
          _pl[3].set(f.x - g.position.x, 0, f.z - g.position.z).applyAxisAngle(AY, -yaw);
          const ox = f.a0 ? ankle.x - f.a0.x : 0, oz = f.a0 ? ankle.z - f.a0.z + (this._walked - f.d0) : 0;
          const p = _pl[2].set(_pl[3].x + ox, 0, _pl[3].z + oz).applyAxisAngle(AY, yaw);
          this._release[s] = { x: p.x + g.position.x, z: p.z + g.position.z, yaw: f.yaw, u: 0 };
          this._feet[s] = null;
        }
        const r = this._release[s];
        if (r) {
          r.u = Math.min(1, r.u + dt / 0.2);
          const e = smooth(r.u);
          buf.set(r.x - g.position.x, 0, r.z - g.position.z).applyAxisAngle(AY, -yaw);
          buf.set(lerp(buf.x, ankle.x, e), ankle.y, lerp(buf.z, ankle.z, e));
          this._legSolve.push({ s, pos: buf, yaw: angleDelta(yaw, r.yaw) * (1 - e), w: k * (1 - e), keepFoot: true });
          if (r.u >= 1) this._release[s] = null;
        }
      }
    }
    this._solveLegs(pose);
  }

  /**
   * Solves the legs of this frame's planted feet (this._legSolve) on the pose as it is now: each to its ankle
   * position (model space); keepFoot keeps the foot's own orientation turned by yaw, otherwise the foot is flat
   * with that yaw; w < 1 blends from the pose's own legs.
   */
  _solveLegs(pose) {
    for (const r of this._legSolve) {
      const leg = this.legs[r.s];
      const ids = [leg.thigh, leg.calf, leg.foot, leg.ballJ];
      for (let k = 0; k < 4; k++) _lq[k].copy(pose.q[ids[k]]);
      if (r.keepFoot) {
        _lq[4].copy(pose.q[J.pelvis]).multiply(_lq[0]).multiply(_lq[1]).multiply(_lq[2]);
        _lq[4].premultiply(_lq[5].setFromAxisAngle(AY, r.yaw));
      }
      this._leg(pose, r.s, r.pos, 0, r.keepFoot ? 0 : r.yaw);
      if (r.keepFoot) {
        pose.q[leg.foot].copy(pose.q[J.pelvis]).multiply(pose.q[leg.thigh]).multiply(pose.q[leg.calf]).invert().multiply(_lq[4]);
        pose.q[leg.ballJ].copy(_lq[3]);
      }
      if (r.w < 0.999) for (let k = 0; k < 4; k++) pose.q[ids[k]].copy(_lq[5].copy(_lq[k]).slerp(pose.q[ids[k]], r.w));
    }
  }

  /** 1 when this walk uses the procedural legs (fast walker, or walking on the spot), 0 for the captured legs. */
  _procLegs() {
    const v = this._path && !this._path.run ? (this.profile.walkSpeed || WALK_SPEED) : WALK_SPEED;
    return v < CLIP_LEGS_UNDER ? 0 : 1;
  }

  /**
   * Standing legs. Each foot stays where it was put down (x, z and heading in the group's parent space) until it is
   * more than STEP.dist from the spot the pose wants it on, or turned more than STEP.yaw from the body; then it steps
   * there, one foot at a time, leading a turn still in progress. That is turning on the spot with real steps
   * (motion-speech 1.13), settling after a walk, and still feet through weight shifts. want*: ankles, model space.
   */
  _plantedLegs(pose, wantL, wantR, dt) {
    const g = this.group;
    const yaw = g.rotation.y;
    const want = { l: _pl[0].copy(wantL), r: _pl[1].copy(wantR) };
    const lead = this._faceYaw === null ? 0 : clamp(angleDelta(yaw, this._faceYaw), -STEP.lead, STEP.lead);
    const toParent = (v, a, out) => out.set(v.x, 0, v.z).applyAxisAngle(AY, a).add(_pl[4].set(g.position.x, 0, g.position.z));
    for (const s of ['l', 'r']) {
      const t = toParent(want[s], yaw, _pl[2]);
      let f = this._feet[s];
      if (!f && this._fromGait) {                     // just stopped walking: plant where the foot is on screen
        const p = this.bones['foot_' + s].getWorldPosition(_pl[3]);
        if (g.parent) g.parent.worldToLocal(p);
        f = this._feet[s] = { x: p.x, z: p.z, yaw };
      }
      if (!f || Math.hypot(t.x - f.x, t.z - f.z) > STEP.jump * this.scale) {   // first frame, or the group was moved
        this._feet[s] = { x: t.x, z: t.z, yaw };
        this._steps[s] = null;
      }
    }
    this._fromGait = false;
    if (!this._steps.l && !this._steps.r) {           // the foot furthest from its spot steps, if far enough
      let pick = null, worst = 1;
      for (const s of ['l', 'r']) {
        const f = this._feet[s];
        const t = toParent(want[s], yaw, _pl[2]);
        const e = Math.max(Math.hypot(t.x - f.x, t.z - f.z) / (STEP.dist * this.scale), Math.abs(angleDelta(f.yaw, yaw)) / STEP.yaw);
        if (e > worst) { worst = e; pick = s; }
      }
      if (pick) this._steps[pick] = { u: 0, from: { ...this._feet[pick] } };
    }
    for (const s of ['l', 'r']) {
      let f = this._feet[s];
      let lift = 0;
      const st = this._steps[s];
      if (st) {
        st.u = Math.min(1, st.u + dt / STEP.time);
        const t = toParent(want[s], yaw + lead, _pl[2]);
        const k = smooth(st.u);
        f = { x: lerp(st.from.x, t.x, k), z: lerp(st.from.z, t.z, k), yaw: st.from.yaw + angleDelta(st.from.yaw, yaw + lead) * k };
        lift = STEP.lift * this.scale * Math.sin(Math.PI * st.u);
        if (st.u >= 1) { this._feet[s] = f; this._steps[s] = null; }
      }
      const local = this._legBuf[s].set(f.x - g.position.x, 0, f.z - g.position.z).applyAxisAngle(AY, -yaw);
      local.y = want[s].y + lift;
      this._legSolve.push({ s, pos: local, yaw: angleDelta(yaw, f.yaw), w: 1, keepFoot: false });
    }
    this._solveLegs(pose);
  }

  /** Hanging arm. swing: forward angle at the shoulder, out: extra spread, elbow: bend, twist: about its length. */
  _arm(pose, s, { swing = 0, out = 0, elbow = 0.2, twist = 0.45 } = {}) {
    const arm = this.arms[s];
    const sign = s === 'l' ? 1 : -1;
    const spread = this.profile.armOut + out;
    const hang = _v1.set(sign * spread, -1, 0.03).normalize();
    const q = pose.q[arm.upper].setFromUnitVectors(arm.u0, hang);
    const swung = _q2.setFromAxisAngle(AX, -swing);
    q.premultiply(swung);
    if (twist) {                                      // turn the arm about its own length: the bent forearm comes inwards
      const along = _v2.copy(hang).applyQuaternion(swung);
      q.premultiply(_q2.setFromAxisAngle(along, twist * sign));
    }
    pose.q[arm.lower].setFromAxisAngle(arm.elbowAxis, elbow - arm.restBend);
  }

  /** Arm aimed along a direction given in character axes (before the spine moves it). */
  _armTowards(pose, s, dir, elbow) {
    const arm = this.arms[s];
    pose.q[arm.upper].setFromUnitVectors(arm.u0, _v1.copy(dir).normalize());
    pose.q[arm.lower].setFromAxisAngle(arm.elbowAxis, elbow - arm.restBend);
  }

  /**
   * Two-bone IK. ankle: wanted ankle position in character space, pitch: toes up (+) / heel up (-),
   * yaw: toe-out change. Reads pose.pelvis and pose.q[pelvis], writes thigh, calf, foot and toes.
   */
  _leg(pose, s, ankle, pitch = 0, yaw = 0) {
    const leg = this.legs[s];
    const pelvisRest = this.rest[J.pelvis].wp;
    const Rp = pose.q[J.pelvis];
    const hip = _v1.subVectors(leg.hip, pelvisRest).applyQuaternion(Rp).add(pelvisRest).add(pose.pelvis);
    const v = _v2.subVectors(ankle, hip).applyQuaternion(_q1.copy(Rp).invert());      // in the pelvis' own frame
    const reach = leg.l1 + leg.l2;
    const d = clamp(v.length(), reach * 0.35, reach * 0.9995);
    v.normalize();
    const cosA = clamp((leg.l1 * leg.l1 + d * d - leg.l2 * leg.l2) / (2 * leg.l1 * d), -1, 1);
    // the knee bends in the plane of the leg and the forward axis: rotate about the sideways axis
    const n = _v3.copy(AX).addScaledVector(v, -AX.dot(v)).normalize();
    const thighDir = _v4.copy(v).applyAxisAngle(n, -Math.acos(cosA));
    const qt = pose.q[leg.thigh].setFromUnitVectors(leg.t0, thighDir);
    // shin: from the knee to the ankle, seen from the thigh's rest frame
    const shin = _v3.copy(v).multiplyScalar(d).addScaledVector(thighDir, -leg.l1).normalize();
    shin.applyQuaternion(_q1.copy(qt).invert());
    const qk = pose.q[leg.calf].setFromUnitVectors(leg.s0, shin);
    // foot: absolute orientation, whatever the leg does
    const want = euler(_q2, -pitch, yaw, 0);
    pose.q[leg.foot].copy(Rp).multiply(qt).multiply(qk).invert().multiply(want);
    pose.q[leg.ballJ].setFromAxisAngle(AX, pitch < 0 ? pitch * 0.9 : 0);              // toes stay on the ground
  }

  /** Ankle position for a foot standing flat at (x, z), in character space. */
  _flatFoot(out, s, x, z, lift = 0) {
    return out.set(x, this.legs[s].ankle.y + lift, z);
  }

  /** Stand on both feet with the hips moved by pose.pelvis / pose.q[pelvis]. */
  _stand(pose, { half = this.standHalf * this.scale, zl = 0, zr = 0 } = {}) {
    this._leg(pose, 'l', this._flatFoot(_a3, 'l', half, zl));
    this._leg(pose, 'r', this._flatFoot(_a3, 'r', -half, zr));
  }

  _fingers(pose, l, r = l) {
    for (let i = 0; i < 5; i++) { pose.fingersL[i] = l[i]; pose.fingersR[i] = r[i]; }
  }

  // ------------------------------------------------------------------------------------------------ overlays

  _overlays(pose, dt) {
    const rest = this.rest;
    const g = this.group;
    g.updateWorldMatrix(true, false);
    const toModel = (world, out) => out.copy(world).applyMatrix4(_m1.copy(g.matrixWorld).invert());

    // pointing takes the chest along a little, so the arm does not have to cross the body alone
    const point = this._point;
    point.weight += ((point.on ? 1 : 0) - point.weight) * (dt > 0 ? 1 - Math.exp(-dt * 6) : 1);
    const pPelvis = _p[0].copy(rest[J.pelvis].wp).add(pose.pelvis);
    const R0 = _r[0].copy(pose.q[J.pelvis]);
    if (point.weight > 1e-3) {
      const d = toModel(point.target, _v1).sub(pPelvis).applyQuaternion(_q1.copy(R0).invert());
      const turn = clamp(Math.atan2(d.x, d.z), -1.3, 1.3) * 0.36 * smooth(point.weight) / 3;
      _q1.setFromAxisAngle(AY, turn);
      pose.q[J.spine_01].premultiply(_q1);
      pose.q[J.spine_02].premultiply(_q1);
      pose.q[J.spine_03].premultiply(_q1);
    }

    // spine, forward kinematics in character space
    const R1 = _r[1].copy(R0).multiply(pose.q[J.spine_01]);
    const R2 = _r[2].copy(R1).multiply(pose.q[J.spine_02]);
    const p1 = _p[1].subVectors(rest[J.spine_01].wp, rest[J.pelvis].wp).applyQuaternion(R0).add(pPelvis);
    const p2 = _p[2].subVectors(rest[J.spine_02].wp, rest[J.spine_01].wp).applyQuaternion(R1).add(p1);
    const p3 = _p[3].subVectors(rest[J.spine_03].wp, rest[J.spine_02].wp).applyQuaternion(R2).add(p2);

    // ---- look
    const look = this._look;
    const face = this.face;
    const eyed = face.hasEyes;
    let yawT = 0, pitchT = 0;
    const headTarget = look.target && eyed && face.headPoint ? face.headPoint : look.target;
    if (headTarget) {
      const eyes = _v1.copy(p3).addScaledVector(AY, rest[J.head].wp.y - rest[J.spine_03].wp.y + 0.09 * this.scale);
      const d = toModel(headTarget, _v2).sub(eyes).applyQuaternion(_q1.copy(R2).invert());
      const flat = Math.hypot(d.x, d.z);
      if (flat > 1e-4 || Math.abs(d.y) > 1e-4) {
        yawT = clamp(Math.atan2(d.x, d.z), -75 * DEG, 75 * DEG);
        pitchT = clamp(Math.atan2(d.y, flat), -35 * DEG, 40 * DEG);
        if (eyed) {                                   // the eyes take what they can, the head the rest
          yawT = share(yawT, 10 * DEG, 0.85, 26 * DEG);
          pitchT = share(pitchT, 6 * DEG, 0.8, 14 * DEG);
        }
      }
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    look.weight += ((look.target ? 1 : 0) - look.weight) * k;
    look.yaw += (yawT - look.yaw) * k;
    look.pitch += (pitchT - look.pitch) * k;
    if (Math.abs(look.yaw) > 1e-4 || Math.abs(look.pitch) > 1e-4) {
      // the action's own head movement fades while he looks at something
      pose.q[J.head].slerp(_q1.identity(), 0.6 * look.weight);
      pose.q[J.spine_03].premultiply(euler(_q1, -look.pitch * 0.1, look.yaw * 0.15, 0));
      pose.q[J.neck_01].premultiply(euler(_q1, -look.pitch * 0.3, look.yaw * 0.3, 0));
      pose.q[J.head].premultiply(euler(_q1, -look.pitch * 0.6, look.yaw * 0.55, 0));
    }
    if (face.nod) pose.q[J.head].premultiply(euler(_q1, face.nod, 0, 0));      // stressed syllables
    const R3 = _r[3].copy(R2).multiply(pose.q[J.spine_03]);
    const pNeck = _p[4].subVectors(rest[J.neck_01].wp, rest[J.spine_03].wp).applyQuaternion(R3).add(p3);
    const Rn = _r[4].copy(R3).multiply(pose.q[J.neck_01]);
    const pHead = _p[5].subVectors(rest[J.head].wp, rest[J.neck_01].wp).applyQuaternion(Rn).add(pNeck);
    const Rh = _r[5].copy(Rn).multiply(pose.q[J.head]);
    this._headModel.set(0, (this.height - rest[J.head].wp.y) * 0.5, 0.03 * this.scale).applyQuaternion(Rh).add(pHead);
    if (eyed) this._aimEyes(Rh, pHead, dt);

    // ---- point (right arm)
    if (point.weight > 1e-3) {
      const arm = this.arms.r;
      const w = smooth(point.weight);
      const Rc = _r[6].copy(R3).multiply(pose.q[arm.clavicle]);
      const pClav = _v1.subVectors(rest[arm.clavicle].wp, rest[J.spine_03].wp).applyQuaternion(R3).add(p3);
      const shoulder = _v2.subVectors(arm.shoulder, rest[arm.clavicle].wp).applyQuaternion(Rc).add(pClav);
      const d = toModel(point.target, _v3).sub(shoulder);
      if (d.lengthSq() > 1e-6) {
        d.normalize().applyQuaternion(_q1.copy(Rc).invert());
        // keep the arm in front of the shoulder line and off the chest
        d.z = Math.max(d.z, -0.25);
        d.x = Math.min(d.x, 0.8);
        d.normalize();
        pose.q[arm.upper].slerp(_q1.setFromUnitVectors(arm.aim, d), w);
        pose.q[arm.lower].slerp(arm.straight, w);
        pose.q[arm.hand].slerp(_q1.identity(), w);
        const f = pose.fingersR;
        f[0] = lerp(f[0], 0.55, w); f[1] = lerp(f[1], 0.0, w); f[2] = lerp(f[2], 1.35, w);
        f[3] = lerp(f[3], 1.45, w); f[4] = lerp(f[4], 1.5, w);
      }
    }
  }

  /** Eyes: plan the gaze from where the eyes are this frame, then turn each eye bone at the gaze point. */
  _aimEyes(Rh, pHead, dt) {
    const face = this.face;
    const g = this.group;
    const hw = this.rest[J.head].wp;
    const eyePos = this.eyes.map((e, k) => (k ? _v6 : _v5).subVectors(e.wp, hw).applyQuaternion(Rh).add(pHead));
    const angles = [[0, 0], [0, 0]];
    const frozen = face.frozen && face.frozen.eyes;
    if (frozen) {
      angles[0][0] = angles[1][0] = frozen[0];
      angles[0][1] = angles[1][1] = frozen[1];
    } else {
      const gq = g.getWorldQuaternion(_q2);
      const mid = _v7.addVectors(eyePos[0], eyePos[1]).multiplyScalar(0.5).applyMatrix4(g.matrixWorld);
      const fwd = _v3.set(0, 0, 1).applyQuaternion(Rh).applyQuaternion(gq);
      const up = _v4.set(0, 1, 0).applyQuaternion(Rh).applyQuaternion(gq);
      face.plan(mid, fwd, up, dt);
      const P = toModelSpace(g, face.gazePoint(_v1), _v2);
      const inv = _q4.copy(Rh).invert();
      for (let k = 0; k < 2; k++) {
        const d = _v1.subVectors(P, eyePos[k]).applyQuaternion(inv);
        angles[k][0] = clamp(Math.atan2(d.x, d.z) / DEG, -27, 27);
        angles[k][1] = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)) / DEG, -20, 15);
      }
    }
    face.setEyes(angles[0], angles[1]);
    for (let k = 0; k < 2; k++) euler(this._eyeQ[k], -angles[k][1] * DEG, angles[k][0] * DEG, 0);
  }

  // ------------------------------------------------------------------------------------------------ to the bones

  _apply(pose) {
    const rest = this.rest;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i];
      b.bone.quaternion.copy(b.pRWinv).multiply(pose.q[i]).multiply(b.pRW).multiply(b.restQ);
    }
    const p = rest[J.pelvis];
    p.bone.position.copy(_v1.copy(pose.pelvis).applyQuaternion(p.pRWinv)).add(p.restPos);
    if (this.face.hasEyes) {
      for (let k = 0; k < 2; k++) {
        const e = this.eyes[k];
        e.bone.quaternion.copy(e.pRWinv).multiply(this._eyeQ[k]).multiply(e.pRW).multiply(e.restQ);
      }
    }
    for (const s of ['l', 'r']) {
      const curl = s === 'l' ? pose.fingersL : pose.fingersR;
      const hand = this.hands[s];
      for (let f = 0; f < 5; f++) {
        for (let k = 0; k < 3; k++) {
          const b = hand[f][k];
          _q1.setFromAxisAngle(b.axis, curl[f] * FINGER_JOINT_GAIN[k] * (f === 0 && k === 0 ? 0.5 : 1));
          b.bone.quaternion.copy(b.pRWinv).multiply(_q1).multiply(b.pRW).multiply(b.restQ);
        }
      }
    }
  }
}

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
/** Hair cards are alpha-tested (MASK): crisp, sorted by depth, but every card edge and the hairline end in a hard
 *  line. A second, blended pass of the same mesh draws only what the test threw away, fading out, after the opaque
 *  pass: soft hairline and tips, no sorting problems inside the hair. Returns the new material. */
function addSoftEdges(mesh) {
  const m = mesh.material.clone();
  m.name = mesh.material.name + '_soft';
  m.transparent = true;
  m.depthWrite = false;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>',
      'if ( diffuseColor.a >= alphaTest ) discard; diffuseColor.a = smoothstep( 0.04, alphaTest, diffuseColor.a ) * 0.85; if ( diffuseColor.a < 0.01 ) discard;');
  };
  m.customProgramCacheKey = () => 'hair-soft-edges';
  const soft = new THREE.SkinnedMesh(mesh.geometry, m);
  soft.name = mesh.name + '_soft';
  soft.bind(mesh.skeleton, mesh.bindMatrix);
  soft.frustumCulled = false;
  soft.castShadow = false;
  soft.receiveShadow = true;
  soft.renderOrder = 1;
  soft.position.copy(mesh.position);
  soft.quaternion.copy(mesh.quaternion);
  soft.scale.copy(mesh.scale);
  mesh.parent.add(soft);
  return m;
}
/** Beard shells (tools/characters/build_characters.py make_beard_shells): exported as alpha-tested layers whose cut-off
 *  picks the taller strands; drawn here as soft, blended layers that fade in around that cut-off, so the beard has
 *  soft edges up close and turns into a thin veil (not a hard sheet) where the texture is minified. */
function softShell(m) {
  m.transparent = true;
  m.depthWrite = false;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>',
      'diffuseColor.a = smoothstep( alphaTest - 0.05, alphaTest + 0.12, diffuseColor.a ); if ( diffuseColor.a < 0.01 ) discard;');
  };
  m.customProgramCacheKey = () => 'beard-shell';
}
/** World point -> the group's own space (the character's model space). */
function toModelSpace(group, world, out) { return out.copy(world).applyMatrix4(_m2.copy(group.matrixWorld).invert()); }
/** The part of a look angle the head takes: nothing within `free`, then a share `k`, and all beyond `lim`. */
function share(a, free, k, lim) {
  const m = Math.abs(a);
  return Math.sign(a) * Math.max(0, (m - free) * k, m - lim);
}
const _p = Array.from({ length: 6 }, () => new THREE.Vector3());
const _r = Array.from({ length: 7 }, () => new THREE.Quaternion());
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _a3 = new THREE.Vector3();
const _pl = Array.from({ length: 7 }, () => new THREE.Vector3());
const _lq = Array.from({ length: 6 }, () => new THREE.Quaternion());

const RELAXED = [0.25, 0.3, 0.38, 0.45, 0.5];
const OPEN = [0.05, 0.04, 0.05, 0.06, 0.08];
const FIST = [0.5, 1.0, 1.1, 1.15, 1.2];

// ---------------------------------------------------------------------------------------------------- standing

/** Weight shifts, breathing and small head movements; the base of talk as well. Returns what talk reuses. */
function idle(c, pose, t, amount = 1) {
  const sc = c.scale;
  const s = c.profile.seed;
  const sway = (Math.sin(t * 0.42 + s) * 0.022 + Math.sin(t * 0.97 + s * 2.1) * 0.006) * sc * amount;
  const breath = Math.sin(t * 1.55 + s);
  pose.pelvis.set(sway, -(0.012 + Math.abs(sway) * 0.25) * sc + breath * 0.0015, Math.sin(t * 0.31 + s) * 0.006 * sc);
  const roll = sway * 1.1 / sc;
  euler(pose.q[J.pelvis], 0.012, Math.sin(t * 0.23 + s) * 0.03, roll);
  const stoop = c.profile.stoop;
  euler(pose.q[J.spine_01], stoop, -Math.sin(t * 0.23 + s) * 0.012, -roll * 0.3);
  euler(pose.q[J.spine_02], stoop - breath * 0.008, 0, -roll * 0.3);
  euler(pose.q[J.spine_03], stoop - breath * 0.01, 0, -roll * 0.25);
  euler(pose.q[J.neck_01], -stoop * 1.2, 0, 0);
  euler(pose.q[J.head], -stoop * 1.2 + Math.sin(t * 0.51 + s * 3) * 0.025,
    Math.sin(t * 0.35 + s) * 0.06 + Math.sin(t * 0.83 + s * 1.7) * 0.03, Math.sin(t * 0.27 + s) * 0.015);
  euler(pose.q[J.clavicle_l], 0, 0, breath * 0.012);
  euler(pose.q[J.clavicle_r], 0, 0, -breath * 0.012);
  const drift = Math.sin(t * 0.42 + s + 0.6) * 0.025;
  c._arm(pose, 'l', { swing: 0.03 + drift, elbow: 0.24 + breath * 0.015 });
  c._arm(pose, 'r', { swing: 0.03 - drift, elbow: 0.24 + breath * 0.015 });
  c._fingers(pose, RELAXED);
  c._stand(pose);
}

/** Idle plus hand gestures and nods. */
function talk(c, pose, t) {
  idle(c, pose, t, 0.7);
  const s = c.profile.seed;
  const gr = envelope(t, 4.6, 0.6, 0.05 + s * 0.37);
  const gl = envelope(t, 6.3, 0.42, 0.45 + s * 0.21);
  const beat = Math.sin(t * 5.4 + s);
  const beat2 = Math.sin(t * 3.1 + s * 2);
  if (gr > 0.001) {
    c._arm(pose, 'r', {
      swing: lerp(0.03, 0.55 + beat2 * 0.08, gr), out: gr * 0.14,
      elbow: lerp(0.24, 1.35 + beat * 0.16, gr), twist: 0.45 + gr * 0.4,
    });
    pose.q[J.hand_r].setFromAxisAngle(AX, gr * (0.15 + beat * 0.12));
    for (let i = 0; i < 5; i++) pose.fingersR[i] = lerp(RELAXED[i], OPEN[i] + 0.12, gr);
  }
  if (gl > 0.001) {
    c._arm(pose, 'l', {
      swing: lerp(0.03, 0.42 + beat * 0.06, gl), out: gl * 0.12,
      elbow: lerp(0.24, 1.15 + beat2 * 0.18, gl), twist: 0.45 + gl * 0.35,
    });
    pose.q[J.hand_l].setFromAxisAngle(AX, gl * (0.1 + beat2 * 0.1));
    for (let i = 0; i < 5; i++) pose.fingersL[i] = lerp(RELAXED[i], OPEN[i] + 0.15, gl);
  }
  // nods come in little groups
  const nodding = envelope(t, 3.3, 0.35, s * 0.11) * (c.face && c.face.enabled ? 0.3 : 1);   // the face nods on stresses
  const nod = Math.max(0, Math.sin(t * 6.2 + s)) ** 2 * nodding;
  pose.q[J.head].premultiply(euler(_q1, 0.035 + nod * 0.13 + beat2 * 0.015, 0, 0));
  pose.q[J.neck_01].premultiply(euler(_q1, nod * 0.05, 0, 0));
  pose.q[J.spine_03].premultiply(euler(_q1, 0.02 + gr * 0.02, (gr - gl) * 0.05, 0));
}

/** Agitated: knees bent, leaning forward, arms out, quick looks left and right. */
function alarm(c, pose, t) {
  const sc = c.scale;
  const s = c.profile.seed;
  const jitter = Math.sin(t * 9.2 + s);
  const shift = Math.sin(t * 3.1 + s);
  pose.pelvis.set(shift * 0.02 * sc, (-0.055 + jitter * 0.008) * sc, 0.01 * sc);
  // quick looks: a new direction every 0.6 s, reached fast
  const step = t / 0.6 + s;
  const from = hash(Math.floor(step)) * 2 - 1;
  const to = hash(Math.floor(step) + 1) * 2 - 1;
  const lookYaw = lerp(from, to, smoothstep(0.0, 0.3, frac(step))) * 0.75;
  euler(pose.q[J.pelvis], 0.10, lookYaw * 0.12, shift * 0.02);
  euler(pose.q[J.spine_01], 0.05 + c.profile.stoop, lookYaw * 0.08, 0);
  const breath = c.face ? c.face.breath : 0.5;                    // fast breathing shows in the chest
  euler(pose.q[J.spine_02], 0.05 - breath * 0.02, lookYaw * 0.08, 0);
  euler(pose.q[J.spine_03], 0.05 + jitter * 0.01 - breath * 0.025, lookYaw * 0.1, 0);
  euler(pose.q[J.neck_01], -0.08, lookYaw * 0.25, 0);
  euler(pose.q[J.head], -0.10 + Math.sin(t * 4.3 + s) * 0.04, lookYaw * 0.5, 0);
  euler(pose.q[J.clavicle_l], 0, 0, 0.10 + breath * 0.035);
  euler(pose.q[J.clavicle_r], 0, 0, -0.10 - breath * 0.035);
  const wave = Math.sin(t * 7.3 + s);
  const wave2 = Math.sin(t * 6.1 + s + 1.3);
  c._armTowards(pose, 'l', _a1.set(0.52, -0.62 + wave * 0.08, 0.58), 1.45 + wave2 * 0.25);
  c._armTowards(pose, 'r', _a1.set(-0.52, -0.62 + wave2 * 0.08, 0.58), 1.45 + wave * 0.25);
  euler(pose.q[J.hand_l], -0.35 + wave * 0.12, 0, 0);
  euler(pose.q[J.hand_r], -0.35 + wave2 * 0.12, 0, 0);
  c._fingers(pose, OPEN);
  c._stand(pose, { half: 0.16 * sc, zl: 0.07 * sc, zr: -0.06 * sc });
}

// ---------------------------------------------------------------------------------------------------- gait

const WALK = {
  stance: 0.62, lead: 0.25, heelUntil: 0.09, flatUntil: 0.36, pitchOn: 14 * DEG, pitchOff: -36 * DEG,
  lift: 0.055, liftPow: 1, half: 0.07, sway: 0.022, yaw: 5.5 * DEG, roll: 3 * DEG, lean: 0.03, spineLean: 0.012,
  cap: 0.006, bob: 0, bobAt: 0, armSwing: 0.42, elbow: 0.22, elbowSwing: 0.28, curl: RELAXED,
};
const RUN = {
  stance: 0.36, lead: 0.14, heelUntil: 0.03, flatUntil: 0.14, pitchOn: 5 * DEG, pitchOff: -52 * DEG,
  lift: 0.30, liftPow: 0.72, half: 0.05, sway: 0.012, yaw: 9 * DEG, roll: 2.5 * DEG, lean: 0.16, spineLean: 0.045,
  cap: 0.055, bob: 0.035, bobAt: 0.43, armSwing: 0.80, elbow: 1.45, elbowSwing: 0.25, curl: FIST,
};

/** Ankle position and foot pitch of one foot at cycle position u (0 = its heel strike). */
function footAt(c, g, s, u, stride, out) {
  const leg = c.legs[s];
  const sc = c.scale;
  const k = clamp(c.gaitScale * 1.15, 0, 1);
  const x = (s === 'l' ? 1 : -1) * g.half * sc;
  const pOn = g.pitchOn * k;
  const pOff = g.pitchOff * k;
  const stance = (v, o) => {
    const z = g.lead * stride - v * stride;              // travels back at exactly the body's speed
    let pitch = 0;
    if (v < g.heelUntil) pitch = pOn * (1 - v / g.heelUntil);
    else if (v > g.flatUntil) pitch = pOff * smooth((v - g.flatUntil) / (g.stance - g.flatUntil));
    if (pitch >= 0) {                                    // rolls over the heel
      o.set(x, Math.sin(pitch) * leg.heel + Math.cos(pitch) * leg.ankle.y, z - leg.heel
        + Math.cos(pitch) * leg.heel - Math.sin(pitch) * leg.ankle.y);
    } else {                                             // rolls over the ball of the foot
      const a = -pitch;
      o.set(x, Math.cos(a) * leg.ankle.y + Math.sin(a) * leg.toe, z + leg.toe
        - Math.cos(a) * leg.toe + Math.sin(a) * leg.ankle.y);
    }
    return pitch;
  };
  if (u < g.stance) {
    out.pitch = stance(u, out.pos);
  } else {
    const w = (u - g.stance) / (1 - g.stance);
    const pitchOffNow = stance(g.stance, _a1);
    const pitchOnNow = stance(0, _a2);
    out.pos.set(x, lerp(_a1.y, _a2.y, w) + g.lift * sc * k * Math.sin(Math.PI * Math.pow(w, g.liftPow)),
      lerp(_a1.z, _a2.z, smooth(w)));
    out.pitch = lerp(pitchOffNow, pitchOnNow, smoothstep(0.12, 0.9, w));
  }
  return out;
}

const _footL = { pos: new THREE.Vector3(), pitch: 0 };
const _footR = { pos: new THREE.Vector3(), pitch: 0 };

function gait(c, pose, g, run) {
  const sc = c.scale;
  const k = c.gaitScale;
  const stride = c._stride(run);
  const ph = c.phase;
  const bounce = c.profile.bounce;
  const R = footAt(c, g, 'r', frac(ph / TAU), stride, _footR);
  const L = footAt(c, g, 'l', frac(ph / TAU + 0.5), stride, _footL);

  // hips: as high as both legs allow (that is the bob), a little towards the standing leg
  const sway = -g.sway * sc * Math.sin(ph) * Math.min(k, 1);
  const hipRest = c.legs.r.hip.y;
  let hipY = hipRest - g.cap * sc + g.bob * sc * bounce * Math.cos(2 * (ph - TAU * g.bobAt));
  for (const [leg, foot] of [[c.legs.r, R], [c.legs.l, L]]) {
    const reach = (leg.l1 + leg.l2) * 0.992;
    const dx = foot.pos.x - (leg.hip.x + sway);
    const dz = foot.pos.z - leg.hip.z;
    hipY = softMin(hipY, foot.pos.y + Math.sqrt(Math.max(reach * reach - dx * dx - dz * dz, 0.01)));
  }
  pose.pelvis.set(sway, hipY - hipRest, 0);
  const yaw = g.yaw * Math.min(k, 1) * Math.cos(ph);
  const roll = -g.roll * Math.min(k, 1) * Math.sin(ph);
  const stoop = c.profile.stoop * 0.6;
  euler(pose.q[J.pelvis], g.lean, yaw, roll);
  euler(pose.q[J.spine_01], g.spineLean + stoop, -yaw * 0.55, -roll * 0.4);
  euler(pose.q[J.spine_02], g.spineLean + stoop, -yaw * 0.55, -roll * 0.3);
  euler(pose.q[J.spine_03], g.spineLean + stoop, -yaw * 0.55, -roll * 0.2);
  euler(pose.q[J.neck_01], -g.lean * 0.5 - stoop, yaw * 0.3, 0);
  euler(pose.q[J.head], -g.lean * 0.5 - g.spineLean * 2 - stoop, yaw * 0.35, 0);

  c._leg(pose, 'r', R.pos, R.pitch);
  c._leg(pose, 'l', L.pos, L.pitch);

  // arms against the legs: left arm forward with the right leg
  const swing = g.armSwing * Math.min(k, 1) * Math.cos(ph + 0.15);
  c._arm(pose, 'l', { swing: swing + 0.04, elbow: g.elbow + g.elbowSwing * Math.max(0, swing), out: run ? 0.05 : 0 });
  c._arm(pose, 'r', { swing: -swing + 0.04, elbow: g.elbow + g.elbowSwing * Math.max(0, -swing), out: run ? 0.05 : 0 });
  c._fingers(pose, g.curl);
}

const ACTIONS = {
  idle: (c, pose, t) => idle(c, pose, t),
  talk,
  alarm,
  walk: (c, pose) => gait(c, pose, WALK, false),
  run: (c, pose) => gait(c, pose, RUN, true),
};

// ---------------------------------------------------------------------------------------------------- loading

/** Loads the three characters. manager: optional THREE.LoadingManager; base: another folder of GLBs (tests). */
export async function loadCharacters(manager, { base = ASSET_BASE, names = Object.keys(PROFILES) } = {}) {
  const loader = new GLTFLoader(manager || undefined);
  const noClips = (n) => (e) => { console.warn(`${n}: no motion clips (${e.message}); procedural motion`); return null; };
  const off = typeof location !== 'undefined' && new URLSearchParams(location.search).get('clips') === '0';   // A/B checks
  const [files, clipSets] = await Promise.all([
    Promise.all(names.map((n) => loader.loadAsync(new URL(`${n}.glb`, base).href))),
    Promise.all(names.map((n) => (off ? null : loadClipSet(n).catch(noClips(n))))),
  ]);
  const out = {};
  names.forEach((n, i) => { out[n] = new Character(n, files[i], clipSets[i]); });
  return out;
}
