// The first-person view model: two hands with forearms, the player's body, and taking, carrying, using and
// putting back a fire extinguisher. The behaviour follows docs/hands/design.md; createViewModel() below lists
// the interface. Everything a hand does is planned in the world (the room), not on the screen: a head-mounted
// camera shows what it shows, and the unit only moves when a hand holds it.
import * as THREE from 'three';
import { VIEW_LAYER } from '../stage.js';
import { createHand, REST_ANGLES, REST_SPREAD } from './hands/hand.js';
import { createBody } from './hands/body.js';

// ---------------------------------------------------------------- the valve head (src/extinguisher.js)
// Every extinguisher has the same valve head, in "head" space: origin on top of the neck, x along the levers,
// y up. Centre lines of the two levers and their half sizes:
const LEVER = [[-0.022, 0.074], [0.0, 0.081], [0.05, 0.096], [0.1, 0.111], [0.142, 0.119]];
const HANDLE = [[-0.012, 0.058], [0.035, 0.057], [0.085, 0.043], [0.122, 0.024], [0.14, 0.017]];
const PIVOT = [-0.008, 0.073], NECK = 0.012, SQUEEZE = -0.22;
const leverHalf = (u) => 0.0042 + 0.0022 * u + 0.002, handleHalf = (u) => 0.0042 + 0.001 * u + 0.002;
const LEVER_Z = 0.0155, HANDLE_Z = 0.0135;
const GRIP_HEAD = [0.075, 0.052, 0];             // ext.userData.grip, head space
const PIN_AXIS = [0.014, 0.078];                 // the pin's shank runs along z through this point (head space)
const RING = [0.014, 0.068, 0.025];              // middle of the pull ring

// The levers of this model open in a V (3 cm apart at the valve, 9 cm at the tips), so the hand sits near the valve
// end, where all four fingers can come down over the lever's far side and reach the carrying handle.
const GRIP = {
  leverX: 0.045,      // where the middle of the hand lies along the squeeze lever (head space, m before scaling)
  palmBack: 0.015,    // from the knuckle line back to where the lever's far top edge meets the palm (m): the bar
                      // lies across the palm at the crease below the knuckles, as in a power grip
  palmPitch: 0.3,     // the hand lies over the lever, fingers pointing this far down from level (rad)
  sink: 0.003,        // how far the lever presses into the palm (m)
};

// ---------------------------------------------------------------- the take (design.md, "The take")
// Times from E with the player at the stance. The reach runs from T.reach to T.contact as one movement: a
// bell-shaped speed with its peak at about a third, and a slow last part in which the palm comes down onto the
// lever (3 cm short of contact at T.pre).
const T = { look: 0.3, reach: 0.15, pre: 0.9, contact: 1.1, load: 1.25, lifted: 1.55, view: 1.6, carried: 2.25, done: 2.7 };
const LIFT = 0.035;                               // up off the hook before it can come away (m)
// Eye in front of the handle's plane; right shoulder in front of the handle. design.md asks 0.36 m for a real body,
// whose eye is about 0.10 m in front of the shoulder joint; this body's shoulders are 0.17 m behind the eye, so the
// same shoulder-to-handle distance (0.46 m) puts the eye at 0.30 m.
const STANCE = { eye: 0.3, side: 0.2 };
const LOOK_SHARE = 0.65;                          // the head turns this share of the way to the handle, the eyes the rest
// Body space: x right, y up, -z forward, origin on the floor under the shoulders (0.17 m behind the eye).
// The stances of design.md are given in camera space at a level gaze; these are the same points on the body.
const fromEye = (x, y, z) => new THREE.Vector3(x, 1.64 + y, -0.17 + z);
const CARRY = fromEye(0.24, -0.51, -0.21);        // the handle's grip point while carrying (design.md: about 0.24, -0.47, -0.20)
const PIN_UP = fromEye(0.24, -0.38, -0.27);       // raised so the valve can be seen while the other hand pulls the pin
const READY = fromEye(0.25, -0.4, -0.28);         // at the right hip-front while spraying
const PRESENT = fromEye(0.1, -0.35, -0.16);       // brought up in front of the body while the left hand takes or stows the hose
// camera space: the nozzle while aiming (it follows the gaze). Inside the frame and within reach when he looks down
// at the base of a fire (15 to 40 degrees); at a level gaze the arm cannot reach it and the hand stops short.
const AIM = new THREE.Vector3(-0.08, -0.22, -0.46);
const LOW_NOZZLE = fromEye(-0.1, -0.62, -0.2);    // the nozzle held low in the left hand (body space)
// Where the elbows are pulled (body space): out and a little back while carrying, the elbow at about its own
// height; out and up for the reach down onto the levers (the forearm then comes down to the hand); hanging free:
// low, out and back.
const POLE_R = new THREE.Vector3(0.45, 1.1, 0.2), POLE_L = new THREE.Vector3(-0.36, 0.75, 0.3);
const POLE_REACH = new THREE.Vector3(0.42, 1.45, -0.08);
const COCK = 0.3;                                 // the hand comes over the lever bent back this much (rad), fingers raised
const PENDULUM = { omega: (2 * Math.PI) / 1.0, zeta: 0.3, gain: 0.45, arm: 0.28 };   // a 1 s swing, damped in about 1.5 s
const T_PIN = { reach: 0.42, pinch: 0.52, twist: 0.62, pull: 0.8, drop: 0.86, back: 1.3 };
const T_AIM = { reach: 0.45, grab: 0.6, out: 0.8, up: 1.2 };
const T_PUT = { raise: 1.0, lower: 1.4, open: 1.6, back: 2.5 };
const STANCE_RATE = 1 / 0.85;                     // carry <-> raised for the pin <-> ready, per second (a heavy unit moves slowly)
const PRESENT_RATE = 1 / 0.8;
const FOLLOW = 1e4;                               // blend rate that makes a hand follow its pose exactly

const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const minJerk = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (6 * x - 15)));
const slowStart = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (4 - 3 * x));        // speed ~ x^2 (1 - x): a heavy thing
const span = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Reach speed: a bell with its peak at a third (Beta 2,4) plus a slow homing part, normalised to a distance of 1.
const REACH_S = (() => {
  const N = 240, f = (x) => 0.75 * (x * x * (1 - x) ** 4) / ((1 / 3) ** 2 * (2 / 3) ** 4) + 0.25 * (x ** 1.5 * (1 - x)) / (0.6 ** 1.5 * 0.4);
  const s = [0];
  for (let i = 1; i <= N; i++) s.push(s[i - 1] + (f((i - 1) / N) + f(i / N)) / 2 / N);
  return s.map((x) => x / s[N]);
})();
const reachS = (x) => { const N = REACH_S.length - 1, k = clamp(x, 0, 1) * N, i = Math.min(N - 1, Math.floor(k)); return lerp(REACH_S[i], REACH_S[i + 1], k - i); };

// Centre line of a lever as ribbonShape() draws it: [x, y, u] samples, in head space.
function ribbon(points) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const out = [];
  for (let i = 0; i <= 28; i++) { const p = curve.getPoint(i / 28); out.push([p.x, p.y, i / 28]); }
  return out;
}
const LEVER_LINE = ribbon(LEVER), HANDLE_LINE = ribbon(HANDLE);

// Distance from (x, y) to a polyline of [x, y, u]; returns [distance, u at the closest point].
function polyDist(line, x, y, cs, sn, px, py) {
  let best = 1e9, bu = 0, ax = 0, ay = 0;
  for (let i = 0; i < line.length; i++) {
    const dx = line[i][0] - px, dy = line[i][1] - py;
    const bx = px + dx * cs - dy * sn, by = py + dx * sn + dy * cs;
    if (i > 0) {
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      const t = clamp(((x - ax) * ex + (y - ay) * ey) / l2, 0, 1);
      const d = Math.hypot(x - ax - ex * t, y - ay - ey * t);
      if (d < best) { best = d; bu = lerp(line[i - 1][2], line[i][2], t); }
    }
    ax = bx; ay = by;
  }
  return [best, bu];
}
const slab = (d2, dz) => Math.hypot(Math.max(d2, 0), Math.max(dz, 0)) + Math.min(Math.max(d2, dz), 0);

/** Signed distance (unit space, unscaled metres) to the valve head, its lever turned by phi. */
function headSDF(p, H, phi) {
  const y = p.y - H - NECK, az = Math.abs(p.z);
  const [dl, ul] = polyDist(LEVER_LINE, p.x, y, Math.cos(phi), Math.sin(phi), PIVOT[0], PIVOT[1]);
  let d = slab(dl - leverHalf(ul), az - LEVER_Z);
  const [dh, uh] = polyDist(HANDLE_LINE, p.x, y, 1, 0, 0, 0);
  d = Math.min(d, slab(dh - handleHalf(uh), az - HANDLE_Z));
  // valve block and stem, the pin's ring (kept clear for the other hand), the gauge
  d = Math.min(d, Math.max(Math.abs(p.x + 0.004) - 0.016, Math.abs(y - 0.068) - 0.016, az - 0.016));
  d = Math.min(d, Math.max(Math.hypot(p.x, p.z) - 0.019, Math.abs(y - 0.035) - 0.035));
  d = Math.min(d, Math.max(Math.abs(p.x - 0.014) - 0.015, Math.abs(y - 0.068) - 0.015, Math.abs(p.z - 0.025) - 0.006));
  d = Math.min(d, Math.max(Math.hypot(p.x, y - 0.036) - 0.019, Math.abs(p.z - 0.028) - 0.016));
  return d;
}

/**
 * createViewModel({ camera, world, manager }) -> vm
 *
 *   vm.update(dt, { player, lighting })   every frame, after player.update(dt)
 *       player: pos, yaw, pitch, speed, running, bobPhase, bobAmp, yawVel, pitchVel, air (and guide(), release())
 *       lighting: { ambient: Color, keyDir: Vector3 (world, towards the light), keyColor: Color }
 *   vm.take(ext, { player }) -> Promise<boolean>   walk to the stance, look, reach, close, lift, bring to the carry
 *   vm.putBack({ player, instant }) -> Promise     stow the hose, walk to the stance, hang it up, let go
 *   vm.pullPin() -> Promise                        left hand: to the ring, pinch, twist, pull, drop the pin
 *   vm.setReady(on)                                on: the left hand takes the hose (or horn) and aims; off: lowers it
 *   vm.squeeze(amount)                             0..1 every frame; with the pin in the lever does not move
 *   vm.getJet(origin, direction) -> boolean        world-space nozzle tip and its direction; false if nothing is held
 *   vm.holding                                     the extinguisher group being held, or null
 *   vm.busy                                        a take, put-back or pin pull is under way
 *   vm.aimed                                       the nozzle is in the left hand and pointing ahead
 *   vm.stanceFor(ext) -> { pos, yaw, pitch }       where a take stands and looks (shed space)
 *   vm.probe()                                     world-space joints for the test pages
 *   vm.materials, vm.viewObjects, vm.body, vm.hands, vm.setHandsVisible(on), vm.stats()
 *   vm.reachFor / vm.hold / vm.release             old two-step take, kept for old test pages
 */
export async function createViewModel({ camera, world, manager } = {}) {
  const [right, left] = await Promise.all([createHand(camera, { side: 'right', manager }), createHand(camera, { side: 'left', manager })]);
  const hands = [right, left];
  const body = createBody(world, { skinMaterial: right.skin.upper });
  const materials = [...new Set([...right.materials, ...left.materials, ...body.materials])];

  for (const hd of hands) {
    hd.root.traverse((o) => {
      o.layers.set(VIEW_LAYER);
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; }
    });
  }
  // The view layer is drawn over a cleared depth buffer. Depth-only copies of the body put its depth
  // back, so a hand that goes behind the chest or an upper arm is hidden by it as it should be.
  const proxies = [];
  {
    const front = new THREE.MeshBasicMaterial({ colorWrite: false }), both = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const meshes = [];
    body.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const m of meshes) {
      const p = new THREE.Mesh(m.geometry, m.material.side === THREE.DoubleSide ? both : front);
      p.layers.set(VIEW_LAYER);
      p.frustumCulled = false;
      p.renderOrder = -5;
      m.add(p);
      proxies.push(p);
    }
  }

  // ---------------------------------------------------------------- scratch
  const camInv = new THREE.Matrix4(), tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4(), tmpM3 = new THREE.Matrix4();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0), ONE = new THREE.Vector3(1, 1, 1);
  const camQ = new THREE.Quaternion(), camQinv = new THREE.Quaternion(), bodyQ = new THREE.Quaternion();
  let time = 0, handsVisible = true;

  // ---------------------------------------------------------------- right hand on the levers
  // Hand frame used for the grip: eA along the knuckle line (index -> little finger), n out of the palm.
  const R = right.rest;
  const eA = R.knuckleLine.clone().addScaledVector(R.n, -R.knuckleLine.dot(R.n)).normalize();
  const eU = new THREE.Vector3().crossVectors(eA, R.n).normalize();
  const palmR = (() => {
    const mid = R.joints[0][0].clone().lerp(R.joints[3][0], 0.5).addScaledVector(eU, -GRIP.palmBack);
    const d = R.raycast(mid.clone().addScaledVector(R.n, 0.06), R.n.clone().negate());
    return mid.addScaledVector(R.n, (isFinite(d) ? 0.06 - d : 0.012) - GRIP.sink);
  })();
  const modelFrameR = new THREE.Matrix4().makeBasis(eA, R.n, eU);
  const leverAt = (() => {
    let i = 1;
    while (i < LEVER_LINE.length - 1 && LEVER_LINE[i][0] < GRIP.leverX) i++;
    const a = LEVER_LINE[i - 1], b = LEVER_LINE[i], t = (GRIP.leverX - a[0]) / (b[0] - a[0]);
    return { x: GRIP.leverX, y: lerp(a[1], b[1], t), u: lerp(a[2], b[2], t), slope: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  })();
  /** Unit -> right-hand model matrix for a lever angle phi (0 .. SQUEEZE): the palm stays on the lever. */
  const uiM = new THREE.Matrix4(), uiA = new THREE.Vector3(), uiB = new THREE.Vector3(), uiC = new THREE.Vector3();
  function unitInHand(H, scale, phi, target = new THREE.Matrix4()) {
    const th = leverAt.slope + phi, c = Math.cos(th), s = Math.sin(th), cg = Math.cos(GRIP.palmPitch), sg = Math.sin(GRIP.palmPitch);
    const t = uiA.set(c, s, 0);
    const nU = uiB.set(s * cg, -c * cg, sg);                      // into the lever, leaning back towards the wrist
    const eu = uiC.crossVectors(t, nU);
    const unitFrame = uiM.makeBasis(t, nU, eu);
    target.copy(modelFrameR).multiply(unitFrame.transpose());     // rotation unit -> model
    const dx = leverAt.x - PIVOT[0], dy = leverAt.y - PIVOT[1], cp = Math.cos(phi), sp = Math.sin(phi), hh = leverHalf(leverAt.u);
    const cx = PIVOT[0] + dx * cp - dy * sp - s * hh, cy = PIVOT[1] + dx * sp + dy * cp + c * hh;
    const cU = new THREE.Vector3(cx, cy + H + NECK, -LEVER_Z).multiplyScalar(scale).applyMatrix4(target);
    target.scale(uiA.setScalar(scale));
    target.setPosition(palmR.clone().sub(cU));
    return target;
  }

  // ---------------------------------------------------------------- left hand on the hose
  const Lr = left.rest;
  const HOSE_SLANT = 0.75;                        // the hose crosses the left palm at this angle to the knuckle line (rad)
  const hoseAxisL = Lr.thumbDir.clone().multiplyScalar(Math.cos(HOSE_SLANT)).addScaledVector(Lr.u, Math.sin(HOSE_SLANT)).normalize();
  const palmL = (() => {
    const mid = Lr.joints[0][0].clone().lerp(Lr.joints[3][0], 0.5).addScaledVector(Lr.u, -0.03);
    const d = Lr.raycast(mid.clone().addScaledVector(Lr.n, 0.06), Lr.n.clone().negate());
    return mid.addScaledVector(Lr.n, isFinite(d) ? 0.06 - d : 0.012);
  })();

  // ---------------------------------------------------------------- finger poses
  // Opened for a grasp: the gap between thumb and fingers opens, the fingers stay together and a little bent
  // (reference 1.7 to 1.9: the hand pre-shapes, it does not splay).
  const OPEN_WIDE = { angles: Float32Array.from([0.14, 0.2, 0.08, 0.16, 0.22, 0.08, 0.18, 0.24, 0.09, 0.2, 0.26, 0.1, 0, 0.1, 0.08]), spread: Float32Array.from([-0.025, -0.005, 0.012, 0.03, 0.05]) };
  const REST = { angles: REST_ANGLES, spread: REST_SPREAD };
  const PINCH = { angles: Float32Array.from([0.75, 0.95, 0.45, 1.2, 1.45, 0.9, 1.3, 1.5, 0.9, 1.35, 1.5, 0.9, 0, 0.35, 0.4]), spread: Float32Array.from([0, 0, 0, 0, 0.62]) };
  const pinchTips = left.fkTips(PINCH);
  const pinchPoint = pinchTips[0].clone().lerp(pinchTips[4], 0.5);
  const mixFingers = (out, a, b, k) => {
    for (let i = 0; i < 15; i++) out.angles[i] = lerp(a.angles[i], b.angles[i], k);
    for (let i = 0; i < 5; i++) out.spread[i] = lerp(a.spread[i], b.spread[i], k);
    return out;
  };
  // A grasp closing: knuckles and middle joints first, the end joints last, the thumb with them (reference 2.3).
  const closeFingers = (out, from, to, x) => {
    for (let f = 0; f < 5; f++) {
      for (let j = 0; j < 3; j++) {
        const i = f * 3 + j, k = f === 4 ? smooth(0.1, 1, x) : j === 2 ? smooth(0.3, 1, x) : smooth(0, 0.8, x);
        out.angles[i] = lerp(from.angles[i], to.angles[i], k);
      }
      out.spread[f] = lerp(from.spread[f], to.spread[f], smooth(0, 0.7, x));
    }
    return out;
  };
  const fingers = () => ({ angles: new Float32Array(15), spread: new Float32Array(5), w: 0 });
  const fingersR = fingers(), fingersL = fingers();

  // ---------------------------------------------------------------- per-unit fits (made once per kind)
  const fitCache = new Map();
  let lastFits = null;
  function fitsFor(ext) {
    const ud = ext.userData, scale = ext.getWorldScale(v1).x, key = `${ud.kind}:${scale.toFixed(4)}`;
    if (fitCache.has(key)) return (lastFits = fitCache.get(key));
    const co2 = ud.kind === 'co2';
    const lever = (phi, start) => {
      const inv = unitInHand(ud.H, scale, phi).invert(), p = new THREE.Vector3();
      return right.solveGrasp((pm) => headSDF(p.copy(pm).applyMatrix4(inv), ud.H, phi) * scale, {
        start: start || [[0.4, 0.1, 0.1], [0.4, 0.1, 0.1], [0.4, 0.1, 0.1], [0.4, 0.1, 0.1], [0, 0.15, 0.15]],
        limit: [[1.65, 1.75, 1.2], [1.65, 1.75, 1.2], [1.65, 1.75, 1.2], [1.65, 1.75, 1.2], [0, 0.8, 1.1]],
        thumbIn: [0.2, 0.9],
        // fingertips belong under the carrying handle
        attract: (pm) => { p.copy(pm).applyMatrix4(inv); return Math.hypot(polyDist(HANDLE_LINE, p.x, p.y - ud.H - NECK, 1, 0, 0, 0)[0], p.z) * scale; },
      });
    };
    const fit0 = lever(0);
    // squeezed: closes on from the open fit, so no joint ever opens as the lever comes down
    const start1 = [0, 1, 2, 3, 4].map((f) => [0, 1, 2].map((j) => fit0.angles[f * 3 + j]));
    const fit1 = lever(SQUEEZE, start1);
    for (let i = 0; i < 15; i++) fit1.angles[i] = Math.max(fit1.angles[i], fit0.angles[i]);
    fit1.spread.set(fit0.spread);
    // left fist round the nozzle (water, powder) or round the horn's grip (CO2)
    const fistY = co2 ? -0.03 : -0.025;                     // fist middle along the nozzle (nozzle space, -y is towards the tip)
    const rFist = (co2 ? 0.015 : ud.hoseRadius + 0.0014) * scale;
    const axisPt = palmL.clone().addScaledVector(Lr.n, rFist - 0.002);
    const tube = (pm) => {
      const d = v4.copy(pm).sub(axisPt), along = d.dot(hoseAxisL) / scale - fistY;
      let r = (ud.hoseRadius + 0.0006) * scale;
      if (co2 && along > 0.07) r = lerp(0.017, 0.05, clamp((along - 0.07) / 0.21, 0, 1)) * scale;
      else if (co2 && along > -0.0125) r = 0.015 * scale;
      else if (!co2 && along > -0.015) r = (ud.hoseRadius + 0.0014) * scale;
      return d.addScaledVector(hoseAxisL, -d.dot(hoseAxisL)).length() - r;
    };
    const fitL = left.solveGrasp(tube, {
      start: [[0.2, 0.1, 0.1], [0.2, 0.1, 0.1], [0.2, 0.1, 0.1], [0.2, 0.1, 0.1], [0, 0.05, 0.05]],
      thumbIn: [0.1, 0.95],
      attract: (pm) => { const d = v4.copy(pm).sub(axisPt); return d.addScaledVector(hoseAxisL, -d.dot(hoseAxisL)).length(); },
    });
    // nozzle in left-hand model space: its -y along the hose axis, origin fistY behind the fist's middle
    const nozzleInHand = new THREE.Matrix4().compose(
      axisPt.clone().addScaledVector(hoseAxisL, fistY * scale),
      new THREE.Quaternion().setFromUnitVectors(DOWN, hoseAxisL), new THREE.Vector3(scale, scale, scale));
    const T0 = unitInHand(ud.H, scale, 0);
    const gripUnit = new THREE.Vector3(GRIP_HEAD[0], ud.H + NECK + GRIP_HEAD[1], GRIP_HEAD[2]).multiplyScalar(scale);
    const fits = { co2, scale, fit0, fit1, fitL, nozzleInHand, nozzleInHandInv: nozzleInHand.clone().invert(), T0, T0inv: T0.clone().invert(),
      gripUnit: new THREE.Vector3(GRIP_HEAD[0], ud.H + NECK + GRIP_HEAD[1], GRIP_HEAD[2]),   // unit space, unscaled
      seatR: gripUnit.clone().applyMatrix4(T0),             // where the handle's grip point sits in the right hand (model space)
      seatL: axisPt.clone() };
    fitCache.set(key, fits);
    {
      // for checking a grip by numbers: where each fingertip ends up, head space (cm), and how far from the handle
      const inv = fits.T0inv, tips = right.fkTips(fit0), tips1 = right.fkTips(fit1);
      const head = (p) => { const q = p.clone().applyMatrix4(inv); return [q.x, q.y - ud.H - NECK, q.z]; };
      const toHandle = (h) => Math.hypot(Math.max(0, polyDist(HANDLE_LINE, h[0], h[1], 1, 0, 0, 0)[0] - 0.006), Math.max(0, Math.abs(h[2]) - HANDLE_Z));
      vm.debug.fit = vm.debug.fit || {};
      vm.debug.fit[ud.kind] = {
        angles: Array.from(fit0.angles, (x) => +x.toFixed(2)), thumbIn: +fit0.spread[4].toFixed(2),
        tips: tips.map((p) => head(p).map((x) => +(x * 100).toFixed(1))),
        tipToHandle: tips.map((p) => +(toHandle(head(p)) * 100).toFixed(1)),
        tipToHandleSqueezed: tips1.map((p) => +(toHandle(head(p).map((x, i) => x)) * 100).toFixed(1)),
        wrist: head(R.wrist).map((x) => +(x * 100).toFixed(1)), knuckles: [head(R.joints[0][0]), head(R.joints[3][0])].map((h) => h.map((x) => +(x * 100).toFixed(1))),
        left: Array.from(fitL.angles, (x) => +x.toFixed(2)), leftThumbIn: +fitL.spread[4].toFixed(2),
        leftTipToAxis: left.fkTips(fitL).map((p) => { const d = p.clone().sub(axisPt); return +(d.addScaledVector(hoseAxisL, -d.dot(hoseAxisL)).length() * 100).toFixed(1); }),
      };
    }
    return (lastFits = fits);
  }

  // ---------------------------------------------------------------- poses from the world
  /** Camera-space wrist pose of a hand whose model sits at world matrix Mw. */
  function poseFromModel(hd, Mw, out) {
    tmpM.multiplyMatrices(camInv, Mw);
    out.q.setFromRotationMatrix(tmpM);
    out.pos.copy(hd.rest.wrist).applyMatrix4(tmpM);
    return out;
  }
  /** World matrix of the right hand's model that holds a unit placed at world matrix Uw, lever at phi. */
  function rightModelFor(Uw, fits, ud, phi, out) {
    unitInHand(ud.H, fits.scale, phi, tmpM3).invert();
    return out.multiplyMatrices(Uw, tmpM3);
  }
  /** World matrix of a unit whose handle grip point is at G (world) and that is turned by Q (world). */
  function unitAt(G, Q, fits, out) {
    v4.copy(fits.gripUnit).multiplyScalar(fits.scale).applyQuaternion(Q);
    return out.compose(v4.negate().add(G), Q, v1.setScalar(fits.scale));
  }
  const bodyPoint = (b, out) => out.copy(b).applyMatrix4(body.group.matrixWorld);
  const camPoint = (w, out) => out.copy(w).applyMatrix4(camInv);

  // Cubic Bezier sampled by arc length: path(s) for s in 0..1 of the length.
  function arcPath(p0, c1, c2, p3) {
    const N = 64, pts = [], len = [0];
    const at = (u, o) => {
      const a = 1 - u;
      return o.set(0, 0, 0).addScaledVector(p0, a * a * a).addScaledVector(c1, 3 * a * a * u).addScaledVector(c2, 3 * a * u * u).addScaledVector(p3, u * u * u);
    };
    for (let i = 0; i <= N; i++) { pts.push(at(i / N, new THREE.Vector3())); if (i) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1])); }
    const L = len[N];
    return {
      length: L,
      at(s, o) {
        const want = clamp(s, 0, 1) * L;
        let i = 1;
        while (i < N && len[i] < want) i++;
        const k = (want - len[i - 1]) / Math.max(len[i] - len[i - 1], 1e-9);
        return o.copy(pts[i - 1]).lerp(pts[i], clamp(k, 0, 1));
      },
      /** largest distance of the curve above the straight line from start to end */
      bow() {
        const d = p3.clone().sub(p0), dl = d.length(), r = new THREE.Vector3();
        d.multiplyScalar(1 / dl);
        let best = 0;
        for (const p of pts) { r.copy(p).sub(p0); r.addScaledVector(d, -r.dot(d)); best = Math.max(best, r.y); }
        return best;
      },
    };
  }

  // ---------------------------------------------------------------- state
  let act = null;                    // the right hand's current job: take | put (and its own clock)
  let lact = null;                   // the left hand's current job: pin | aim
  let held = null;                   // the unit in the right hand
  let wantReady = false, wantSqueeze = 0, squeeze = 0, effort = 0, effortT = 0;
  let raiseK = 0, readyK = 0, presentK = 0;   // right-hand stance: carry -> raised for the pin / brought in front / ready
  let aimK = 0;                      // the nozzle in the left hand: held low (0) or aimed where he looks (1)
  let downR = 1, downL = 1;          // how far each hand is on the hanging arm
  const pend = { x: 0, z: 0, vx: 0, vz: 0, prev: new THREE.Vector3(), prevV: new THREE.Vector3(), acc: new THREE.Vector3(), ok: false };
  const sR = {}, sL = {};
  const poseR = { pos: new THREE.Vector3(), q: new THREE.Quaternion() }, poseL = { pos: new THREE.Vector3(), q: new THREE.Quaternion() };
  const poleR = new THREE.Vector3(), poleL = new THREE.Vector3();
  const shake = new THREE.Vector3(), kickL = new THREE.Vector3();
  let lastR = null, lastL = null;    // the hands' outputs of the previous frame
  let playerRef = null;
  const leftIdle = [];               // callbacks for when the left hand has nothing to do
  let fallingPin = null;

  // ---------------------------------------------------------------- the stance for a take
  const shedOf = (wp) => world.worldToLocal(wp.clone());
  function stanceFor(ext) {
    ext.updateWorldMatrix(true, false);
    // the handle where it hangs on the bracket (not where the unit is now: it may be in the hand)
    const ud = ext.userData;
    const g = shedOf(new THREE.Vector3(GRIP_HEAD[0], ud.H + NECK + GRIP_HEAD[1], GRIP_HEAD[2]).applyMatrix4(ext.matrixWorld));
    // the unit's room side, in shed space
    const nW = new THREE.Vector3(0, 0, 1).applyQuaternion(ext.getWorldQuaternion(new THREE.Quaternion()));
    const n = nW.transformDirection(tmpM.copy(world.matrixWorld).invert()).setY(0).normalize();
    const yaw = Math.atan2(n.x, n.z);                                     // facing the wall: forward = -n
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const pos = g.clone().addScaledVector(n, STANCE.eye).addScaledVector(right, -STANCE.side).setY(0);
    return { pos, yaw, grip: g };
  }
  /** Where the head turns to look at a point (shed space) from an eye at `pos`: part of the way, the eyes do the rest. */
  function lookAt(pos, yaw0, p, floorY = 0) {
    const dx = p.x - pos.x, dz = p.z - pos.z, dy = p.y - (floorY + 1.64);
    const yawFull = Math.atan2(-dx, -dz), pitchFull = Math.atan2(dy, Math.hypot(dx, dz));
    // the body turns with the view in this game, so the head only tips down: turning would swing the shoulder away
    return { yaw: yaw0, pitch: pitchFull * LOOK_SHARE, yawFull };
  }

  // ---------------------------------------------------------------- holding (attach / detach)
  function attach(ext, fits) {
    const ud = ext.userData, unit = ud.unit;
    right.model.updateWorldMatrix(true, false);
    right.model.attach(unit);
    unit.traverse((o) => {
      o.layers.set(VIEW_LAYER);
      if (o.isMesh) { if (o.userData.cast === undefined) o.userData.cast = o.castShadow; o.castShadow = false; o.receiveShadow = true; }
    });
    unit.matrixAutoUpdate = true;
    held = { ext, ud, unit, fits, pinOut: !ud.pin.visible, pinHome: ud.pin.position.clone(), pinParent: ud.pin.parent,
      wallNozzle: { p: ud.nozzle.position.clone(), q: ud.nozzle.quaternion.clone() },
      wall: new THREE.CatmullRomCurve3(ud.wallHose.map(V), false, 'centripetal'),
      noz: { inHand: false, free: 0 }, hoseKey: '' };
    held.hoseLength = held.wall.getLength();               // unit space
    held.wallPts = held.wall.getSpacedPoints(24);
    vm.holding = ext;
  }
  /** Back on the wall exactly as it hangs there; everything the hands changed is put back. */
  function detach() {
    if (!held) return null;
    const { ext, ud, unit } = held;
    ext.add(unit);
    unit.position.set(0, 0, 0);
    unit.quaternion.identity();
    unit.scale.set(1, 1, 1);
    unit.traverse((o) => { o.layers.set(0); if (o.isMesh && o.userData.cast !== undefined) o.castShadow = o.userData.cast; });
    ud.leverPivot.rotation.z = 0;
    restorePin();
    ud.pin.visible = true;
    ud.setHose(ud.wallHose);
    held = null;
    vm.holding = null;
    wantSqueeze = 0; squeeze = 0; wantReady = false; readyK = 0; raiseK = 0; presentK = 0; aimK = 0;
    pend.ok = false; pend.x = pend.z = pend.vx = pend.vz = 0;
    return unit;
  }
  function restorePin() {
    if (!held) return;
    const pin = held.ud.pin;
    if (fallingPin && fallingPin.obj === pin) fallingPin = null;
    if (pin.parent !== held.pinParent) held.pinParent.add(pin);
    pin.position.copy(held.pinHome);
    pin.quaternion.identity();
  }

  // ---------------------------------------------------------------- the hose
  const hosePts = Array.from({ length: 9 }, () => new THREE.Vector3()), hoseStart = new THREE.Vector3();
  const hE = new THREE.Vector3(), hA = new THREE.Vector3(), hDown = new THREE.Vector3(), hQ = new THREE.Quaternion();
  const hoseCurve = new THREE.CatmullRomCurve3(hosePts, false, 'centripetal');
  hoseCurve.arcLengthDivisions = 48;
  const hoseOut = Array.from({ length: 25 }, () => new THREE.Vector3()), hoseBase = Array.from({ length: 25 }, () => new THREE.Vector3());
  /** Control points (unit space) from the valve to the nozzle end `e` arriving along `a`, hanging with its own length. */
  function hosePoints(h, e, a, down, stiff) {
    const s0 = hoseStart.fromArray(h.ud.hoseStart), L = h.hoseLength;   // unit space, as the curve
    // the straight bits at both ends (out of the valve, into the nozzle) scale with the hose: a short CO2 hose
    // would otherwise be all ends and no hose
    const k = Math.min(1, L / 0.6);
    hosePts[0].copy(s0);
    hosePts[1].copy(s0).x -= 0.035 * k;
    hosePts[2].copy(s0).x -= 0.07 * k; hosePts[2].addScaledVector(down, 0.012 * k);
    hosePts[8].copy(e);
    hosePts[7].copy(e).addScaledVector(a, -0.04 * k);
    hosePts[6].copy(e).addScaledVector(a, -0.085 * k).addScaledVector(down, 0.006 * k);
    const shape = 1 + stiff;                           // a pressurised hose bends more evenly
    const place = (sag) => {
      for (let i = 3; i <= 5; i++) {
        const t = (i - 2) / 4;
        hosePts[i].copy(hosePts[2]).lerp(hosePts[6], t).addScaledVector(down, sag * (1 - Math.abs(2 * t - 1) ** (2 / shape)) + 0.004);
      }
      hoseCurve.updateArcLengths();
      return hoseCurve.getLength();
    };
    let lo = 0, hi = 0.6;
    if (place(0) < L) {
      for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (place(mid) < L) lo = mid; else hi = mid; }
      place((lo + hi) / 2);
    }
    return hosePts;
  }
  /** The hose and nozzle for this frame: in the clip, being pulled out of it, or in the left hand. */
  function updateHose() {
    const h = held, ud = h.ud, noz = h.noz;
    if (!noz.inHand) {
      if (h.hoseKey !== 'wall') { ud.setHose(ud.wallHose); h.hoseKey = 'wall'; }
      return;
    }
    h.unit.updateMatrixWorld(true);
    const toUnit = tmpM.copy(h.unit.matrixWorld).invert();
    tmpM2.multiplyMatrices(left.model.matrixWorld, h.fits.nozzleInHand).premultiply(toUnit).decompose(hE, hQ, v1);
    const a = hA.copy(DOWN).applyQuaternion(hQ);
    const down = hDown.copy(DOWN).transformDirection(toUnit);
    const key = `${hE.x.toFixed(4)},${hE.y.toFixed(4)},${hE.z.toFixed(4)},${a.x.toFixed(3)},${a.y.toFixed(3)},${down.x.toFixed(3)},${down.z.toFixed(3)},${noz.free.toFixed(3)},${squeeze.toFixed(2)}`;
    if (key === h.hoseKey) return;
    h.hoseKey = key;
    hosePoints(h, hE, a, down, squeeze);
    if (noz.free < 1) {
      // still sliding out of the clip: the wall shape, its end carried along with the nozzle, blended to the free hose
      const k = smooth(0, 1, noz.free);
      const pts = hoseCurve.getSpacedPoints(24);
      const shift = v2.copy(hE).sub(h.wallPts[24]);
      for (let i = 0; i <= 24; i++) {
        const w = smooth(0.45, 1, i / 24);
        hoseBase[i].copy(h.wallPts[i]).addScaledVector(shift, w).lerp(pts[i], k);
      }
      // a blend of two shapes is shorter than either: let the middle sag until the hose has its length again
      const L = h.hoseLength;
      const shape = (sag) => {
        let len = 0;
        for (let i = 0; i <= 24; i++) {
          hoseOut[i].copy(hoseBase[i]).addScaledVector(down, sag * Math.sin((Math.PI * i) / 24));
          if (i) len += hoseOut[i].distanceTo(hoseOut[i - 1]);
        }
        return len;
      };
      let lo = 0, hi = 0.3, len = shape(0);
      if (len < L) {
        for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (shape(mid) < L) lo = mid; else hi = mid; }
        len = shape((lo + hi) / 2);
      }
      h.hoseNow = len * h.fits.scale;                  // what the probe reports while it slides out
      ud.setHose(hoseOut);
    } else { h.hoseNow = null; ud.setHose(hosePts); }
    ud.nozzle.position.copy(hE);
    ud.nozzle.quaternion.copy(hQ);
  }

  // ---------------------------------------------------------------- the right hand's stance while holding
  const stanceG = new THREE.Vector3(), stanceQ = new THREE.Quaternion(), swingQ = new THREE.Quaternion(), eulS = new THREE.Euler();
  const unitW = new THREE.Matrix4(), modelW = new THREE.Matrix4(), gripPlan = new THREE.Vector3();
  /** World grip point and orientation of the carried unit (before its swing), from the body. */
  function carryPlan(player, outG, outQ) {
    v1.copy(CARRY).lerp(PIN_UP, smooth(0, 1, raiseK)).lerp(READY, smooth(0, 1, readyK)).lerp(PRESENT, smooth(0, 1, presentK));
    // a loaded arm hardly swings (reference 3.7); the unit swings instead
    const walk = Math.min((player.speed || 0) / 1.9, 1);
    v1.z += -0.012 * walk * Math.sin(player.bobPhase || 0);
    bodyPoint(v1, outG);
    outQ.copy(bodyQ);
    return outG;
  }
  /** The swing of a unit hanging from the hand (two damped pendulum angles in the body's frame), driven by how
   *  the grip point is accelerated and by the steps. */
  function swingStep(dt, G, player) {
    if (!pend.ok) { pend.prev.copy(G); pend.prevV.set(0, 0, 0); pend.acc.set(0, 0, 0); pend.ok = true; }
    if (dt <= 0) return swingQ.setFromEuler(eulS.set(pend.x, 0, pend.z));
    const vel = v1.copy(G).sub(pend.prev).divideScalar(dt);
    // the hand's acceleration, smoothed over a few frames (two differences of a sampled path are noisy)
    pend.acc.lerp(v2.copy(vel).sub(pend.prevV).divideScalar(dt), 1 - Math.exp(-dt * 25));
    pend.prev.copy(G); pend.prevV.copy(vel);
    // in the body's frame: forward is -z, right is +x
    const acc = v2.copy(pend.acc).applyQuaternion(q1.copy(bodyQ).invert());
    acc.x = clamp(acc.x, -6, 6); acc.z = clamp(acc.z, -6, 6);
    const P = PENDULUM, w = P.omega, step = Math.min(1, (player.speed || 0) / 1.9) * 0.9 * Math.sin(2 * (player.bobPhase || 0));
    const sub = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / sub;
    for (let i = 0; i < sub; i++) {
      // the bottom swings back when the hand is pushed forward: rotation about x is positive for a forward push
      pend.vx += (-w * w * pend.x - 2 * P.zeta * w * pend.vx + P.gain * (acc.z + step) / P.arm) * h;
      pend.vz += (-w * w * pend.z - 2 * P.zeta * w * pend.vz - P.gain * acc.x / P.arm) * h;
      pend.x += pend.vx * h; pend.z += pend.vz * h;
    }
    pend.x = clamp(pend.x, -0.2, 0.2); pend.z = clamp(pend.z, -0.2, 0.2);
    return swingQ.setFromEuler(eulS.set(pend.x, 0, pend.z));
  }
  /** Right-hand pose (camera space) for a unit held with grip point G and orientation Q (world). */
  function rightPoseHolding(G, Q, phi, out) {
    unitAt(G, Q, held.fits, unitW);
    rightModelFor(unitW, held.fits, held.ud, phi, modelW);
    return poseFromModel(right, modelW, out);
  }

  // ---------------------------------------------------------------- the take
  const tk = {
    P0: new THREE.Vector3(), Q0: new THREE.Quaternion(), E0: new THREE.Vector3(), Pc: new THREE.Vector3(), Qc: new THREE.Quaternion(),
    Mc: new THREE.Matrix4(), Uw: new THREE.Matrix4(), Gw: new THREE.Vector3(), Qw: new THREE.Quaternion(), n: new THREE.Vector3(), lifted: new THREE.Vector3(), Qpre: new THREE.Quaternion(),
    F0: fingers(), path: null,
  };
  function startTake(ext, player, resolve) {
    const fits = fitsFor(ext), ud = ext.userData;
    ext.updateWorldMatrix(true, true);
    ud.unit.updateWorldMatrix(true, false);
    tk.Uw.copy(ud.unit.matrixWorld);
    ud.unit.getWorldQuaternion(tk.Qw);
    ud.grip.getWorldPosition(tk.Gw);
    rightModelFor(tk.Uw, fits, ud, 0, tk.Mc);                     // the hand closed on the handle, unit still on the hook
    tk.Pc.copy(R.wrist).applyMatrix4(tk.Mc);
    tk.Qc.setFromRotationMatrix(tk.Mc);
    tk.n.copy(R.n).transformDirection(tk.Mc);                     // out of the palm, into the lever
    tk.Qpre.setFromAxisAngle(v1.copy(eA).transformDirection(tk.Mc), COCK).multiply(tk.Qc);
    // the unit is drawn with the hands from now on (so a finger behind a lever is hidden by it), and still in the room
    ud.unit.traverse((o) => o.layers.enable(VIEW_LAYER));
    act = { kind: 'take', t: 0, ext, ud, fits, player, resolve, started: false, attached: false, viewFree: false };
    const st = stanceFor(ext), look = lookAt(player.pos, st.yaw, st.grip, player.floorY || 0);
    act.look = look;
    if (player.guide) player.guide({ pos: player.pos.clone(), yaw: look.yaw, pitch: look.pitch, seconds: T.look });
  }
  function stepTake(dt, player) {
    const a = act, t = (a.t += dt), fits = a.fits, ud = a.ud;
    // ---- reach (one movement from the side to the lever), close
    if (t >= T.reach && !a.started) {
      a.started = true;
      tk.P0.copy(lastR.wristW); tk.Q0.copy(lastR.wristQW);
      tk.E0.copy(lastR.elbow);
      tk.F0.angles.set(lastR.angles); tk.F0.spread.set(lastR.spread);
      // a path bowed about 4 cm above the straight line, coming down onto the lever along the palm's normal
      const c2 = tk.Pc.clone().addScaledVector(tk.n, -0.07), c1 = new THREE.Vector3();
      let lo = -0.1, hi = 0.3;
      for (let i = 0; i < 12; i++) {
        const k = (lo + hi) / 2;
        c1.copy(tk.P0).lerp(tk.Pc, 0.3).addScaledVector(UP, k);
        if (arcPath(tk.P0, c1, c2, tk.Pc).bow() < 0.04) lo = k; else hi = k;
      }
      c1.copy(tk.P0).lerp(tk.Pc, 0.3).addScaledVector(UP, (lo + hi) / 2);
      tk.path = arcPath(tk.P0, c1, c2, tk.Pc.clone());
    }
    let pose = null;
    if (a.started && t < T.contact) {
      const x = span(t, T.reach, T.contact), xr = span(t, T.reach, T.pre);
      tk.path.at(reachS(x), v1);
      // palm turned down by 60 % of the reach, the hand bent back with its fingers up and open over the lever; it
      // comes down flat onto the lever only over the last 3 cm, as the fingers wrap
      q1.copy(tk.Q0).slerp(tk.Qpre, minJerk(xr / 0.6));
      if (t > T.pre - 0.06) q1.slerp(tk.Qc, minJerk(span(t, T.pre - 0.06, T.contact)));
      camPoint(v1, poseR.pos);
      poseR.q.copy(camQinv).multiply(q1);
      pose = poseR;
      // elbow: from where it hung to out at the side, as an arm reaching down in front of the body goes
      bodyPoint(POLE_REACH, v2);
      v3.copy(tk.E0).lerp(v2, smooth(0, 0.45, xr));
      camPoint(v3, poleR);
      // fingers: open to their widest at 65 %, take the handle's shape a little, close over the last 3 cm
      if (t < T.pre) {
        mixFingers(fingersR, tk.F0, OPEN_WIDE, smooth(0, 0.65, xr));
        if (xr > 0.65) mixFingers(fingersR, fingersR, fits.fit0, 0.15 * smooth(0.65, 1, xr));
      } else {
        const pre = mixFingers(fingers(), OPEN_WIDE, fits.fit0, 0.15);
        closeFingers(fingersR, pre, fits.fit0, span(t, T.pre, T.contact));
      }
      fingersR.w = 1;
    } else if (t >= T.contact) {
      if (!a.attached) { a.attached = true; attach(a.ext, fits); }
      // load: the grip tightens, nothing moves; lift: straight up off the hook, slow to start; bring in
      const lift = slowStart(span(t, T.load, T.lifted)) * LIFT;
      const lifted = tk.lifted.copy(tk.Gw).addScaledVector(UP, lift);
      carryPlan(player, gripPlan, q3);
      const xb = span(t, T.lifted, T.carried);
      if (xb > 0) {
        // away from the wall first, then down to the carry, on a curve
        const away = v2.set(0, 0, 1).applyQuaternion(tk.Qw);
        const path = arcPath(lifted, lifted.clone().addScaledVector(away, 0.09), v3.copy(gripPlan).addScaledVector(UP, 0.05), gripPlan);
        path.at(minJerk(xb), stanceG);
        stanceQ.copy(tk.Qw).slerp(q3, minJerk(xb));
        // settling: the arm gives a little under the weight and comes back
        stanceG.addScaledVector(UP, -0.008 * Math.sin(Math.PI * span(t, T.carried, T.done)) ** 2);
        swingStep(dt, stanceG, player);
        stanceQ.multiply(swingQ);
      } else { stanceG.copy(lifted); stanceQ.copy(tk.Qw); pend.ok = false; }
      pose = rightPoseHolding(stanceG, stanceQ, 0, poseR);
      // fingers: closed on the handle, tightening as the weight comes on
      mixFingers(fingersR, fits.fit0, fits.fit1, 0.25 * smooth(T.contact, T.load, t));
      fingersR.w = 1;
      bodyPoint(POLE_REACH, v2).lerp(bodyPoint(POLE_R, v3), minJerk(xb));
      poleR.copy(v2).applyMatrix4(camInv);
      if (t >= T.view && !a.viewFree) {
        a.viewFree = true;
        if (player.guide) player.guide({ pos: player.pos.clone() });           // the view is his again; his feet stay
      }
      if (t >= T.done) {
        if (player.release) player.release();
        act = null;
        a.resolve(true);
      }
    }
    return pose;
  }

  // ---------------------------------------------------------------- putting back
  const pk = { G0: new THREE.Vector3(), Q0: new THREE.Quaternion(), P0: new THREE.Vector3(), Q0w: new THREE.Quaternion(), path: null, F0: fingers() };
  function startPut(player, resolve) {
    const ud = held.ud, fits = held.fits;
    ud.unit.updateWorldMatrix(true, false);
    ud.grip.getWorldPosition(pk.G0);
    ud.unit.getWorldQuaternion(pk.Q0);
    // where it hangs: the bracket stayed on the wall, the unit's place is the ext group's own frame
    held.ext.updateWorldMatrix(true, false);
    tk.Uw.copy(held.ext.matrixWorld);
    tk.Gw.copy(fits.gripUnit).applyMatrix4(tk.Uw);
    held.ext.getWorldQuaternion(tk.Qw);
    act = { kind: 'put', t: 0, player, resolve, released: false };
    const st = stanceFor(held.ext), look = lookAt(player.pos, st.yaw, st.grip, player.floorY || 0);
    if (player.guide) player.guide({ pos: player.pos.clone(), yaw: look.yaw, pitch: look.pitch, seconds: 0.45 });
  }
  function stepPut(dt, player) {
    const a = act, t = (a.t += dt), fits = held ? held.fits : a.fits;
    if (!a.released) {
      const hook = v1.copy(tk.Gw).addScaledVector(UP, LIFT);
      if (t < T_PUT.raise) {
        // up and over the hook: out of the carry on a curve that comes to the wall from the room side
        const x = minJerk(span(t, 0, T_PUT.raise));
        const away = v2.set(0, 0, 1).applyQuaternion(tk.Qw);
        const path = arcPath(pk.G0, v3.copy(pk.G0).addScaledVector(UP, 0.06), v4.copy(hook).addScaledVector(away, 0.09), hook);
        path.at(x, stanceG);
        stanceQ.copy(pk.Q0).slerp(tk.Qw, x);
        swingStep(dt, stanceG, player);
        stanceQ.multiply(q2.copy(swingQ).slerp(q3.identity(), x));
      } else {
        // down onto the hook, slowly at the end
        const x = minJerk(span(t, T_PUT.raise, T_PUT.lower));
        stanceG.copy(hook).addScaledVector(UP, -LIFT * x);
        stanceQ.copy(tk.Qw);
      }
      const pose = rightPoseHolding(stanceG, stanceQ, 0, poseR);
      mixFingers(fingersR, held.fits.fit0, held.fits.fit1, 0.25 * (1 - smooth(T_PUT.raise, T_PUT.lower, t)));
      fingersR.w = 1;
      poleR.copy(bodyPoint(POLE_R, v2)).applyMatrix4(camInv);
      if (t >= T_PUT.lower) {
        // the hand opens: from this instant the unit hangs on the hook and does not move again
        a.released = true;
        a.fits = held.fits;
        rightModelFor(tk.Uw, held.fits, held.ud, 0, tk.Mc);
        tk.Pc.copy(R.wrist).applyMatrix4(tk.Mc);
        tk.Qc.setFromRotationMatrix(tk.Mc);
        tk.n.copy(R.n).transformDirection(tk.Mc);
        pk.F0.angles.set(fingersR.angles); pk.F0.spread.set(fingersR.spread);
        detach();
      }
      return pose;
    }
    // open the hand, lift it off the lever, take it back to the side
    const xo = span(t, T_PUT.lower, T_PUT.open);
    closeFingers(fingersR, pk.F0, OPEN_WIDE, xo);
    const xb = span(t, T_PUT.open, T_PUT.back);
    if (xb > 0) mixFingers(fingersR, OPEN_WIDE, REST, smooth(0.2, 1, xb));
    fingersR.w = 1 - smooth(0.85, 1, xb);
    // up off the lever along the palm, then down to the side; the last part lands on the hanging arm itself
    const down = lastR.down;
    if (!pk.path || xb === 0) {
      const target = down ? (q2.copy(lastR.downW.q), v2.copy(lastR.downW.pos)) : null;
      const end = target ? v2.clone() : tk.Pc.clone().addScaledVector(UP, -0.4);
      pk.path = arcPath(tk.Pc, v3.copy(tk.Pc).addScaledVector(tk.n, -0.1), v4.copy(end).addScaledVector(UP, 0.12), end);
      pk.Q0w.copy(q2);
    }
    const x = minJerk(span(t, T_PUT.lower + 0.08, T_PUT.back));
    pk.path.at(x, v1);
    camPoint(v1, poseR.pos);
    q1.copy(tk.Qc).slerp(pk.Q0w, minJerk(span(x, 0.15, 0.9)));
    poseR.q.copy(camQinv).multiply(q1);
    poleR.copy(bodyPoint(POLE_R, v2)).applyMatrix4(camInv);
    sR.downMix = smooth(0.75, 1, x);
    if (t >= T_PUT.back) {
      if (player.release) player.release();
      act = null;
      a.resolve();
      return null;
    }
    return poseR;
  }

  // ---------------------------------------------------------------- left hand: the pin
  const lp = { P0: new THREE.Vector3(), Q0: new THREE.Quaternion(), F0: fingers(), ring: new THREE.Vector3(), axis: new THREE.Vector3(), Qp: new THREE.Quaternion() };
  /** Left-hand model world matrix pinching the ring, for the unit as it is now, the pin `travel` out and turned by `turn`. */
  function pinchModel(travel, turn, out) {
    const h = held, H = h.ud.H, s = h.fits.scale;
    h.unit.updateMatrixWorld(true);
    const Uw = h.unit.matrixWorld;
    // the ring, turned about the pin's shank and slid out along it
    const ringU = v1.set(RING[0] - PIN_AXIS[0], RING[1] - PIN_AXIS[1], 0).applyAxisAngle(v2.set(0, 0, 1), turn).add(v3.set(PIN_AXIS[0], H + NECK + PIN_AXIS[1], RING[2] + travel / s));
    lp.ring.copy(ringU).applyMatrix4(Uw);
    // the hand over the ring: fingers pointing along the unit's +x and down, palm towards the unit, thumb up;
    // the whole hand turns with the ring as it is twisted
    const u = v2.set(0.55, -0.55, -0.35).normalize(), n = v3.set(-0.15, 0.25, -0.95);
    q1.setFromAxisAngle(v4.set(0, 0, 1), turn);
    u.applyQuaternion(q1); n.applyQuaternion(q1);
    const mq = h.unit.getWorldQuaternion(q2);
    u.applyQuaternion(mq); n.applyQuaternion(mq);
    const pp = left.makePose(v4.set(0, 0, 0), u.applyQuaternion(camQinv), n.applyQuaternion(camQinv));
    lp.Qp.copy(camQ).multiply(pp.q);                                 // world
    // placed so the pinch point (between thumb and index tips) is on the ring
    return out.compose(v3.copy(lp.ring).sub(v4.copy(pinchPoint).applyQuaternion(lp.Qp)), lp.Qp, ONE);
  }
  function startPin(resolve) {
    lact = { kind: 'pin', t: 0, resolve, out: false, dropped: false };
    lp.P0.copy(lastL.wristW); lp.Q0.copy(lastL.wristQW);
    lp.F0.angles.set(lastL.angles); lp.F0.spread.set(lastL.spread);
    // look at the valve if it would not be seen (the hand, not the eye, has to find the ring)
    const p = playerRef;
    if (p && p.guide && p.pitch > -0.5) p.guide({ pitch: -0.55, yaw: p.yaw, seconds: 0.4 });
  }
  function stepPin(dt) {
    const a = lact, t = (a.t += dt), h = held, ud = h.ud, s = h.fits.scale;
    const turn = (Math.PI / 2) * minJerk(span(t, T_PIN.pinch, T_PIN.twist));
    const travel = 0.07 * minJerk(span(t, T_PIN.twist, T_PIN.pull));
    // the pin turns and slides with the fingers until they let it go
    if (!a.dropped) {
      ud.pin.quaternion.setFromAxisAngle(v1.set(0, 0, 1), turn);
      v2.set(PIN_AXIS[0], PIN_AXIS[1], 0);
      ud.pin.position.copy(h.pinHome).add(v2).sub(v3.copy(v2).applyQuaternion(ud.pin.quaternion)).add(v1.set(0, 0, travel / s));
    }
    pinchModel(travel, turn, tmpM);
    const Pt = v1.copy(Lr.wrist).applyMatrix4(tmpM), Qt = q1.setFromRotationMatrix(tmpM);
    let P, Q;
    if (t < T_PIN.drop) {
      const x = span(t, 0, T_PIN.reach);
      // reach to the moving ring: the same profile as the right hand's, bowed a little upward
      const sx = reachS(x * 0.92 + 0.08 * minJerk(x));
      P = v2.copy(lp.P0).lerp(Pt, sx).addScaledVector(UP, 0.05 * Math.sin(Math.PI * sx));
      Q = q2.copy(lp.Q0).slerp(Qt, minJerk(x / 0.7));
      if (t < T_PIN.reach) {
        mixFingers(fingersL, lp.F0, OPEN_WIDE, smooth(0, 0.6, x));
        if (x > 0.6) mixFingers(fingersL, fingersL, PINCH, 0.25 * smooth(0.6, 1, x));
      } else {
        const pre = mixFingers(fingers(), OPEN_WIDE, PINCH, 0.25);
        closeFingers(fingersL, pre, PINCH, span(t, T_PIN.reach, T_PIN.pinch));
      }
      fingersL.w = 1;
      a.Pd = a.Pd || new THREE.Vector3(); a.Qd = a.Qd || new THREE.Quaternion();
      a.Pd.copy(P); a.Qd.copy(Q);
    } else {
      // let go: the pin falls, the hand goes back to the side
      if (!a.dropped) {
        a.dropped = true;
        const pin = ud.pin;
        pin.updateWorldMatrix(true, false);
        world.attach(pin);
        fallingPin = { obj: pin, vel: new THREE.Vector3(0, 0.2, 0).add(v3.set(0, 0, 0.25).applyQuaternion(h.unit.getWorldQuaternion(q3))), spin: new THREE.Vector3(3, 1, 5), t: 0 };
        a.Fd = fingers(); a.Fd.angles.set(fingersL.angles); a.Fd.spread.set(fingersL.spread);
      }
      const x = span(t, T_PIN.drop, T_PIN.back);
      const target = lastL.down ? (q3.copy(lastL.downW.q), v3.copy(lastL.downW.pos)) : null;
      P = v2.copy(a.Pd).lerp(target ? v3 : a.Pd, minJerk(x)).addScaledVector(UP, 0.03 * Math.sin(Math.PI * minJerk(x)));
      Q = q2.copy(a.Qd).slerp(target ? q3 : a.Qd, minJerk(x));
      mixFingers(fingersL, a.Fd, OPEN_WIDE, smooth(0, 0.25, x));
      if (x > 0.25) mixFingers(fingersL, fingersL, REST, smooth(0.25, 1, x));
      fingersL.w = 1 - smooth(0.85, 1, x);
      sL.downMix = smooth(0.8, 1, x);
    }
    if (!a.out && t >= T_PIN.pull) {
      a.out = true;
      h.pinOut = true;
      a.resolve();
      if (playerRef && playerRef.release && playerRef.guided && playerRef.guided.active && !act) playerRef.release();
    }
    if (t >= T_PIN.back) lact = null;
    camPoint(P, poseL.pos);
    poseL.q.copy(camQinv).multiply(Q);
    return poseL;
  }

  // ---------------------------------------------------------------- left hand: the hose (or the horn)
  const la = { P0: new THREE.Vector3(), Q0: new THREE.Quaternion(), F0: fingers(), Pg: new THREE.Vector3(), Qg: new THREE.Quaternion(), out: new THREE.Matrix4() };
  /** World matrix of the left hand model holding the nozzle at world matrix Nw. */
  const leftModelFor = (Nw, out) => out.multiplyMatrices(Nw, held.fits.nozzleInHandInv);
  /** Where the nozzle goes in the left hand: aimed (k = 1, follows the gaze) or held low at the side (k = 0). */
  const nozW = new THREE.Matrix4(), nozP = new THREE.Vector3(), nozQ = new THREE.Quaternion(), nozD = new THREE.Vector3();
  function nozzlePlan(k, out) {
    // aimed: camera space, pointing at what the player looks at
    v1.copy(AIM).applyMatrix4(camera.matrixWorld);
    v2.set(0, -0.02, -4).applyMatrix4(camera.matrixWorld);
    v3.copy(v2).sub(v1).normalize();
    // low: body space, pointing down and forward
    bodyPoint(LOW_NOZZLE, v4);
    nozD.set(0.15, -0.75, -0.6).normalize().applyQuaternion(bodyQ);
    nozP.copy(v4).lerp(v1, k);
    nozD.lerp(v3, k).normalize();
    // a hose has a length: the nozzle stays within reach of where the hose leaves the valve
    held.unit.updateMatrixWorld(true);
    const s0 = v2.fromArray(held.ud.hoseStart).applyMatrix4(held.unit.matrixWorld), maxD = held.hoseLength * held.fits.scale * 0.8;
    if (nozP.distanceTo(s0) > maxD) nozP.sub(s0).setLength(maxD).add(s0);
    nozQ.setFromUnitVectors(DOWN, nozD);
    return out.compose(nozP, nozQ, v1.setScalar(held.fits.scale));
  }
  function startAim(resolve) {
    lact = { kind: 'aim', t: 0, resolve };
    la.P0.copy(lastL.wristW); la.Q0.copy(lastL.wristQW);
    la.F0.angles.set(lastL.angles); la.F0.spread.set(lastL.spread);
  }
  function stepAim(dt) {
    const a = lact, t = (a.t += dt), h = held, noz = h.noz;
    // the nozzle in its clip (world) -> the hand closed on it
    h.unit.updateMatrixWorld(true);
    tmpM2.copy(h.unit.matrixWorld).multiply(tmpM3.compose(h.wallNozzle.p, h.wallNozzle.q, ONE));
    let P, Q;
    if (t < T_AIM.grab) {
      leftModelFor(tmpM2, la.out);
      const Pt = v1.copy(Lr.wrist).applyMatrix4(la.out), Qt = q1.setFromRotationMatrix(la.out);
      const x = span(t, 0, T_AIM.reach);
      const sx = reachS(x * 0.92 + 0.08 * minJerk(x));
      P = v2.copy(la.P0).lerp(Pt, sx).addScaledVector(UP, 0.04 * Math.sin(Math.PI * sx));
      Q = q2.copy(la.Q0).slerp(Qt, minJerk(x / 0.7));
      if (t < T_AIM.reach) mixFingers(fingersL, la.F0, OPEN_WIDE, smooth(0, 0.6, x));
      else closeFingers(fingersL, OPEN_WIDE, h.fits.fitL, span(t, T_AIM.reach, T_AIM.grab));
      fingersL.w = 1;
    } else {
      // pulled up out of the clip along the nozzle, then up and forward to aim
      noz.inHand = true;
      const xo = minJerk(span(t, T_AIM.grab, T_AIM.out));
      const up = v3.set(0, 1, 0).transformDirection(tmpM3.copy(h.unit.matrixWorld)).multiplyScalar(0.07 * xo * h.fits.scale);
      tmpM2.premultiply(tmpM3.makeTranslation(up.x, up.y, up.z));
      noz.free = span(t, T_AIM.grab + 0.06, T_AIM.out + 0.12);
      const xu = minJerk(span(t, T_AIM.out, T_AIM.up));
      if (xu > 0) {
        nozzlePlan(wantReady ? 1 : 0, nozW);
        tmpM2.decompose(v1, q1, v4);
        nozW.decompose(v2, q2, v4);
        // up and away from the unit on a gentle curve, the nozzle turning to point ahead
        v1.lerp(v2, xu).addScaledVector(UP, 0.05 * Math.sin(Math.PI * xu));
        q1.slerp(q2, xu);
        tmpM2.compose(v1, q1, v4.setScalar(h.fits.scale));
      }
      leftModelFor(tmpM2, la.out);
      P = v2.copy(Lr.wrist).applyMatrix4(la.out);
      Q = q2.setFromRotationMatrix(la.out);
      fingersL.angles.set(h.fits.fitL.angles); fingersL.spread.set(h.fits.fitL.spread); fingersL.w = 1;
    }
    if (t >= T_AIM.up) { lact = null; aimK = wantReady ? 1 : 0; a.resolve(); }
    camPoint(P, poseL.pos);
    poseL.q.copy(camQinv).multiply(Q);
    return poseL;
  }
  // put the nozzle back in its clip (before putting the unit back): the aim backwards
  function startStow(resolve) {
    lact = { kind: 'stow', t: 0, resolve };
    held.noz.free = 1;
  }
  function stepStow(dt) {
    const a = lact, t = (a.t += dt), h = held, noz = h.noz;
    h.unit.updateMatrixWorld(true);
    tmpM2.copy(h.unit.matrixWorld).multiply(tmpM3.compose(h.wallNozzle.p, h.wallNozzle.q, ONE));
    const STOW = { down: 0.55, in: 0.7, open: 0.85, back: 1.35 };
    let P, Q;
    if (t < STOW.open) {
      // from the hand's place to just above the clip, then down into it
      const xi = minJerk(span(t, STOW.down, STOW.in));
      const lift = v3.set(0, 1, 0).transformDirection(tmpM3.copy(h.unit.matrixWorld)).multiplyScalar(0.07 * (1 - xi) * h.fits.scale);
      tmpM2.premultiply(tmpM3.makeTranslation(lift.x, lift.y, lift.z));
      if (!a.N0) { a.N0 = new THREE.Matrix4().multiplyMatrices(left.model.matrixWorld, h.fits.nozzleInHand); }
      const xd = minJerk(span(t, 0, STOW.down));
      a.N0.decompose(v1, q1, v4); tmpM2.decompose(v2, q2, v4);
      v1.lerp(v2, xd).addScaledVector(UP, 0.04 * Math.sin(Math.PI * xd)); q1.slerp(q2, xd);
      tmpM2.compose(v1, q1, v4.setScalar(h.fits.scale));
      noz.free = 1 - span(t, STOW.down - 0.1, STOW.in);
      leftModelFor(tmpM2, la.out);
      P = v2.copy(Lr.wrist).applyMatrix4(la.out); Q = q2.setFromRotationMatrix(la.out);
      if (t >= STOW.in) {
        if (noz.inHand) { noz.inHand = false; ud_resetNozzle(h); }
        closeFingers(fingersL, h.fits.fitL, OPEN_WIDE, span(t, STOW.in, STOW.open));
      } else { fingersL.angles.set(h.fits.fitL.angles); fingersL.spread.set(h.fits.fitL.spread); }
      fingersL.w = 1;
      a.Pd = (a.Pd || new THREE.Vector3()).copy(P); a.Qd = (a.Qd || new THREE.Quaternion()).copy(Q);
    } else {
      const x = span(t, STOW.open, STOW.back);
      const target = lastL.down ? (q3.copy(lastL.downW.q), v3.copy(lastL.downW.pos)) : null;
      P = v2.copy(a.Pd).lerp(target ? v3 : a.Pd, minJerk(x));
      Q = q2.copy(a.Qd).slerp(target ? q3 : a.Qd, minJerk(x));
      mixFingers(fingersL, OPEN_WIDE, REST, smooth(0.2, 1, x));
      fingersL.w = 1 - smooth(0.85, 1, x);
      sL.downMix = smooth(0.8, 1, x);
    }
    if (t >= STOW.back) { lact = null; a.resolve(); }
    camPoint(P, poseL.pos);
    poseL.q.copy(camQinv).multiply(Q);
    return poseL;
  }
  function ud_resetNozzle(h) {
    h.ud.nozzle.position.copy(h.wallNozzle.p);
    h.ud.nozzle.quaternion.copy(h.wallNozzle.q);
    h.noz.free = 0;
    h.hoseKey = '';
  }

  // ---------------------------------------------------------------- per frame
  let calmR = 9, calmL = 9;          // seconds since each hand last did a job (its idle sway comes back slowly)
  function update(dt, { player, lighting } = {}) {
    time += dt;
    playerRef = player;
    body.update(dt, { pos: player.pos, yaw: player.yaw, bobPhase: player.bobPhase, bobAmp: player.bobAmp, speed: player.speed, air: player.air || 0 });
    camera.updateMatrixWorld();
    camInv.copy(camera.matrixWorld).invert();
    camera.getWorldQuaternion(camQ);
    camQinv.copy(camQ).invert();
    body.group.getWorldQuaternion(bodyQ);
    const running = player.running && player.speed > 2.7;
    const base = running ? 'run' : 'down';
    const common = { body: body.group, speed: player.speed, onGround: !(player.air > 0), bobPhase: player.bobPhase, yawVel: player.yawVel, pitchVel: player.pitchVel };
    const fresh = { target: base, fist: 0, pose: null, reachPos: null, grip: null, life: 1, rate: undefined, lag: undefined, offset: null, tension: 0, pole: null, downMix: 0, swing: 1 };
    Object.assign(sR, common, fresh);
    Object.assign(sL, common, fresh);
    if (!lastR) {
      // the first frame: let both hands find their hanging pose before anything asks where they are
      lastR = right.update(0, sR); lastL = left.update(0, sL);
    }

    // ---- squeeze: the lever follows the hand only once the pin is out and the hose is in the other hand
    const pinIn = held && !held.pinOut;
    const wantLever = held && !pinIn && !act && !lact && held.noz.inHand ? wantSqueeze : 0;
    squeeze += (wantLever - squeeze) * (1 - Math.exp(-dt * 16));
    if (squeeze < 1e-4 && wantLever === 0) squeeze = 0;
    if (held && pinIn && wantSqueeze > 0 && !act && !lact) effortT += dt; else effortT = 0;
    const effortWant = effortT > 0 ? smooth(0, 0.12, effortT) * (1 - 0.7 * smooth(0.5, 1.0, effortT)) : 0;
    effort += (effortWant - effort) * (1 - Math.exp(-dt * 14));

    // ---- right hand
    let pR = null;
    if (act && act.kind === 'take') pR = stepTake(dt, player);
    else if (act && act.kind === 'put') pR = stepPut(dt, player);
    else if (held) {
      // carrying, raised for the pin, or ready at the hip
      // all the right hand's stance blends, here, before its pose (the left hand's jobs only say what they need):
      // raised so the valve can be seen while the pin is pulled (up mostly before the other hand gets there),
      // brought in front of him while the left hand takes or stows the nozzle, ready at the hip once aimed
      const pinning = lact && lact.kind === 'pin', lt = lact ? lact.t : 0;
      if (pinning && lt < T_PIN.drop) raiseK = Math.min(1, raiseK + dt / 0.55);
      else if (!pinning) raiseK = Math.max(0, raiseK - dt * STANCE_RATE);
      const presenting = lact && ((lact.kind === 'aim' && lt < T_AIM.out) || (lact.kind === 'stow' && lt < 0.85));
      presentK = clamp(presentK + (presenting ? dt : -dt) * PRESENT_RATE, 0, 1);
      if (!pinning) {
        const want = wantReady && held.noz.inHand && presentK < 0.5 ? 1 : 0;
        readyK += clamp(want - readyK, -dt * STANCE_RATE, dt * STANCE_RATE);
      }
      carryPlan(player, stanceG, stanceQ);
      swingStep(dt, stanceG, player);
      stanceQ.multiply(swingQ);
      pR = rightPoseHolding(stanceG, stanceQ, SQUEEZE * squeeze, poseR);
      const f = held.fits;
      mixFingers(fingersR, f.fit0, f.fit1, 0.25 + 0.75 * squeeze);
      // the pin holds the lever: the fingers press, nothing gives
      if (effort > 0.001) for (let i = 0; i < 15; i++) if (i % 3) fingersR.angles[i] += 0.06 * effort;
      fingersR.w = 1;
      poleR.copy(bodyPoint(POLE_R, v2)).applyMatrix4(camInv);
    }
    calmR = pR ? 0 : calmR + dt;
    if (pR) {
      Object.assign(sR, { target: 'pose', pose: pR, rate: FOLLOW, lag: FOLLOW, life: held && !act ? 0.25 : 0, pole: poleR, grip: fingersR });
      sR.tension = held ? 0.35 + 0.5 * squeeze + 0.5 * effort : act && act.t > T.contact ? 0.35 : 0;
      if (held) sR.swing = 0.3;                 // a loaded right arm swings little; the free left arm swings as usual
    } else {
      sR.life = smooth(0.6, 1.4, calmR);
      if (fingersR.w > 0) { fingersR.w = Math.max(0, fingersR.w - dt * 4); sR.grip = fingersR; }
    }
    if (held) {
      // the unit sits in the hand as the grip and the lever say (the palm stays on the lever as it turns)
      held.ud.leverPivot.rotation.z = SQUEEZE * squeeze;
      unitInHand(held.ud.H, held.fits.scale, SQUEEZE * squeeze, tmpM).decompose(held.unit.position, held.unit.quaternion, held.unit.scale);
    }
    // recoil while discharging: a small sustained push and a fine shake, the same on both hands
    const kick = smooth(0.5, 1, squeeze) + 0.4 * effort;
    shake.set(Math.sin(time * 47) + Math.sin(time * 71.3), Math.sin(time * 53.7) + Math.sin(time * 83.1), Math.sin(time * 61.1)).multiplyScalar(0.0011 * kick);
    shake.z += 0.006 * smooth(0.5, 1, squeeze);
    if (held && pR) sR.offset = shake;
    const outR = right.update(dt, sR);
    lastR = outR;
    if (held) held.unit.updateMatrixWorld(true);

    // ---- left hand (after the right one: it works on the unit where the right hand has it now)
    let pL = null;
    if (held && (!act || act.kind === 'stowing')) {
      if (lact && lact.kind === 'pin') pL = stepPin(dt);
      else if (lact && lact.kind === 'aim') pL = stepAim(dt);
      else if (lact && lact.kind === 'stow') pL = stepStow(dt);
      else if (!act && held.pinOut && wantReady && !held.noz.inHand) { startAim(() => {}); pL = stepAim(0); }
      else if (held.noz.inHand) {
        // holding the nozzle: aimed where he looks, or low at the side
        aimK += clamp((wantReady ? 1 : 0) - aimK, -dt / 0.7, dt / 0.7);
        nozzlePlan(smooth(0, 1, aimK), nozW);
        leftModelFor(nozW, la.out);
        pL = poseFromModel(left, la.out, poseL);
        fingersL.angles.set(held.fits.fitL.angles); fingersL.spread.set(held.fits.fitL.spread); fingersL.w = 1;
      }
    }
    if (!lact && leftIdle.length) leftIdle.splice(0).forEach((f) => f());
    calmL = pL ? 0 : calmL + dt;
    if (pL) {
      Object.assign(sL, { target: 'pose', pose: pL, rate: FOLLOW, lag: FOLLOW, life: held && held.noz.inHand && !lact ? 0.2 : 0, pole: camPoint(bodyPoint(POLE_L, v2), poleL), grip: fingersL });
      if (held && held.noz.inHand && !lact) sL.offset = kickL.copy(outR.sway).add(shake);
    } else {
      sL.life = smooth(0.6, 1.4, calmL);
      if (fingersL.w > 0) { fingersL.w = Math.max(0, fingersL.w - dt * 4); sL.grip = fingersL; }
    }
    const outL = left.update(dt, sL);
    lastL = outL;
    if (held) updateHose();
    if (fallingPin) {
      const f = fallingPin;
      f.t += dt;
      f.vel.y -= 9.8 * dt;
      f.obj.position.addScaledVector(v1.copy(f.vel).applyQuaternion(q1.copy(world.getWorldQuaternion(q2)).invert()), dt);
      f.obj.rotation.x += f.spin.x * dt; f.obj.rotation.z += f.spin.z * dt;
      if (f.t > 0.7) { f.obj.visible = false; if (held) restorePin(); fallingPin = null; }
    }
    body.setArms(outR.elbow, outL.elbow);
    if (lighting) for (const hd of hands) if (hd.hair) hd.hair.setLighting(lighting);
    vm.debug.upperR = outR.elbow.distanceTo(outR.shoulder);
    vm.debug.upperL = outL.elbow.distanceTo(outL.shoulder);
    vm.busy = !!act || !!(lact && lact.kind === 'pin');
  }

  // ---------------------------------------------------------------- the old two-step take (old test pages)
  const vm = {
    update,
    materials,
    viewObjects: [right.root, left.root, ...proxies],
    body: body.group,
    holding: null,
    busy: false,
    get aimed() { return !!(held && held.noz.inHand && !lact && aimK > 0.95); },
    get pinOut() { return !!(held && held.pinOut); },
    hands: { right, left },
    debug: { upperR: 0, upperL: 0 },
    stanceFor(ext) {
      const st = stanceFor(ext);
      const look = lookAt(st.pos, st.yaw, st.grip);
      return { pos: st.pos, yaw: look.yaw, pitch: look.pitch, bodyYaw: st.yaw, grip: st.grip };
    },
    async take(ext, { player } = {}) {
      player = player || playerRef;
      if (act || held || !player) return false;
      act = { kind: 'approach' };
      const st = stanceFor(ext);
      let pos = st.pos;
      if (player.freeSpot) pos = player.freeSpot(pos);
      const look = lookAt(pos, st.yaw, st.grip, player.floorY || 0);
      const far = Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z) > 0.08 || Math.abs(Math.atan2(Math.sin(player.yaw - st.yaw), Math.cos(player.yaw - st.yaw))) > THREE.MathUtils.degToRad(10);
      if (far && player.guide) await player.guide({ pos, yaw: look.yaw, pitch: look.pitch, seconds: 0.6 });
      return new Promise((resolve) => startTake(ext, player, resolve));
    },
    async putBack({ player, instant = false } = {}) {
      player = player || playerRef;
      if (!held) return;
      if (instant || !player) {
        act = null; lact = null;
        if (player && player.release) player.release();
        detach();
        fingersR.w = fingersL.w = 0;
        return;
      }
      if (act) return;
      act = { kind: 'stowing' };
      squeeze = 0; wantSqueeze = 0; wantReady = false;
      if (lact) await new Promise((r) => leftIdle.push(r));          // let the left hand's job finish first
      if (held.noz.inHand) await new Promise((r) => startStow(r));
      const st = stanceFor(held.ext);
      let pos = st.pos;
      if (player.freeSpot) pos = player.freeSpot(pos);
      const look = lookAt(pos, st.yaw, st.grip, player.floorY || 0);
      if (player.guide && Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z) > 0.08) await player.guide({ pos, yaw: look.yaw, pitch: look.pitch, seconds: 0.6 });
      await new Promise((resolve) => startPut(player, resolve));
    },
    pullPin() {
      if (!held || held.pinOut || act || lact) return Promise.resolve();
      return new Promise((resolve) => startPin(resolve));
    },
    setReady(on) { wantReady = !!on; },
    squeeze(amount) { wantSqueeze = clamp(amount || 0, 0, 1); },
    getJet(origin, direction) {
      if (!held) return false;
      held.ud.jet.getWorldPosition(origin);
      direction.copy(DOWN).applyQuaternion(held.ud.nozzle.getWorldQuaternion(q2)).normalize();
      return true;
    },
    setHandsVisible(on) {
      handsVisible = !!on;
      right.root.visible = left.root.visible = handsVisible;
    },
    /** World-space joints for test pages (debug-take.html): wrists, elbows, shoulders, and where the handle and
     *  the hose sit in each hand (the right one is the handle's grip point when the hand is closed on it). */
    probe() {
      const fits = held ? held.fits : act && act.fits ? act.fits : lastFits;
      const o = {
        wristR: lastR.wristCam.clone().applyMatrix4(camera.matrixWorld), wristL: lastL.wristCam.clone().applyMatrix4(camera.matrixWorld),
        elbowR: lastR.elbow.clone(), elbowL: lastL.elbow.clone(), shoulderR: lastR.shoulder.clone(), shoulderL: lastL.shoulder.clone(),
      };
      if (fits) {
        o.palmR = fits.seatR.clone().applyMatrix4(right.model.matrixWorld);
        o.palmL = fits.seatL.clone().applyMatrix4(left.model.matrixWorld);
      }
      if (held) {
        o.hoseLength = held.noz.inHand && held.hoseNow ? held.hoseNow : (held.noz.inHand ? hoseCurve.getLength() : held.hoseLength) * held.fits.scale;
      }
      o.state = [raiseK, presentK, readyK, aimK, squeeze, effort].map((x) => +x.toFixed(4)).concat([act ? act.kind : '', lact ? lact.kind : '']);
      o.plan = stanceG.toArray().map((x) => +x.toFixed(5)).concat([+pend.x.toFixed(5), +pend.z.toFixed(5)]);
      // wrist bend in degrees: + when the hand is bent back (towards its back), - towards the palm
      const fore = v1.copy(lastR.wristCam).sub(lastR.elbowCam).normalize();
      const handU = v2.copy(R.u).applyQuaternion(lastR.wristQ), back = v3.copy(R.n).negate().applyQuaternion(lastR.wristQ);
      back.addScaledVector(fore, -back.dot(fore)).normalize();
      o.wristBendR = THREE.MathUtils.radToDeg(Math.atan2(handU.dot(back), handU.dot(fore)));
      return o;
    },
    reachFor() { return Promise.resolve(); },             // old two-step take (old test pages): hold() does it all
    hold(ext) {
      if (held) detach();
      const fits = fitsFor(ext);
      ext.updateWorldMatrix(true, true);
      startTake(ext, playerRef || { pos: new THREE.Vector3() }, () => {});
      act.t = T.contact; act.started = true;
      // jump the hand to the handle at once
      poseFromModel(right, tk.Mc, poseR);
      return ext.userData.unit;
    },
    release() { act = null; lact = null; return detach(); },
    /** Hair strands and draw calls this adds, for the frame counter. */
    stats() {
      return { hairStrands: hands.map((hd) => (hd.hair ? hd.hair.count : 0)), drawCalls: 2 * (2 + 10 + 1) + proxies.length };
    },
  };
  return vm;
}
