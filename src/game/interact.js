import * as THREE from 'three';

/**
 * What the player is looking at. Targets are invisible proxy meshes; the nearest one under the
 * screen centre within its range becomes `current`.
 *
 * target: {
 *   id, proxy (Mesh, placed in the scene graph), range (metres),
 *   prompt()  → text for "E — …", or null when there is nothing to do with it now
 *   use()     → called on E / click
 *   info()    → { title, body } shown while you keep looking at it, or null
 *   onInspect() → called once the info card has been up for a moment
 * }
 */
export class Interactor {
  constructor(camera) {
    this.camera = camera;
    this.ray = new THREE.Raycaster();
    this.targets = [];
    this.current = null;
    this.dwell = 0;
    this.enabled = true;
    this.centre = new THREE.Vector2(0, 0);
    this.proxyMaterial = new THREE.MeshBasicMaterial({ visible: false });
  }

  /** Invisible box proxy, added to `parent` at `position`. */
  box(parent, size, position) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), this.proxyMaterial);
    m.position.copy(position);
    parent.add(m);
    return m;
  }

  add(target) {
    target.proxy.userData.target = target;
    this.targets.push(target);
    return target;
  }

  update(dt) {
    let found = null;
    if (this.enabled) {
      this.ray.setFromCamera(this.centre, this.camera);
      this.ray.far = 6;
      const hits = this.ray.intersectObjects(this.targets.map((t) => t.proxy), false);
      for (const h of hits) {
        const t = h.object.userData.target;
        if (h.distance <= t.range && (!t.enabled || t.enabled())) { found = t; break; }
      }
    }
    if (found !== this.current) {
      this.current = found;
      this.dwell = 0;
    } else if (found) {
      const before = this.dwell;
      this.dwell += dt;
      if (before < 0.45 && this.dwell >= 0.45 && found.onInspect) found.onInspect();
    }
    return found;
  }

  use() {
    const t = this.current;
    if (t && t.prompt && t.prompt() && t.use) t.use();
  }
}
