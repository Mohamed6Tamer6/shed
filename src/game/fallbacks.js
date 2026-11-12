import * as THREE from 'three';
import { VIEW_LAYER } from '../stage.js';

// Plain stand-ins with the same interfaces as characters.js, viewmodel.js and fx.js.
// play.js uses one whenever the real module is missing or fails to load, so the scenario
// stays playable.

const SHIRTS = { mahmoud: 0x8b8f93, fathy: 0xc9b48e, karim: 0x9cc3e6 };

/** A simple figure (capsule body, head) that can walk a path and turn to face things. */
export class SimpleCharacter {
  constructor(name) {
    this.name = name;
    this.group = new THREE.Group();
    this.height = { mahmoud: 1.75, fathy: 1.68, karim: 1.8 }[name] || 1.75;
    const skin = new THREE.MeshStandardMaterial({ color: 0xb98a63, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: SHIRTS[name] || 0x888888, roughness: 0.85 });
    const legs = new THREE.MeshStandardMaterial({ color: 0x2c3442, roughness: 0.9 });
    this.materials = [skin, shirt, legs];
    const h = this.height;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, h * 0.3, 6, 16), shirt);
    torso.position.y = h * 0.68;
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, h * 0.36, 6, 16), legs);
    lower.position.y = h * 0.28;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 16), skin);
    this.head.position.y = h - 0.11;
    this.arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.5, 4, 10), shirt);
    this.arm.geometry.translate(0, -0.27, 0);
    this.arm.position.set(-0.24, h * 0.8, 0);
    this.group.add(torso, lower, this.head, this.arm);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.moving = false;
    this.action = 'idle';
    this.path = null;
    this.face = null;
    this.point = null;
    this.t = 0;
  }

  setAction(name) { this.action = name; }
  pointAt(p) { this.point = p ? p.clone() : null; }
  lookAt() {}
  faceTowards(p) { this.face = p.clone(); }
  headWorldPosition(target = new THREE.Vector3()) { return this.head.getWorldPosition(target); }

  walkTo(points, { run = false, onArrive } = {}) {
    this.path = { points: points.map((p) => p.clone()), i: 0, speed: run ? 3.4 : 1.4, onArrive };
    this.moving = true;
    this.action = run ? 'run' : 'walk';
  }

  turn(dt, dx, dz) {
    const want = Math.atan2(dx, dz);
    let d = want - this.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.group.rotation.y += THREE.MathUtils.clamp(d, -4 * dt, 4 * dt);
  }

  update(dt) {
    this.t += dt;
    const g = this.group;
    if (this.path) {
      const target = this.path.points[this.path.i];
      const dx = target.x - g.position.x, dz = target.z - g.position.z, d = Math.hypot(dx, dz);
      const step = this.path.speed * dt;
      if (d <= step) {
        g.position.x = target.x;
        g.position.z = target.z;
        if (++this.path.i >= this.path.points.length) {
          const done = this.path.onArrive;
          this.path = null;
          this.moving = false;
          this.action = 'idle';
          if (done) done();
        }
      } else {
        g.position.x += (dx / d) * step;
        g.position.z += (dz / d) * step;
        this.turn(dt, dx, dz);
      }
      g.position.y = Math.abs(Math.sin(this.t * this.path?.speed * 3 || 0)) * 0.03;
    } else if (this.face) {
      const p = g.parent ? g.parent.worldToLocal(this.face.clone()) : this.face;
      this.turn(dt, p.x - g.position.x, p.z - g.position.z);
    }
    this.arm.rotation.x = this.point ? -1.45 : this.action === 'alarm' ? -0.5 + Math.sin(this.t * 6) * 0.3 : Math.sin(this.t * 1.3) * 0.04;
  }
}

/** Holds the extinguisher in view without hands (same interface as viewmodel.js: take, putBack, pullPin ...). */
export function createSimpleViewModel({ camera }) {
  const rig = new THREE.Group();
  camera.add(rig);
  let ext = null, ready = 0, wantReady = false, squeeze = 0, pinAnim = null, reach = null, pinOut = false;
  const q = new THREE.Quaternion(), down = new THREE.Vector3(0, -1, 0);
  const vm = {
    materials: [],
    viewObjects: [rig],
    body: null,
    holding: null,
    busy: false,
    get aimed() { return !!ext && pinOut && ready > 0.95; },
    get pinOut() { return !!ext && pinOut; },
    /** Takes `ext` off the wall after a short pause (no hands to show); resolves true. */
    take(e) {
      if (ext || vm.busy) return Promise.resolve(false);
      vm.busy = true;
      return new Promise((resolve) => { reach = { t: 0.25, resolve: () => { vm.busy = false; vm.hold(e); resolve(true); } }; });
    },
    /** Hangs the unit back on its bracket as it was (pin in, hose clipped). */
    putBack() {
      if (!ext) return Promise.resolve();
      const e = ext, unit = vm.release();
      e.add(unit);
      unit.traverse((o) => { o.layers.set(0); });
      e.userData.setHose(e.userData.wallHose);
      e.userData.leverPivot.rotation.z = 0;
      e.userData.pin.position.set(0, 0, 0);
      e.userData.pin.visible = true;
      return Promise.resolve();
    },
    reachFor() { return new Promise((resolve) => { reach = { t: 0.25, resolve }; }); },
    hold(e) {
      ext = e;
      vm.holding = e;
      const unit = e.userData.unit;
      rig.add(unit);
      unit.scale.setScalar(e.scale.x);
      unit.traverse((o) => { o.layers.set(VIEW_LAYER); o.receiveShadow = true; o.castShadow = false; });
      ready = 0;
      pinOut = !e.userData.pin.visible;
      vm.place();
    },
    place() {
      const unit = ext.userData.unit, s = unit.scale.x, top = (ext.userData.H + 0.07) * s;
      const k = ready * ready * (3 - 2 * ready);
      unit.position.set(0.3 - 0.04 * k, -0.34 - top + 0.1 * k, -0.52);
      unit.rotation.set(0.12, -Math.PI / 2 + 0.35, 0.1 - 0.05 * k);
      // hose: from the valve round to a point in front of the left side of the body, aimed ahead
      const end = new THREE.Vector3(-0.1, -0.2 + 0.07 * k, -0.62), aim = new THREE.Vector3(-0.02, -0.16 + 0.1 * k, -1.2);
      unit.updateMatrix();
      const inv = unit.matrix.clone().invert();
      const a = new THREE.Vector3(...ext.userData.hoseStart);
      const b = end.clone().applyMatrix4(inv), c = aim.clone().applyMatrix4(inv);
      const dir = c.clone().sub(b).normalize();
      const mid1 = a.clone().add(new THREE.Vector3(-0.07, 0.0, 0)), mid2 = b.clone().addScaledVector(dir, -0.16);
      mid2.y -= 0.03;
      const sag = a.clone().lerp(b, 0.5);
      sag.y -= 0.1;
      ext.userData.setHose([a, mid1, sag, mid2, b.clone().addScaledVector(dir, -0.05), b]);
    },
    release() {
      const unit = ext.userData.unit;
      rig.remove(unit);
      unit.traverse((o) => { o.layers.set(0); o.castShadow = true; });
      unit.position.set(0, 0, 0);
      unit.rotation.set(0, 0, 0);
      unit.scale.setScalar(1);
      ext = null;
      vm.holding = null;
      return unit;
    },
    setReady(on) { wantReady = on; },
    pullPin() {
      if (!ext || pinOut || pinAnim) return Promise.resolve();
      vm.busy = true;
      return new Promise((resolve) => { pinAnim = { t: 0, resolve }; });
    },
    squeeze(a) { squeeze = a; },
    getJet(origin, direction) {
      if (!ext) return false;
      ext.userData.jet.getWorldPosition(origin);
      ext.userData.nozzle.getWorldQuaternion(q);
      direction.copy(down).applyQuaternion(q);
      return true;
    },
    setHandsVisible() {},
    update(dt) {
      if (reach && (reach.t -= dt) <= 0) { const r = reach; reach = null; r.resolve(); }
      if (!ext) return;
      const r0 = ready;
      // the hose comes up only once the pin is out, as with hands
      ready = THREE.MathUtils.clamp(ready + (wantReady && pinOut ? dt : -dt) * 3.5, 0, 1);
      if (r0 !== ready) vm.place();
      // with the pin in the lever does not move
      ext.userData.leverPivot.rotation.z = pinOut ? -0.22 * squeeze : 0;
      if (pinAnim) {
        pinAnim.t += dt / 0.6;
        const pin = ext.userData.pin;
        pin.position.z = Math.min(1, pinAnim.t * 1.6) * 0.08;
        if (pinAnim.t >= 1) {
          pin.visible = false;
          pin.position.z = 0;
          pinOut = true;
          vm.busy = false;
          pinAnim.resolve();
          pinAnim = null;
        }
      }
    },
  };
  return vm;
}

/** Bare-minimum effects: a glowing sprite and a light for fire, a cone of dots for the discharge. */
export function createSimpleFx({ scene, noAO }) {
  const lights = [new THREE.PointLight(0xff8a3a, 0, 5, 2), new THREE.PointLight(0xff8a3a, 0, 9, 2)];
  scene.add(...lights);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 40, 2, 32, 36, 30);
  grad.addColorStop(0, 'rgba(255,240,180,1)');
  grad.addColorStop(0.4, 'rgba(255,140,40,0.8)');
  grad.addColorStop(1, 'rgba(255,60,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const glow = new THREE.CanvasTexture(c);
  const fires = [], jets = [];
  let time = 0;
  const makeFire = (parent, position, height, width, light) => {
    const mat = new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(3, 2.2, 1.4) });
    const s = new THREE.Sprite(mat);
    s.center.set(0.5, 0.15);
    s.position.copy(position);
    parent.add(s);
    noAO.push(s);
    const f = { intensity: 0, height, width, sprite: s, light: lights[light] || null, setSize(h, w) { f.height = h; f.width = w; }, dispose() { parent.remove(s); fires.splice(fires.indexOf(f), 1); } };
    fires.push(f);
    return f;
  };
  return {
    ambient: 0.2,
    lights,
    update(dt, t) {
      time = t;
      for (const f of fires) {
        const k = f.intensity * (0.85 + 0.15 * Math.sin(time * 23) * Math.sin(time * 7.1));
        f.sprite.visible = k > 0.01;
        f.sprite.scale.set(f.width * 2.2 * (0.6 + 0.4 * k), f.height * 1.6 * k + 0.001, 1);
        if (f.light) {
          f.sprite.getWorldPosition(f.light.position);
          f.light.position.y += f.height * 0.5;
          f.light.intensity = 1.2 * k;
        }
      }
      for (const j of jets) j.points.visible = j.active;
    },
    addFire({ parent, position, height = 0.35, width = 0.25, light = 0 }) { return makeFire(parent, position, height, width, light); },
    addStrawBlaze({ parent, points, light = 1 }) {
      const parts = points.map((p, i) => makeFire(parent, p, 1.2, 0.7, i === 0 ? light : -1));
      const b = { dispose() { parts.forEach((p) => p.dispose()); } };
      Object.defineProperty(b, 'intensity', { get: () => parts[0].intensity, set: (v) => parts.forEach((p) => { p.intensity = v; }) });
      return b;
    },
    createDischarge(kind) {
      const N = 60, pos = new Float32Array(N * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: kind === 'water' ? 0.02 : 0.07, color: kind === 'water' ? 0x9fc6e6 : 0xdedccf, transparent: true, opacity: 0.55, depthWrite: false }));
      points.frustumCulled = false;
      points.visible = false;
      scene.add(points);
      noAO.push(points);
      const j = {
        active: false, points,
        setEmitter(o, d) {
          for (let i = 0; i < N; i++) {
            const t = ((i / N + time * 2.5) % 1) * 2.6, spread = t * (kind === 'water' ? 0.03 : 0.16);
            pos[i * 3] = o.x + d.x * t + Math.sin(i * 12.9) * spread;
            pos[i * 3 + 1] = o.y + d.y * t + Math.sin(i * 78.2) * spread - t * t * 0.06;
            pos[i * 3 + 2] = o.z + d.z * t + Math.sin(i * 37.7) * spread;
          }
          geo.attributes.position.needsUpdate = true;
        },
        setTarget() {},
        start() { j.active = true; },
        stop() { j.active = false; },
        dispose() { scene.remove(points); },
      };
      jets.push(j);
      return j;
    },
    audio: { unlock() {}, fire() {}, discharge() {}, alarmShout() {} },
  };
}
