// One first-person hand with its forearm, nails and hair (ported from the `world` project).
//
//   const hand = await createHand(camera, { side: 'right', manager });
//   const out = hand.update(dt, state);     // see `update` below
//
// The hand's root is a child of the camera; everything is in real metres; camera space is
// +x right, +y up, -z forward. Poses are a wrist position plus two directions: u (towards the
// fingers) and n (out of the palm).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HandAnimator } from './handAnim.js';
import { createHair } from './handHair.js';
import { createNails } from './handNails.js';
import { createSkinMaterials } from './handSkin.js';

const ASSETS = new URL('../../../assets/hands/', import.meta.url).href;
const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const SPREAD_SIGN = [-1, -0.2, 0.5, 1, 0];
const KINDS = ['prox', 'mid', 'dist'];
const THUMB_KINDS = ['tmeta', 'tprox', 'tdist'];

// Open / fist joint angles (radians) per joint kind.
const OPEN = { prox: 0.05, mid: 0.07, dist: 0.04, tmeta: 0.0, tprox: 0.05, tdist: 0.05 };
const FIST = { prox: 1.5, mid: 1.75, dist: 1.05, tmeta: 0.0, tprox: 0.75, tdist: 1.35 };
const THUMB_IN = 0.3, THUMB_IN_FIST = 0.95; // thumb swing toward the fingers, open and closed
// The relaxed hand (Lee & Jung 2010, standing, arm hanging; reference.md 6.3), knuckle / middle / end joint,
// degrees: index 27/26/10, middle 32/27/10, ring 24/32/8, little 29/34/12; thumb 43 at its knuckle, 9 at its end.
// A little under the measured values: the model's own rest pose is already slightly bent.
const DEG = Math.PI / 180;
export const REST_ANGLES = Float32Array.from([
  23, 22, 8, 28, 23, 8, 21, 28, 7, 25, 30, 10, 0, 30, 8,
].map((d) => d * DEG));
export const REST_SPREAD = Float32Array.from([-0.03, -0.006, 0.015, 0.03, 0.4]);   // fingers together, thumb a little in
const WALK = 1.9, RUN = 3.8;                // the player's walking and running speeds
const UPPER_ARM = 0.3, FOREARM_LEN = 0.27;  // shoulder -> elbow, elbow -> wrist (m); never stretched

const clamp = THREE.MathUtils.clamp;

// Möller–Trumbore, both sides; returns the distance along the ray or Infinity.
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _pv = new THREE.Vector3(), _qv = new THREE.Vector3(), _tv = new THREE.Vector3();
function rayTri(o, d, a, b, c) {
  _e1.subVectors(b, a); _e2.subVectors(c, a);
  _pv.crossVectors(d, _e2);
  const det = _e1.dot(_pv);
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  _tv.subVectors(o, a);
  const u = _tv.dot(_pv) * inv; if (u < -1e-6 || u > 1 + 1e-6) return Infinity;
  _qv.crossVectors(_tv, _e1);
  const v = d.dot(_qv) * inv; if (v < -1e-6 || u + v > 1 + 1e-6) return Infinity;
  const t = _e2.dot(_qv) * inv;
  return t > 0 ? t : Infinity;
}

// The generic hand's fingers are about a sixth too thin for an adult man's. At load, every finger vertex moves away
// from its finger's axis (radially only: lengths stay), fading to nothing at the knuckle row so the palm keeps its
// shape. Thumb less. Everything measured from the mesh afterwards (grip radii, nails, hair) sees the new girth.
const GIRTH = { finger: 0.15, thumb: 0.1, ramp: 0.012 };
function thickenFingers(skinned, L) {
  const g = skinned.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const bones = skinned.skeleton.bones;
  // each finger: its joints from the knuckle out (skinned local space), and which bones are its own
  const chains = [...FINGERS.map((f) => ({ k: GIRTH.finger, names: [`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`] })),
    { k: GIRTH.thumb, names: ['thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'] }];
  const owner = new Map();
  chains.forEach((c, ci) => {
    c.J = c.names.map(L);
    c.cum = [0];
    for (let i = 1; i < c.J.length; i++) c.cum.push(c.cum[i - 1] + c.J[i].distanceTo(c.J[i - 1]));
    for (const nm of c.names) { const b = bones.findIndex((x) => x.name === nm); if (b >= 0) owner.set(b, ci); }
  });
  const v = new THREE.Vector3(), a = new THREE.Vector3(), d = new THREE.Vector3(), c0 = new THREE.Vector3(), axisPt = new THREE.Vector3();
  const W = new Float32Array(chains.length);
  for (let i = 0; i < pos.count; i++) {
    W.fill(0);
    for (let k = 0; k < 4; k++) { const ci = owner.get(si.getComponent(i, k)); if (ci !== undefined) W[ci] += sw.getComponent(i, k); }
    let ci = 0;
    for (let j = 1; j < W.length; j++) if (W[j] > W[ci]) ci = j;
    if (W[ci] < 0.05) continue;
    const c = chains[ci];
    v.fromBufferAttribute(pos, i);
    // nearest point on the finger's axis; past the last joint the axis carries straight on (the tip keeps its length)
    let best = Infinity, along = 0;
    for (let s = 0; s < c.J.length - 1; s++) {
      d.subVectors(c.J[s + 1], c.J[s]);
      const len = d.length();
      d.multiplyScalar(1 / len);
      let t = a.subVectors(v, c.J[s]).dot(d);
      if (s > 0) t = Math.max(t, 0);
      if (s < c.J.length - 2) t = Math.min(t, len);
      c0.copy(c.J[s]).addScaledVector(d, t);
      const dist = v.distanceTo(c0);
      if (dist < best) { best = dist; along = c.cum[s] + t; axisPt.copy(c0); }
    }
    const ramp = THREE.MathUtils.smoothstep(along, 0, GIRTH.ramp) * Math.min(1, W[ci] / 0.6);
    if (ramp <= 0) continue;
    v.sub(axisPt).multiplyScalar(1 + c.k * ramp).add(axisPt);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
}

export async function createHand(camera, { side = 'right', manager } = {}) {
  const h = side === 'right' ? 1 : -1;
  const gltf = await new GLTFLoader(manager).loadAsync(`${ASSETS}${side}-hand.glb`);
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const bone = (n) => model.getObjectByName(n);
  const wpos = (n) => bone(n).getWorldPosition(new THREE.Vector3());

  // u = toward fingers, n = out of the palm, thumbDir = toward the thumb side.
  const wrist = wpos('wrist');
  const u = wpos('middle-finger-phalanx-proximal').sub(wrist).normalize();
  const knuckleLine = wpos('pinky-finger-phalanx-proximal').sub(wpos('index-finger-phalanx-proximal'));
  const thumbDir = knuckleLine.clone().negate().normalize();
  const n = new THREE.Vector3().crossVectors(thumbDir, u).multiplyScalar(h).normalize();
  thumbDir.addScaledVector(u, -thumbDir.dot(u)).normalize();
  const vB = new THREE.Vector3().crossVectors(u, n).normalize();
  const modelBasisT = new THREE.Matrix4().makeBasis(vB, u, n).transpose();

  // The model's bones are all siblings under the armature, so each finger is posed with
  // forward kinematics: every joint rotation carries the rest of the finger with it.
  const armature = bone('wrist').parent;
  const armQinv = armature.getWorldQuaternion(new THREE.Quaternion()).invert();
  const armToModel = armature.matrixWorld.clone();        // the model sits at the origin while loading
  const nA = n.clone().applyQuaternion(armQinv);
  const chains3 = [
    ...FINGERS.map((f, i) => ({ finger: f, idx: i, kinds: KINDS, names: [`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`] })),
    { finger: 'thumb', idx: 4, kinds: THUMB_KINDS, names: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'] },
  ];
  for (const c of chains3) {
    c.nodes = c.names.map(bone);
    c.restPos = c.nodes.map((b) => b.position.clone());
    c.restQ = c.nodes.map((b) => b.quaternion.clone());
    c.axes = [0, 1, 2].map((k) => new THREE.Vector3().crossVectors(c.restPos[k + 1].clone().sub(c.restPos[k]).normalize(), nA).normalize());
    c.pts = [0, 1, 2, 3].map(() => new THREE.Vector3());
  }
  let skinned = null;
  model.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
  const toLocal = skinned.matrixWorld.clone().invert();
  const L = (name) => wpos(name).applyMatrix4(toLocal);
  thickenFingers(skinned, L);
  const LD = (vec) => vec.clone().transformDirection(toLocal);
  const chains = chains3.map((c) => c.names);
  const detailUniforms = {
    uJ: { value: chains.flat().map(L) },
    uHV: { value: LD(thumbDir) }, uHU: { value: LD(u) }, uHN: { value: LD(n) }, uWrist: { value: L('wrist') },
    uPalmLen: { value: wpos('middle-finger-phalanx-proximal').distanceTo(wrist) },
    uPalmW: { value: wpos('index-finger-phalanx-proximal').distanceTo(wpos('pinky-finger-phalanx-proximal')) },
  };
  const skinMats = createSkinMaterials({ detailUniforms, side, manager });
  skinned.material = skinMats.hand;
  skinned.frustumCulled = false;

  // ---- rest-pose surface queries (model space), for fitting grips and measuring the fingers
  const restTris = [];
  {
    const pos = skinned.geometry.attributes.position, index = skinned.geometry.index;
    const v = [];
    for (let i = 0; i < pos.count; i++) v.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(skinned.matrixWorld));
    const nT = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < nT; t++) restTris.push(v[index ? index.getX(t * 3) : t * 3], v[index ? index.getX(t * 3 + 1) : t * 3 + 1], v[index ? index.getX(t * 3 + 2) : t * 3 + 2]);
  }
  /** Distance from `origin` along `dir` (unit) to the rest-pose skin, model space; Infinity if it misses. */
  const raycastRest = (origin, dir) => {
    let best = Infinity;
    for (let k = 0; k < restTris.length; k += 3) { const d = rayTri(origin, dir, restTris[k], restTris[k + 1], restTris[k + 2]); if (d < best) best = d; }
    return best;
  };
  const jointRest = chains3.map((c) => c.restPos.map((p) => p.clone().applyMatrix4(armToModel)));
  // Flesh radius of every finger segment, measured across the finger at its middle.
  const radii = jointRest.map((J, ci) => [0, 1, 2].map((k) => {
    const mid = J[k].clone().lerp(J[k + 1], 0.5), d = J[k + 1].clone().sub(J[k]).normalize();
    const lat = new THREE.Vector3().crossVectors(d, n).normalize(), up = new THREE.Vector3().crossVectors(lat, d).normalize();
    const hits = [lat, lat.clone().negate(), up, up.clone().negate()].map((dir) => raycastRest(mid, dir)).filter((x) => x < 0.02);
    const fallback = ci === 4 ? 0.0095 : 0.0085 - 0.0008 * k;
    if (!hits.length) return fallback;
    hits.sort((a, b) => a - b);
    return clamp(hits[hits.length >> 1], 0.005, 0.013);
  }));

  // Forearm out of the wrist toward the elbow, built at the length it is drawn (no scaling along it, so the skin
  // detail and hair keep their size): from 1 cm into the hand to 2.2 cm past the elbow point. Its wrist end has the
  // hand's own section there (52.9 x 36.7 mm), flatter (0.69) easing to the forearm's 0.74 over 4 cm.
  const ARM_Y0 = -0.006, ELBOW_Y = FOREARM_LEN + 0.004, ARM_Y1 = ELBOW_Y + 0.022;
  const prof = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, y = ARM_Y0 + t * (ARM_Y1 - ARM_Y0);
    prof.push(new THREE.Vector2(0.0262 + 0.0013 * THREE.MathUtils.smoothstep(t, 0, 0.15) + 0.012 * Math.pow(t, 0.9) + 0.004 * Math.sin(Math.PI * Math.min(1, t * 1.4)), y));
  }
  const armGeo = new THREE.LatheGeometry(prof, 40);
  {
    // a squash in z per ring; normals go with it (inverse transpose), so the lathe's seam stays smooth
    const ap = armGeo.attributes.position, an = armGeo.attributes.normal;
    for (let i = 0; i < ap.count; i++) {
      const k = 0.69 + 0.05 * THREE.MathUtils.smoothstep(ap.getY(i) - ARM_Y0, 0, 0.04);
      ap.setZ(i, ap.getZ(i) * k);
      const nx = an.getX(i), ny = an.getY(i), nz = an.getZ(i) / k, l = Math.hypot(nx, ny, nz);
      an.setXYZ(i, nx / l, ny / l, nz / l);
    }
  }
  const arm = new THREE.Mesh(armGeo, skinMats.arm);
  arm.frustumCulled = false;
  // Stored as position/rotation (not a frozen matrix) so later matrix updates keep it in place.
  new THREE.Matrix4().makeBasis(vB, u.clone().negate(), new THREE.Vector3().crossVectors(vB, u.clone().negate()))
    .setPosition(wrist.clone().addScaledVector(u, 0.004)).decompose(arm.position, arm.quaternion, arm.scale);
  model.add(arm);
  const nails = createNails({ model, skinned, side, n: n.clone(), manager });
  const hair = createHair({ model, skinned, arm, side, u: u.clone(), n: n.clone(), wristModel: wrist.clone() });
  const prevTip = new THREE.Vector3();

  // Where a held tool sits: inside the curled fingers, handle across the palm.
  const gripLocal = wrist.clone().addScaledVector(u, 0.088).addScaledVector(n, 0.026);

  const root = new THREE.Group();
  root.name = `${side}-hand`;
  root.add(model);
  camera.add(root);

  // Camera-space pose from wrist position, finger direction and palm normal.
  const makePose = (pos, ut, nt) => {
    ut = ut.clone().normalize();
    nt = nt.clone().addScaledVector(ut, -nt.dot(ut)).normalize();
    const vt = new THREE.Vector3().crossVectors(ut, nt).normalize();
    const R = new THREE.Matrix4().makeBasis(vt, ut, nt).multiply(modelBasisT);
    return { pos: pos.clone(), q: new THREE.Quaternion().setFromRotationMatrix(R) };
  };
  // Static poses are written for the right hand; the left hand mirrors them.
  const pose = (p, uu, nn) => makePose(new THREE.Vector3(p[0] * h, p[1], p[2]), new THREE.Vector3(uu[0] * h, uu[1], uu[2]), new THREE.Vector3(nn[0] * h, nn[1], nn[2]));
  const POSES = {
    raise: pose([0.25, -0.3, -0.36], [-0.25, 0.75, -0.6], [-0.2, 0.3, -0.93]),
    down: null, run: null, reach: null, pose: null,
  };
  const w = { raise: 1, down: 0, run: 0, reach: 0, pose: 0 };

  // Body-space pose (feet at origin, -z forward) turned into camera space.
  const camInv = new THREE.Matrix4();
  const bodyPose = (bodyM, p, ut, nt) => {
    const pw = p.clone().applyMatrix4(bodyM).applyMatrix4(camInv);
    const uw = ut.clone().transformDirection(bodyM).transformDirection(camInv);
    const nw = nt.clone().transformDirection(bodyM).transformDirection(camInv);
    return makePose(pw, uw, nw);
  };
  // Body-space arm (hands down / running): a real two-bone arm with fixed lengths, posed by angles.
  const shoulder = new THREE.Vector3(0.2 * h, 1.43, 0.0);
  const UPPER = UPPER_ARM, FORE = FOREARM_LEN;
  const armP = { th: 0, ab: 0, el: 0, inw: 0, roll: 0, ext: 0 };
  const upDir = new THREE.Vector3(), foDir = new THREE.Vector3(), elB = new THREE.Vector3(), wrB = new THREE.Vector3(), nB = new THREE.Vector3(), hU = new THREE.Vector3();
  // th: upper-arm swing (+ forward), ab: out to the side, el: elbow bend, inw: forearm toward the midline,
  // roll: palm from facing the thigh (0) toward facing down, ext: wrist bent back (the relaxed hand: 16 degrees).
  // Angles in radians.
  const armFK = (bodyM, p) => {
    const ca = Math.cos(p.ab), sa = Math.sin(p.ab);
    upDir.set(h * sa, -Math.cos(p.th) * ca, -Math.sin(p.th) * ca);
    elB.copy(shoulder).addScaledVector(upDir, UPPER);
    const f = p.th + p.el, ci = Math.cos(p.inw);
    foDir.set(-h * Math.sin(p.inw), -Math.cos(f) * ci, -Math.sin(f) * ci);
    wrB.copy(elB).addScaledVector(foDir, FORE);
    nB.set(-h * Math.cos(p.roll), -Math.sin(p.roll), 0.15);
    nB.addScaledVector(foDir, -nB.dot(foDir)).normalize();
    // the hand bends back (towards the back of the hand, away from the palm) and a little towards the little finger
    hU.copy(foDir).multiplyScalar(Math.cos(p.ext)).addScaledVector(nB, -Math.sin(p.ext));
    hU.addScaledVector(tmpV2.crossVectors(nB, foDir).multiplyScalar(h), 0.11).normalize();
    elC.copy(elB).applyMatrix4(bodyM).applyMatrix4(camInv);
    return bodyPose(bodyM, wrB, hU, nB);
  };
  // The arm behind the hand: two-bone IK from the shoulder to the wrist (upper arm of fixed length, the
  // forearm stretching a little when the hand is out of reach), the elbow hanging down and out. The hand
  // keeps the orientation its pose asks for and the wrist bends to meet the forearm: the wrist bone
  // carries the skin of the wrist with the forearm. On the body-space arm the elbow is the arm's own,
  // so the wrist comes out straight there.
  const elC = new THREE.Vector3(), shC = new THREE.Vector3(), ikD = new THREE.Vector3(), ikP = new THREE.Vector3(), ikE = new THREE.Vector3();
  const poleBody = new THREE.Vector3(0.36 * h, 0.75, 0.3), poleC = new THREE.Vector3();
  const wristBone = bone('wrist'), wristRestQ = wristBone.quaternion.clone();
  const armRestQ = arm.quaternion.clone(), armRestOff = arm.position.clone().sub(wrist);
  const foreRest = u.clone().negate(), wristQ = new THREE.Quaternion(), qInv = new THREE.Quaternion(), armQ = armQinv.clone().invert();
  const WRIST_MAX = 1.45;
  const elbowCam = new THREE.Vector3(), wristDir = new THREE.Vector3();
  // The upper arm is UPPER long and the forearm FORE long at every frame; a wrist asked to go further than the
  // arm reaches is held back (see `update`), so the elbow is always the joint the body's upper arm is drawn to.
  // `pole` pulls the elbow towards a camera-space point; `poleMix` blends towards the body-space arm's own elbow.
  const solveArm = (P, Q, poleMix, pole) => {
    const Lf = FORE;
    ikD.copy(P).sub(shC);
    const dist = Math.max(ikD.length(), 1e-4);
    ikD.multiplyScalar(1 / dist);
    const dd = clamp(dist, Math.abs(UPPER - Lf) + 0.01, UPPER + Lf - 0.001);
    const a = (UPPER * UPPER - Lf * Lf + dd * dd) / (2 * dd), r = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
    ikP.copy(pole || poleC).sub(shC);
    if (poleMix > 1e-4) ikP.lerp(ikE.copy(elC).sub(shC), poleMix);
    ikP.addScaledVector(ikD, -ikP.dot(ikD));
    if (ikP.lengthSq() < 1e-8) ikP.set(0, -1, 0);
    ikP.normalize();
    elbowCam.copy(shC).addScaledVector(ikD, a).addScaledVector(ikP, r);           // the elbow
    ikE.copy(elbowCam).sub(P).normalize().applyQuaternion(qInv.copy(Q).invert()); // wrist -> elbow, in model space
    wristQ.setFromUnitVectors(foreRest, ikE);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(wristQ.w)));
    if (ang > WRIST_MAX) wristQ.slerp(qI.identity(), 1 - WRIST_MAX / ang);
    arm.quaternion.copy(wristQ).multiply(armRestQ);
    arm.position.copy(armRestOff).applyQuaternion(wristQ).add(wrist);
    arm.scale.y = (Lf + 0.004) / ELBOW_Y;
    wristBone.quaternion.copy(armQinv).multiply(wristQ).multiply(armQ).multiply(wristRestQ);
  };
  const qI = new THREE.Quaternion();
  // Furthest the wrist may be from the shoulder: 0.94 of the arm. The hold-back starts softly at 0.86.
  const REACH_SOFT = 0.86 * (UPPER + FORE), REACH_MAX = 0.94 * (UPPER + FORE);
  const holdBack = (P) => {
    wristDir.copy(P).sub(shC);
    const d = wristDir.length();
    if (d <= REACH_SOFT) return;
    const span = REACH_MAX - REACH_SOFT, k = REACH_SOFT + span * Math.tanh((d - REACH_SOFT) / span);
    P.copy(shC).addScaledVector(wristDir, k / d);
  };

  const cur = { pos: POSES.raise.pos.clone(), q: POSES.raise.q.clone() };
  const tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const out = {
    tip: new THREE.Vector3(), elbow: new THREE.Vector3(), grip: new THREE.Vector3(), wristCam: new THREE.Vector3(), sway: new THREE.Vector3(), shoulderCam: shC, tension: 0, walkPhase: 0,
    wristQ: new THREE.Quaternion(), elbowCam, shoulder: new THREE.Vector3(),
    wristW: new THREE.Vector3(), wristQW: new THREE.Quaternion(),          // the same wrist pose in the world
    downW: { pos: new THREE.Vector3(), q: new THREE.Quaternion() },         // this frame's hanging pose in the world
    angles: new Float32Array(15), spread: new Float32Array(5),          // the finger pose just applied
    down: null,                                                           // this frame's hanging-arm pose { pos, q } (camera space)
  };
  let first = true;
  const anim = new HandAnimator(side);
  const finalP = new THREE.Vector3(), finalQ = new THREE.Quaternion();
  const fkQ = new THREE.Quaternion(), fkP = new THREE.Vector3(), fkD = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  const ang = new Float32Array(15), spr = new Float32Array(5), camWQ = new THREE.Quaternion();

  // Forward kinematics of one finger. `a` holds 3 joint angles at offset o; `spread` turns the whole
  // finger about the palm normal. With apply = true the bones are posed; c.pts receives the four
  // joint positions in armature space either way.
  function fkChain(c, a, o, spread, apply) {
    fkP.copy(c.restPos[0]);
    for (let k = 0; k < 3; k++) {
      qa.setFromAxisAngle(c.axes[k], a[o + k]);
      if (k === 0) { qb.setFromAxisAngle(nA, spread * h); fkQ.copy(qb).multiply(qa); } else fkQ.multiply(qa);
      c.pts[k].copy(fkP);
      if (apply) { c.nodes[k].position.copy(fkP); c.nodes[k].quaternion.copy(fkQ).multiply(c.restQ[k]); }
      fkD.copy(c.restPos[k + 1]).sub(c.restPos[k]).applyQuaternion(fkQ);
      fkP.add(fkD);
    }
    c.pts[3].copy(fkP);
    if (apply) { c.nodes[3].position.copy(fkP); c.nodes[3].quaternion.copy(fkQ).multiply(c.restQ[3]); }
  }

  /**
   * Closes the fingers on an obstacle, one joint after another from the knuckle outwards, each until
   * the finger touches (or the joint reaches its limit).
   *   sdf(pointModel) -> signed distance in metres to the thing being held (hand model space, rest pose)
   *   opts.start / opts.limit: [[prox, mid, dist] x 5 fingers] (index, middle, ring, pinky, thumb)
   *   opts.thumbIn: [start, limit] swing of the thumb across the palm; opts.spread: per-finger spread
   *   opts.sink: how far the flesh may press into the obstacle (m)
   *   opts.attract(pointModel) -> distance to what the fingertips should end up near (optional)
   * Returns { angles: Float32Array(15), spread: Float32Array(5) } for update()'s `grip`.
   */
  function solveGrasp(sdf, opts = {}) {
    const start = opts.start || [[0.25, 0.1, 0.1], [0.25, 0.1, 0.1], [0.25, 0.1, 0.1], [0.25, 0.1, 0.1], [0, 0.05, 0.05]];
    const limit = opts.limit || [[1.5, 1.75, 1.2], [1.5, 1.75, 1.2], [1.5, 1.75, 1.2], [1.5, 1.75, 1.2], [0, 0.9, 1.3]];
    const sink = opts.sink ?? 0.0015, step = 0.02;
    const A = new Float32Array(15), S = new Float32Array(5);
    const p = new THREE.Vector3();
    const hits = (c, from) => {
      for (let k = from; k < 3; k++) {
        const r = radii[c.idx][k] - sink, end = k === 2 ? 1.3 : 1.0;
        for (let t = k === from ? 0.3 : 0.1; t <= end + 1e-6; t += 0.15) {
          p.copy(c.pts[k]).lerp(c.pts[k + 1], t).applyMatrix4(armToModel);
          if (sdf(p) < r) return true;
        }
      }
      return false;
    };
    // Two ways to close a finger: joint after joint (wraps round a bar it can reach), or all joints
    // together first (curls up beside one it cannot). With opts.attract the one whose fingertip ends
    // nearer to what should be held wins.
    const close = (c, together) => {
      const o = c.idx * 3;
      for (let k = 0; k < 3; k++) A[o + k] = start[c.idx][k];
      S[c.idx] = opts.spread ? opts.spread[c.idx] : 0;
      if (c.idx === 4) {
        // the thumb first swings across the palm, then curls
        const [t0, t1] = opts.thumbIn || [THUMB_IN, THUMB_IN_FIST];
        S[4] = t0;
        for (let s = t0; s <= t1; s += step) {
          fkChain(c, A, o, s, false);
          if (hits(c, 0)) break;
          S[4] = s;
        }
      }
      if (together) {
        for (let s = 0.025; s <= 1.0001; s += 0.025) {
          for (let k = 0; k < 3; k++) A[o + k] = lerp3(start[c.idx][k], limit[c.idx][k], s);
          fkChain(c, A, o, S[c.idx], false);
          if (hits(c, 0)) { for (let k = 0; k < 3; k++) A[o + k] = lerp3(start[c.idx][k], limit[c.idx][k], s - 0.025); break; }
        }
      }
      for (let k = 0; k < 3; k++) {
        let a = A[o + k];
        while (a + step <= limit[c.idx][k]) {
          A[o + k] = a + step;
          fkChain(c, A, o, S[c.idx], false);
          if (hits(c, k)) { A[o + k] = a; break; }
          a += step;
        }
      }
      if (!opts.attract) return 0;
      fkChain(c, A, o, S[c.idx], false);
      return opts.attract(p.copy(c.pts[2]).lerp(c.pts[3], 0.5).applyMatrix4(armToModel)) + 0.5 * opts.attract(p.copy(c.pts[3]).applyMatrix4(armToModel));
    };
    const lerp3 = (a, b, t) => a + (b - a) * t;
    for (const c of chains3) {
      const o = c.idx * 3;
      const s1 = close(c, false);
      if (!opts.attract || c.idx === 4) continue;
      const keep = [A[o], A[o + 1], A[o + 2]];
      if (close(c, true) >= s1) { A[o] = keep[0]; A[o + 1] = keep[1]; A[o + 2] = keep[2]; }
    }
    return { angles: A, spread: S };
  }

  /**
   * Advances the hand one frame.
   *   s.target   'down' | 'run' (on the body's arm) | 'pose' | 'raise' (old idle pose, unused) | 'reach'
   *   s.pose     { pos, q } camera-space wrist pose for target 'pose' (from makePose)
   *   s.reachPos camera-space point for target 'reach'
   *   s.fist     0..1
   *   s.grip     { angles, spread, w } explicit finger joint angles (from solveGrasp), blended in by w
   *   s.life     0..1 how much of the idle sway / swing / turn lag to apply (default 1)
   *   s.rate, s.lag  blend speeds (1/s) towards the target pose (very large: follow the pose exactly)
   *   s.body     the body group; s.speed, s.onGround, s.bobPhase, s.yawVel, s.pitchVel from the player
   *   s.offset   camera-space vector added to the wrist (shake, or another hand's sway)
   *   s.pole     camera-space point the elbow is pulled towards (default: low, out and behind the shoulder)
   *   s.downMix  0..1 blends the result towards this frame's hanging arm (a way back that lands on it exactly)
   *   s.swing    0..1 scales the walking swing of the hanging arm (default 1; a loaded arm swings little)
   * Returns { tip, elbow, grip (world space), wristCam, wristQ, elbowCam, sway (camera space), angles, spread,
   * down (this frame's hanging pose), tension, walkPhase }.
   */
  function update(dt, s) {
    camera.updateMatrixWorld();
    camInv.copy(camera.matrixWorld).invert();
    const run = clamp((s.speed - 2.3) / 1.3, 0, 1);
    const walk = Math.min(s.speed / WALK, 1);
    if (s.body) shC.copy(shoulder).applyMatrix4(s.body.matrixWorld).applyMatrix4(camInv);
    if (s.reachPos) {
      const dir = tmpV.copy(s.reachPos).normalize();
      const down = tmpV2.set(0, -1, 0).transformDirection(camInv);
      POSES.reach = makePose(s.reachPos.clone().addScaledVector(dir, -0.09).addScaledVector(down, -0.03), dir, down);
    }
    if (s.pose) POSES.pose = s.pose;
    let target = s.target;
    if (target !== 'down' && target !== 'run' && !POSES[target]) target = 'raise';
    if (!s.body && (target === 'down' || target === 'run')) target = 'raise';
    const k = first ? 1 : 1 - Math.exp(-dt * (s.rate ?? (target === 'reach' ? 9 : 5)));
    for (const key in w) w[key] += ((key === target ? 1 : 0) - w[key]) * k;
    const wb = w.down + w.run; // share of the body-space arm
    const downMix = clamp(s.downMix ?? 0, 0, 1);

    // Body-space arm, every frame (it is also where a hand coming back to the side lands): down <-> run blend
    // in joint angles, so the arm keeps its lengths in between. Arms swing opposite to the leg on the same side
    // (+1 = this arm forward).
    if (s.body) {
      const swing = -Math.sin(s.bobPhase) * h * (s.swing ?? 1);
      const m = wb > 1e-4 ? w.run / wb : target === 'run' ? 1 : 0;
      const a = swing * (0.32 * walk + 0.25 * run);
      const pump = swing * 0.5 * Math.min(1, s.speed / RUN);
      const fwd = Math.max(0, swing);
      // down: hanging, a little out from the hip, elbow softly bent (more on the forward swing), wrist 16 degrees back
      // run: elbow at ~85 degrees, hands from the hip (back) to the chest (front), crossing a little inward
      armP.th = a + (pump - 0.08 - a) * m;
      armP.ab = 0.14 + (0.13 - 0.14) * m;
      armP.el = 0.2 + 0.35 * Math.max(0, a) + (1.5 + 0.22 * swing - 0.2 - 0.35 * Math.max(0, a)) * m;
      armP.inw = 0.03 + (0.06 + 0.24 * fwd - 0.03) * m;
      armP.roll = 0.25 * m;
      armP.ext = 0.28 * (1 - m);
      POSES.down = POSES.run = armFK(s.body.matrixWorld, armP);
      out.down = POSES.down;
    }

    // Camera-space poses: blended and smoothed by a lag.
    let acc = 0;
    tmpP.set(0, 0, 0);
    for (const key in w) {
      if (key === 'down' || key === 'run' || w[key] < 1e-4 || !POSES[key]) continue;
      tmpP.addScaledVector(POSES[key].pos, w[key]);
      if (acc === 0) tmpQ.copy(POSES[key].q); else tmpQ.slerp(POSES[key].q, w[key] / (acc + w[key]));
      acc += w[key];
    }
    const wantFist = typeof s.fist === 'number' ? s.fist : s.fist ? 1 : 0;
    const lag = first ? 1 : 1 - Math.exp(-dt * (s.lag ?? (target === 'reach' ? 14 : 12)));
    if (acc > 1e-3) {
      tmpP.multiplyScalar(1 / acc);
      cur.pos.lerp(tmpP, lag);
      cur.q.slerp(tmpQ, lag);
    } else if (POSES.run) {
      // Fully on the body: the camera-space part follows the arm so the way back starts from here.
      cur.pos.copy(POSES.run.pos); cur.q.copy(POSES.run.q);
    }
    // The body-space arm is not lagged: it moves rigidly with the body, in step with the legs.
    // The living motion (swing, breathing, turn inertia, footstep bounce, fist tremble) comes from the
    // HandAnimator on top of the camera-space part only.
    const life = s.life ?? 1;
    const onBody = Math.max(wb, downMix);
    const inView = (1 - onBody) * life;
    const ao = anim.update(dt, { speed: s.speed, bobPhase: s.bobPhase, onGround: s.onGround ?? true, yawVel: s.yawVel, pitchVel: s.pitchVel, fistTarget: wantFist, inView });
    finalP.copy(cur.pos);
    finalQ.copy(cur.q);
    if (wb > 1e-4 && POSES.run) { finalP.lerp(POSES.run.pos, wb); finalQ.slerp(POSES.run.q, wb); }
    finalP.add(ao.pos);
    finalQ.premultiply(ao.rot);
    out.sway.copy(ao.pos);
    if (s.offset) finalP.add(s.offset);
    if (downMix > 1e-4 && POSES.down) { finalP.lerp(POSES.down.pos, downMix); finalQ.slerp(POSES.down.q, downMix); }

    first = false;
    if (s.body) {
      holdBack(finalP);
      poleC.copy(poleBody).applyMatrix4(s.body.matrixWorld).applyMatrix4(camInv);
      solveArm(finalP, finalQ, POSES.run ? onBody : 0, s.pole || null);
    }
    root.quaternion.copy(finalQ);
    root.position.copy(finalP).sub(tmpV.copy(wrist).applyQuaternion(finalQ));
    out.tension = ao.tension;
    skinMats.uniforms.uTension.value = Math.max(ao.tension, s.tension ?? 0);
    out.walkPhase = ao.walkPhase;

    // Fingers: the animator's curl from the relaxed hand towards a fist, overridden by an explicit grip.
    const g = s.grip, gw = g ? clamp(g.w ?? 1, 0, 1) : 0;
    for (const c of chains3) {
      const fist = ao.curl[c.idx], open = 1 - fist, o = c.idx * 3;
      for (let k2 = 0; k2 < 3; k2++) {
        const kind = c.kinds[k2];
        const stagger = k2 < 2 && c.idx < 4 ? 0.05 * c.idx * fist : 0;
        ang[o + k2] = REST_ANGLES[o + k2] * open + FIST[kind] * fist + stagger;
      }
      spr[c.idx] = c.idx === 4 ? REST_SPREAD[4] * open + THUMB_IN_FIST * fist : (REST_SPREAD[c.idx] + 0.03 * ao.spread * SPREAD_SIGN[c.idx]) * open;
      if (gw > 0) {
        for (let k2 = 0; k2 < 3; k2++) ang[o + k2] += (g.angles[o + k2] - ang[o + k2]) * gw;
        spr[c.idx] += (g.spread[c.idx] - spr[c.idx]) * gw;
      }
      fkChain(c, ang, o, spr[c.idx], true);
    }
    out.angles.set(ang);
    out.spread.set(spr);
    if (skinMats.uniforms.uBend) skinMats.uniforms.uBend.value.set(ang);   // skin folds follow the finger bends
    root.updateMatrixWorld(true);
    chains3[1].nodes[3].getWorldPosition(out.tip);
    if (hair) {
      if (dt > 0) hair.uniforms.uHandVel.value.copy(out.tip).sub(prevTip).divideScalar(dt);
      prevTip.copy(out.tip);
      hair.update(dt);
    }
    // the elbow the body's upper arm is drawn to: the solver's own, so the upper arm keeps its length
    out.elbow.copy(elbowCam).applyMatrix4(camera.matrixWorld);
    out.shoulder.copy(shC).applyMatrix4(camera.matrixWorld);
    out.grip.copy(gripLocal).applyMatrix4(model.matrixWorld);
    out.wristCam.copy(finalP);
    out.wristQ.copy(finalQ);
    // world-space copies: a camera that turns next frame does not change where the hand was
    camera.getWorldQuaternion(camWQ);
    out.wristW.copy(finalP).applyMatrix4(camera.matrixWorld);
    out.wristQW.copy(camWQ).multiply(finalQ);
    if (POSES.down) { out.downW.pos.copy(POSES.down.pos).applyMatrix4(camera.matrixWorld); out.downW.q.copy(camWQ).multiply(POSES.down.q); }
    return out;
  }

  const materials = [skinMats.hand, skinMats.arm, ...nails.materials];
  return {
    update, root, model, side, hair, nails, skin: skinMats, materials, makePose, solveGrasp,
    /** Rest-pose measurements in the model's space (what `solveGrasp` and grip fitting work in). */
    rest: { wrist: wrist.clone(), u: u.clone(), n: n.clone(), vB: vB.clone(), thumbDir: thumbDir.clone(), knuckleLine: knuckleLine.clone(), joints: jointRest, radii, raycast: raycastRest },
    /** Fingertip positions (model space, index..thumb) for explicit joint angles, as in update()'s `grip`. */
    fkTips(grip) {
      return chains3.map((c) => { fkChain(c, grip.angles, c.idx * 3, grip.spread[c.idx], false); return c.pts[3].clone().applyMatrix4(armToModel); });
    },
    /** Jumps to the target pose on the next update instead of easing there. */
    snap() { first = true; },
  };
}
