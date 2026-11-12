import * as THREE from 'three';
import { gen, pbr, interior, polyhaven } from './assets.js';
import { lathe, gridNormals, fbm, shadows } from './util.js';

const R = 0.2925, H = 0.88, SEG = 144;

/** A dented 200 litre steel drum. Origin at the centre of its base. */
export function makeDrum() {
  const mat = interior(pbr({ map: gen('drum_diff', 'hero'), normalMap: gen('drum_nor', 'aux'), arm: gen('drum_arm', 'aux') }));
  const hoop = (y) => [[R, y - 0.026], [R + 0.006, y - 0.014], [R + 0.011, y], [R + 0.006, y + 0.014], [R, y + 0.026]];
  const side = lathe([
    [R - 0.01, 0], [R + 0.004, 0.001], [R + 0.0065, 0.008], [R + 0.003, 0.017], [R, 0.024],
    ...hoop(H / 3), ...hoop((2 * H) / 3),
    [R, H - 0.024], [R + 0.003, H - 0.017], [R + 0.0065, H - 0.008], [R + 0.004, H - 0.001],
    [R - 0.004, H, true], [R - 0.012, H - 0.005, true], [R - 0.012, H - 0.022],
  ], { segments: SEG, uRepeat: 2, vRange: [0, H] });

  // Dents: a slow wobble of the whole shell plus a few knocks.
  const knocks = [[0.9, 0.52, 0.016, 0.11], [2.6, 0.2, 0.012, 0.08], [4.4, 0.7, 0.014, 0.1], [5.5, 0.4, 0.008, 0.07]];
  const pos = side.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y < 0.03 || y > H - 0.03) continue;
    const r = Math.hypot(x, z), a = Math.atan2(z, x);
    let dr = 0.0028 * fbm(Math.cos(a) * 2.1, y * 3.2, Math.sin(a) * 2.1, 3);
    for (const [ka, ky, depth, size] of knocks) {
      let da = Math.abs(a - ka + Math.PI * 2) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      dr -= depth * Math.exp(-((da * R) ** 2 + (y - ky) ** 2) / (size * size));
    }
    pos.setXYZ(i, (x * (r + dr)) / r, y, (z * (r + dr)) / r);
  }
  gridNormals(side, SEG + 1);

  const g = new THREE.Group();
  g.add(new THREE.Mesh(side, mat));
  const lid = new THREE.Mesh(new THREE.CircleGeometry(R - 0.012, 72).rotateX(-Math.PI / 2), mat);
  lid.position.y = H - 0.022;
  g.add(lid);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.62, 0.004, 8, 72).rotateX(Math.PI / 2), mat);
  ring.position.y = H - 0.0225;
  ring.scale.y = 0.6;
  g.add(ring);

  const sheet = polyhaven('rusty_metal_sheet');
  const zinc = interior(pbr({ ...sheet, arm: null }, { color: 0xb9b2a4, roughnessMap: sheet.arm, roughness: 0.65, metalness: 0.7 }));
  const bung = (x, z, r) => {
    const b = new THREE.Group();
    b.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.012, 32), zinc));
    const plug = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.012, 6), zinc);
    plug.position.y = 0.008;
    b.add(plug);
    b.position.set(x, H - 0.016, z);
    return b;
  };
  g.add(bung(0.165, 0.04, 0.036), bung(-0.15, -0.07, 0.02));
  return shadows(g);
}
