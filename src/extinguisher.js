import * as THREE from 'three';
import { gen, tex, tiled, pbr, interior, polyhaven } from './assets.js';
import { lathe, arcPoints, ribbonShape, scaleUV, shadows, canvasTexture } from './util.js';

// Body radius R and height H (base to top of the shoulder), metres.
const KINDS = {
  water: { R: 0.09, H: 0.52, gauge: true },
  powder: { R: 0.08, H: 0.47, gauge: true },
  co2: { R: 0.07, H: 0.6, gauge: false },      // a 5 kg CO2 cylinder is the tallest of the three
};
const NECK = 0.012;

let shared;
function materials() {
  if (shared) return shared;
  const dents = tiled(tex('rusty_metal_02', 'nor_gl'), 2, 2);
  const enamel = (name, cls) => interior(new THREE.MeshPhysicalMaterial({
    map: gen(`ext_${name}_diff`, cls),
    roughnessMap: gen('ext_arm', 'aux'),
    aoMap: gen('ext_arm', 'aux'),
    normalMap: dents,
    normalScale: new THREE.Vector2(0.22, 0.22),
    roughness: 1,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.14,
  }));
  const sheet = polyhaven('rusty_metal_sheet');
  shared = {
    water: enamel('water', 'hero'),
    powder: enamel('powder', 'hero'),
    co2: enamel('co2', 'hero'),
    plain: enamel('plain', 'aux'),
    chrome: interior(new THREE.MeshStandardMaterial({ color: 0xbdb0a0, metalness: 1, roughness: 0.3 })),
    steel: interior(pbr({ ...sheet, arm: null }, { color: 0xd4d1c8, roughnessMap: sheet.arm, roughness: 0.55, metalness: 0.35 })),
    rubber: interior(new THREE.MeshStandardMaterial({ color: 0x1c1b1a, roughness: 0.62, metalness: 0 })),
    plastic: interior(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.42, metalness: 0, side: THREE.DoubleSide })),
    hole: new THREE.MeshBasicMaterial({ color: 0x050505 }),
    seal: interior(new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.45 })),
    glass: interior(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, clearcoat: 1 })),
    gauge: interior(new THREE.MeshStandardMaterial({ map: gaugeFace(), roughness: 0.6 })),
  };
  return shared;
}

function gaugeFace() {
  return canvasTexture(256, 256, (c, w) => {
    const r = w / 2;
    c.fillStyle = '#f1efe6';
    c.fillRect(0, 0, w, w);
    const arc = (a0, a1, col) => {
      c.beginPath();
      c.arc(r, r, r * 0.74, a0, a1);
      c.lineWidth = r * 0.2;
      c.strokeStyle = col;
      c.stroke();
    };
    const deg = (d) => (d * Math.PI) / 180;
    arc(deg(-200), deg(-125), '#c9342c');
    arc(deg(-125), deg(-60), '#3f9b4a');
    arc(deg(-60), deg(20), '#d9b23a');
    c.fillStyle = '#333';
    c.font = `${r * 0.16}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('bar', r, r * 1.55);
    // needle resting in the green zone
    c.save();
    c.translate(r, r);
    c.rotate(deg(-12));
    c.fillStyle = '#16130f';
    c.beginPath();
    c.moveTo(-r * 0.05, r * 0.2);
    c.lineTo(0, -r * 0.78);
    c.lineTo(r * 0.05, r * 0.2);
    c.fill();
    c.restore();
    c.beginPath();
    c.arc(r, r, r * 0.1, 0, 7);
    c.fill();
  });
}

// What the printed label says, per the student guide the situation follows.
const LABELS = {
  water: { title: 'ماء', size: '٩ لتر', bar: '#b3201c', classes: [['A', 'مواد صلبة', true], ['⚡', 'كهرباء', false]], uv: [0.13, 0.45, 0.31, 0.655] },
  powder: { title: 'بودرة جافة', size: '٦ كجم', bar: '#1450b4', classes: [['A', 'مواد صلبة', true], ['B', 'سوائل', true], ['C', 'غازات', true], ['⚡', 'كهرباء', true]], uv: [0.13, 0.45, 0.31, 0.655] },
  co2: { title: 'ثاني أكسيد الكربون', size: 'CO₂ · ٥ كجم', bar: '#1b1b1d', classes: [['B', 'سوائل قابلة للاشتعال', true]], uv: [0.15, 0.43, 0.33, 0.62] },
};

/** The print on the label: a transparent curved decal that sits on the white panel of the body texture. */
function labelDecal(kind, R, H) {
  const L = LABELS[kind];
  const map = canvasTexture(1024, 1024, (c, w, h) => {
    const font = (px, weight = 700) => `${weight} ${px}px "Noto Sans Arabic", "Noto Naskh Arabic", "DejaVu Sans", sans-serif`;
    c.clearRect(0, 0, w, h);
    c.direction = 'rtl';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = L.bar;
    c.fillRect(40, 44, w - 80, 210);
    c.fillStyle = '#f4f1ea';
    c.font = font(kind === 'co2' ? 92 : 128);
    c.fillText(L.title, w / 2, 150);
    c.fillStyle = '#26221e';
    c.font = font(58, 600);
    c.fillText(`طفاية حريق · ${L.size}`, w / 2, 322);
    // fire classes: a tick for what it suits, a struck-out box for what it must not be used on
    const n = L.classes.length, bw = 170, gap = 36, x0 = w / 2 + ((n - 1) * (bw + gap)) / 2;
    L.classes.forEach(([letter, caption, ok], i) => {
      const x = x0 - i * (bw + gap), y = 500;
      c.lineWidth = 12;
      c.strokeStyle = ok ? '#1f7a3a' : '#b3201c';
      c.strokeRect(x - bw / 2, y - bw / 2, bw, bw);
      c.fillStyle = '#26221e';
      if (letter === '⚡') {
        // drawn, not typed: the glyph is missing from many fonts
        const k = bw * 0.36;
        c.beginPath();
        [[0.25, -1], [-0.55, 0.12], [-0.05, 0.12], [-0.3, 1], [0.55, -0.22], [0.05, -0.22]].forEach(([px, py], j) => (j ? c.lineTo(x + px * k, y + py * k) : c.moveTo(x + px * k, y + py * k)));
        c.fill();
      } else {
        c.font = font(104);
        c.fillText(letter, x, y + 4);
      }
      if (!ok) {
        c.beginPath();
        c.moveTo(x - bw / 2, y + bw / 2);
        c.lineTo(x + bw / 2, y - bw / 2);
        c.stroke();
      }
      c.font = font(n > 3 ? 34 : 40, 600);
      c.fillText(caption, x, y + bw / 2 + 40);
    });
    c.font = font(40, 600);
    c.fillStyle = '#26221e';
    ['١ اسحب مسمار الأمان', '٢ وجّه نحو قاعدة اللهب', '٣ اضغط المقبض', '٤ حرّك من جانب لآخر'].forEach((line, i) => c.fillText(line, w / 2, 720 + i * 62));
    c.fillStyle = 'rgba(38,34,30,0.45)';
    for (let i = 0; i < 2; i++) c.fillRect(120 + i * 60, 968 + i * 22, w - 240 - i * 120, 8);
  });
  const [u0, u1, v0, v1] = L.uv, SPIN = 0.49, full = H + NECK;
  const a0 = Math.PI * 2 * u0 - SPIN, a1 = Math.PI * 2 * u1 - SPIN, inset = 0.05;
  const span = (a1 - a0) * (1 - 2 * inset), height = (v1 - v0) * full * (1 - 2 * inset);
  const geo = new THREE.CylinderGeometry(R + 0.0007, R + 0.0007, height, 40, 1, true, Math.PI / 2 - a1 + (a1 - a0) * inset, span);
  const mat = interior(new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = ((v0 + v1) / 2) * full;
  mesh.userData.noAO = true;
  return mesh;
}

function body(R, H) {
  const rn = 0.024, sh = 0.8 * R, Hc = H - sh;
  const seam = (y) => [[R, y - 0.004], [R + 0.0013, y - 0.0015], [R + 0.0013, y + 0.0015], [R, y + 0.004]];
  const pts = [
    [0.0001, 0.012], [R * 0.75, 0.008], [R * 0.9, 0, true], [R - 0.002, 0.003], [R, 0.01],
    ...seam(0.05), ...seam(Hc - 0.012),
    ...arcPoints(rn, Hc, R - rn, sh, 0, Math.PI / 2, 16),
    [rn, H + NECK],
  ];
  pts[pts.length - 2].push(true);
  return lathe(pts, { segments: 96, vRange: [0, H + NECK] });
}

const cyl = (r, h, mat, seg = 24, rTop = r) => new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, seg), mat);
const alongX = (m) => { m.rotation.z = Math.PI / 2; return m; };
const alongZ = (m) => { m.rotation.x = Math.PI / 2; return m; };
const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

function lever(centre, half, depth, mat) {
  const g = new THREE.ExtrudeGeometry(ribbonShape(centre, half), {
    depth, bevelEnabled: true, bevelThickness: 0.0025, bevelSize: 0.002, bevelSegments: 2, curveSegments: 6,
  });
  g.translate(0, 0, -depth / 2);
  scaleUV(g, 2.2);
  return new THREE.Mesh(g, mat);
}

/**
 * A wall-mounted extinguisher. Origin at the centre of the base; +z faces the room,
 * the levers point to +x, the hose hangs on the -x side, the wall is at z = -(R + 0.02).
 *
 * The returned group holds two children: `unit` (everything you carry away) and `bracket`
 * (what stays screwed to the wall). `userData` exposes the moving parts:
 *   unit, bracket, kind, R, H, wallGap
 *   leverPivot  Group; rotate its z towards -0.22 to squeeze the top lever
 *   pin         Group with the safety pin, ring and seal; hide it once pulled
 *   nozzle      Group at the hose end; the jet leaves along its local -Y
 *   jet         Object3D at the very tip of the nozzle (child of nozzle)
 *   grip        Object3D on the carrying handle: x along the handle, y up
 *   hoseStart   [x, y, z] where the hose leaves the valve (unit space), heading -x
 *   wallHose    the control points of the hose as it hangs on the wall
 *   setHose(points)  rebuilds the hose through new control points (unit space) and
 *                    moves and turns the nozzle to its end
 */
export function makeExtinguisher(kind) {
  const { R, H, gauge } = KINDS[kind];
  const m = materials();
  const g = new THREE.Group(), unit = new THREE.Group(), bracket = new THREE.Group();
  g.add(unit, bracket);

  const shell = new THREE.Mesh(body(R, H), m[kind]);
  shell.rotation.y = 0.49;                      // turns the label to face slightly right of straight ahead
  const label = labelDecal(kind, R, H);
  unit.add(shell, label);

  // ---- valve head
  const head = new THREE.Group();
  head.position.y = H + NECK;
  head.add(
    at(cyl(0.026, 0.014, m.chrome, 6), 0, 0.007, 0),
    at(cyl(0.0175, 0.05, m.chrome), 0, 0.039, 0),
    at(cyl(0.008, 0.012, m.chrome, 12), 0, 0.068, 0),
    at(alongX(cyl(0.0125, 0.032, m.chrome)), -0.03, 0.036, 0),
    at(alongX(cyl(0.015, 0.008, m.chrome, 6)), -0.02, 0.036, 0),
  );
  if (gauge) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.0152, 40), m.gauge);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.0152, 40), m.glass);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.0158, 0.0018, 10, 40), m.chrome);
    head.add(
      at(alongZ(cyl(0.006, 0.016, m.chrome, 12)), 0, 0.036, 0.022),
      at(alongZ(cyl(0.0168, 0.011, m.chrome, 32)), 0, 0.036, 0.0345),
      at(face, 0, 0.036, 0.0402), at(glass, 0, 0.036, 0.0418), at(bezel, 0, 0.036, 0.0408),
    );
  }
  // squeeze lever on its pivot, carrying handle, safety pin with ring and tamper seal
  const PIVOT = [-0.008, 0.073];
  const leverPivot = at(new THREE.Group(), PIVOT[0], PIVOT[1], 0);
  leverPivot.add(at(
    lever([[-0.022, 0.074], [0.0, 0.081], [0.05, 0.096], [0.1, 0.111], [0.142, 0.119]], (u) => 0.0042 + 0.0022 * u, 0.026, m.plain),
    -PIVOT[0], -PIVOT[1], 0,
  ));
  const pin = new THREE.Group();
  pin.add(
    at(alongZ(cyl(0.002, 0.048, m.chrome, 8)), 0.014, 0.078, 0),
    at(new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0012, 8, 28), m.chrome), 0.014, 0.068, 0.025),
    at(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.03, 0.0012), m.seal), 0.014, 0.064, -0.0245),
  );
  head.add(
    leverPivot, pin,
    lever([[-0.012, 0.058], [0.035, 0.057], [0.085, 0.043], [0.122, 0.024], [0.14, 0.017]], (u) => 0.0042 + 0.001 * u, 0.022, m.plain),
    at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), m.plain), -0.004, 0.068, 0),
    at(alongZ(cyl(0.0042, 0.036, m.chrome, 12)), PIVOT[0], PIVOT[1], 0),
  );
  const grip = at(new THREE.Object3D(), 0.075, 0.052, 0);
  head.add(grip);
  unit.add(head);

  // ---- hose and nozzle
  const yo = H + NECK + 0.036;
  const co2 = kind === 'co2';
  const rh = co2 ? 0.009 : 0.012;
  const hoseMesh = new THREE.Mesh(new THREE.BufferGeometry(), m.rubber);
  const nozzle = new THREE.Group();
  const jet = new THREE.Object3D();
  nozzle.add(jet);
  let wallHose;
  if (co2) {
    const hx = -R - 0.036, hz = 0.03, top = H - 0.2;
    wallHose = [[-0.045, yo, 0], [-0.075, yo, 0.002], [-R - 0.05, yo - 0.045, 0.012], [hx - 0.01, H * 0.86, 0.024], [hx, top + 0.12, hz], [hx, top + 0.07, hz]];
    unit.add(at(alongX(cyl(0.011, 0.03, m.chrome, 16)), -0.058, yo, 0));
    const horn = new THREE.Mesh(lathe([[0.053, -0.265], [0.05, -0.21], [0.037, -0.11], [0.024, -0.035], [0.017, 0]], { segments: 48 }), m.plastic);
    nozzle.add(at(cyl(0.015, 0.085, m.plastic, 20), 0, -0.03, 0), at(horn, 0, -0.07, 0));
    jet.position.y = -0.335;
  } else {
    // The hose runs down the back of the left side, turns at a third of the height and comes up the front of it into
    // a holder at 60 % of the height, where the nozzle stands tip up: a hand can reach it without bending down.
    const hx = -R - rh - 0.004, hz = 0.018, hold = H * 0.6, low = H * 0.3;
    wallHose = [
      [-0.045, yo, 0], [-0.078, yo + 0.002, 0], [-R - 0.05, yo - 0.035, -0.006], [-R - 0.03, H * 0.8, -0.022],
      [-R - 0.022, low + 0.06, -0.026], [-R - 0.03, low, -0.004], [hx, low + 0.07, hz - 0.002], [hx, hold - 0.05, hz], [hx, hold, hz],
    ];
    nozzle.add(at(cyl(rh + 0.0012, 0.07, m.chrome, 20), 0, -0.02, 0), at(cyl(rh - 0.002, 0.016, m.chrome, 20, rh + 0.0012), 0, -0.063, 0));
    jet.position.y = -0.071;
    const clipY = hold - 0.03;                  // the holder grips the hose just under the nozzle
    unit.add(
      at(alongX(cyl(rh + 0.0016, 0.032, m.chrome, 20)), -0.062, yo + 0.001, 0),
      // holder: a strap round the body and a loop for the hose, with a painted bolt
      at(new THREE.Mesh(new THREE.CylinderGeometry(R + 0.0016, R + 0.0016, 0.02, 64, 1, true), m.steel), 0, clipY, 0),
      at(new THREE.Mesh(new THREE.CylinderGeometry(rh + 0.002, rh + 0.002, 0.024, 24, 1, true), m.steel), hx, clipY, hz),
      at(new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.009), m.plain), -R - 0.002, clipY + 0.012, hz + 0.012),
    );
  }
  const DOWN = new THREE.Vector3(0, -1, 0);
  const setHose = (points) => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(...p))), false, 'centripetal');
    hoseMesh.geometry.dispose();
    hoseMesh.geometry = new THREE.TubeGeometry(curve, 96, rh, 14, false);
    nozzle.position.copy(curve.getPoint(1));
    nozzle.quaternion.setFromUnitVectors(DOWN, curve.getTangent(1).normalize());
  };
  setHose(wallHose);
  unit.add(hoseMesh, nozzle);

  // ---- wall bracket
  const wz = -(R + 0.018);
  const hole = at(new THREE.Mesh(new THREE.CircleGeometry(0.007, 16), m.hole), -R * 0.82 - 0.012, -0.005, wz + 0.0023);
  bracket.add(
    at(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.11, 0.004), m.steel), -R * 0.82, 0.03, wz), hole,
    at(new THREE.Mesh(new THREE.BoxGeometry(0.032, H * 0.55, 0.004), m.steel), 0, H * 0.6, wz),
    at(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.004, R * 1.3), m.steel), -R * 0.82 + 0.03, -0.003, wz + R * 0.65),
    at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, R + 0.03), m.steel), 0, H * 0.6 + 0.11, wz + (R + 0.03) / 2),
  );
  shadows(g);
  hole.castShadow = false;
  label.castShadow = false;
  Object.assign(g.userData, {
    kind, R, H, wallGap: R + 0.02, unit, bracket, leverPivot, pin, nozzle, jet, grip, setHose, wallHose, hoseStart: [-0.045, yo, 0], hoseRadius: rh,
  });
  return g;
}
