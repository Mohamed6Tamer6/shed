import * as THREE from 'three';
import { X, Z, T, DOOR, GROUND_Y } from '../building.js';

const EYE = 1.64, RADIUS = 0.27, WALK = 1.9, RUN = 3.8, LIMIT = 12.5;
const GUIDE_SPEED = 1.4;                // fastest a guided walk goes (m/s)
const NUDGE = 0.06;                     // how far the mouse may turn a guided view (rad, about 3.4 degrees)
const minJerk = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (10 + x * (6 * x - 15)));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Guided mode, shared by Player and the test pages' stand-ins (anything with pos, yaw, pitch, vel, speed).
 *
 *   guide.start({ pos, yaw, pitch, seconds }) -> Promise<boolean>
 *       eases position (x, z) and view to the targets given (minimum-jerk; position at 1.4 m/s at most), then
 *       holds them. Fields left out are not driven: without yaw and pitch the mouse turns the view as usual;
 *       without pos the player stays where he is. Movement keys do nothing while a guide runs. The mouse can
 *       nudge a guided view by a few degrees. Resolves true on arrival, false when replaced or released first.
 *   guide.release()   ends it; the view keeps the nudge (nothing snaps)
 *   guide.step(dt, dyaw, dpitch) -> true while it drives the player (call from the player's own update)
 */
export class Guide {
  constructor(player) {
    this.p = player;
    this.g = null;
    this.prev = new THREE.Vector3();
  }

  get active() { return !!this.g; }

  start({ pos = null, yaw = null, pitch = null, seconds = 0 } = {}) {
    const p = this.p;
    if (this.g && !this.g.done) this.g.resolve(false);
    const g = {
      t: 0, done: false, resolve: null, nudgeYaw: 0, nudgePitch: 0,
      p0: p.pos.clone(), p1: pos ? new THREE.Vector3(pos.x, p.pos.y, pos.z) : null,
      y0: p.yaw, y1: yaw, x0: p.pitch, x1: pitch,
    };
    // the base view the nudge is added to: where the player looks now
    g.baseYaw = p.yaw; g.basePitch = p.pitch;
    const d = g.p1 ? Math.hypot(g.p1.x - g.p0.x, g.p1.z - g.p0.z) : 0;
    const turn = Math.max(yaw === null ? 0 : Math.abs(wrapAngle(yaw - p.yaw)), pitch === null ? 0 : Math.abs(pitch - p.pitch));
    g.T = Math.max(seconds, (1.875 * d) / GUIDE_SPEED, turn / 3.0, 1e-3);
    this.prev.copy(p.pos);
    this.g = g;
    return new Promise((resolve) => { g.resolve = resolve; });
  }

  release() {
    const g = this.g;
    if (!g) return;
    if (!g.done) g.resolve(false);
    this.g = null;
  }

  step(dt, dyaw, dpitch) {
    const g = this.g, p = this.p;
    if (!g) return false;
    g.t += dt;
    const s = minJerk(g.t / g.T);
    if (g.p1) {
      this.prev.copy(p.pos);
      p.pos.x = g.p0.x + (g.p1.x - g.p0.x) * s;
      p.pos.z = g.p0.z + (g.p1.z - g.p0.z) * s;
      if (dt > 0) p.vel.set((p.pos.x - this.prev.x) / dt, (p.pos.z - this.prev.z) / dt);
    } else p.vel.set(0, 0);
    if (g.y1 !== null || g.x1 !== null) {
      g.nudgeYaw = THREE.MathUtils.clamp(g.nudgeYaw + dyaw, -NUDGE, NUDGE);
      g.nudgePitch = THREE.MathUtils.clamp(g.nudgePitch + dpitch, -NUDGE, NUDGE);
      if (g.y1 !== null) p.yaw = g.y0 + wrapAngle(g.y1 - g.y0) * s + g.nudgeYaw; else p.yaw += dyaw;
      if (g.x1 !== null) p.pitch = THREE.MathUtils.clamp(g.x0 + (g.x1 - g.x0) * s + g.nudgePitch, -1.35, 1.3); else p.pitch = THREE.MathUtils.clamp(p.pitch + dpitch, -1.35, 1.3);
    } else {
      p.yaw += dyaw;
      p.pitch = THREE.MathUtils.clamp(p.pitch + dpitch, -1.35, 1.3);
    }
    p.speed = p.vel.length();
    if (!g.done && g.t >= g.T) { g.done = true; g.resolve(true); }
    return true;
  }
}

/**
 * First-person walker. Lives in shed space (the `world` group): the camera is parented to that
 * group, so `pos` and `yaw` are in the same frame as every prop. Collides with axis-aligned
 * boxes [minX, minZ, maxX, maxZ] and circles { x, z, r }.
 *
 * Field names (pos, yaw, pitch, vel, speed, running, bobPhase, bobAmp, yawVel, pitchVel, air)
 * match the walker of the old `world` project so its hand animation can read them unchanged.
 */
export class Player {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.pos = new THREE.Vector3(-1.0, 0, 0.95);
    this.yaw = 0;                       // 0 looks down -z (at the back wall)
    this.pitch = -0.05;
    this.vel = new THREE.Vector2();
    this.speed = 0;
    this.running = false;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.yawVel = 0;
    this.pitchVel = 0;
    this.air = 0;
    this.moved = false;
    this.locked = false;
    this.frozen = false;                // menus and cards stop movement and looking
    this.boxes = [];
    this.circles = [];
    this.keys = new Set();
    this.mdx = 0;
    this.mdy = 0;
    this.floorY = 0;
    this.sensitivity = 0.0021;
    this.onLockChange = () => {};
    this.guided = new Guide(this);

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (!this.locked || this.frozen) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      if (!this.locked) this.keys.clear();
      this.onLockChange(this.locked);
    });
  }

  lock() {
    const p = this.dom.requestPointerLock?.();
    if (p && p.catch) p.catch(() => {});
  }

  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  key(...codes) { return codes.some((c) => this.keys.has(c)); }

  /** Forward direction on the floor, in shed space. */
  forward(target = new THREE.Vector3()) { return target.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  lookAtPoint(p) {
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(p.y - (this.floorY + EYE), Math.hypot(dx, dz));
  }

  /** Guided mode (see Guide): walks and turns the player to a stance; movement keys wait until release(). */
  guide(opts) { return this.guided.start(opts); }
  release() { this.guided.release(); }

  /** The nearest spot to `p` (shed space, x and z) where the player can stand, as collide() would leave him. */
  freeSpot(p) {
    const keep = this.pos.clone();
    this.pos.set(p.x, this.pos.y, p.z);
    this.collide();
    const out = this.pos.clone();
    this.pos.copy(keep);
    return out;
  }

  collide() {
    const p = this.pos;
    for (let pass = 0; pass < 2; pass++) {
      for (const [x0, z0, x1, z1] of this.boxes) {
        const cx = THREE.MathUtils.clamp(p.x, x0, x1), cz = THREE.MathUtils.clamp(p.z, z0, z1);
        let dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RADIUS * RADIUS) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2), push = (RADIUS - d) / d;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          // centre is inside the box: leave by the nearest face
          const l = p.x - x0, r = x1 - p.x, b = p.z - z0, f = z1 - p.z, m = Math.min(l, r, b, f);
          if (m === l) p.x = x0 - RADIUS; else if (m === r) p.x = x1 + RADIUS; else if (m === b) p.z = z0 - RADIUS; else p.z = z1 + RADIUS;
        }
      }
      for (const c of this.circles) {
        const dx = p.x - c.x, dz = p.z - c.z, min = RADIUS + c.r;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 1e-6) {
          p.x += (dx / d) * (min - d);
          p.z += (dz / d) * (min - d);
        }
      }
    }
    const d = Math.hypot(p.x, p.z);
    if (d > LIMIT) { p.x *= LIMIT / d; p.z *= LIMIT / d; }
  }

  /** Floor height under a point: the slabs of the shed and apron sit a step above the yard. */
  groundAt(x, z) {
    const onShed = Math.abs(x) < X + T + 0.12 && Math.abs(z) < Z + T + 0.12;
    const onApron = x > DOOR.x0 - 0.25 && x < DOOR.x1 + 0.25 && z > 0 && z < Z + T + 0.7;
    let y = onShed || onApron ? 0 : GROUND_Y;
    for (const [x0, z0, x1, z1] of this.raised || []) if (x > x0 && x < x1 && z > z0 && z < z1) y = 0;
    return y;
  }

  update(dt) {
    const dyaw = this.frozen ? 0 : -this.mdx * this.sensitivity, dpitch = this.frozen ? 0 : -this.mdy * this.sensitivity;
    this.mdx = this.mdy = 0;
    const yaw0 = this.yaw, pitch0 = this.pitch;

    if (this.guided.step(dt, dyaw, dpitch)) {
      // guided (taking or putting back an extinguisher): no walking of his own, no collisions (the stance is free)
      this.running = false;
    } else {
      this.yaw += dyaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dpitch, -1.35, 1.3);
      let f = 0, r = 0;
      if (!this.frozen && this.locked) {
        f = (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0);
        r = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0);
      }
      this.running = f > 0 && this.key('ShiftLeft', 'ShiftRight') && !this.slow;
      const max = this.slow ? WALK * 0.75 : this.running ? RUN : WALK;
      const want = new THREE.Vector2(-Math.sin(this.yaw) * f + Math.cos(this.yaw) * r, -Math.cos(this.yaw) * f - Math.sin(this.yaw) * r);
      if (want.lengthSq() > 0) {
        want.multiplyScalar(max / Math.max(1, want.length()));
        this.moved = true;
      }
      this.vel.lerp(want, 1 - Math.exp(-dt * 8));
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.y * dt;
      this.collide();
    }
    const dy = wrapAngle(this.yaw - yaw0), dp = this.pitch - pitch0;
    this.yawVel += (dy / Math.max(dt, 1e-3) - this.yawVel) * Math.min(1, dt * 10);
    this.pitchVel += (dp / Math.max(dt, 1e-3) - this.pitchVel) * Math.min(1, dt * 10);

    this.speed = this.vel.length();
    this.bobPhase += dt * this.speed * 2.9;
    this.bobAmp += (Math.min(this.speed / 3.6, 1) - this.bobAmp) * Math.min(1, dt * 6);
    this.floorY += (this.groundAt(this.pos.x, this.pos.z) - this.floorY) * Math.min(1, dt * 12);
    this.pos.y = this.floorY;

    const cam = this.camera;
    cam.position.set(
      this.pos.x + Math.cos(this.yaw) * Math.sin(this.bobPhase) * 0.011 * this.bobAmp,
      this.floorY + EYE + Math.cos(this.bobPhase * 2) * 0.024 * this.bobAmp,
      this.pos.z - Math.sin(this.yaw) * Math.sin(this.bobPhase) * 0.011 * this.bobAmp,
    );
    cam.rotation.set(this.pitch, this.yaw, Math.sin(this.bobPhase) * 0.0035 * this.bobAmp, 'YXZ');
  }
}
