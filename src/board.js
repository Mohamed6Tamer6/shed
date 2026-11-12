import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { interior } from './assets.js';
import { canvasTexture, rng, shadows } from './util.js';

const W = 0.44, HB = 0.078, DB = 0.042, SOCKETS = 6, PITCH = 0.066, BURNT = 2;
const socketX = (i) => (i - (SOCKETS - 1) / 2) * PITCH;

/**
 * The printed face of the board. `burn` (0..1) stamps real melted, sooty plastic from the
 * user's burnt-socket photo around the overloaded socket; 0 leaves only the first scorch marks.
 */
function drawBoard(c, w, h, burn = 0, photo = null) {
  {
    const rand = rng(3);
    c.fillStyle = '#e3dccb';
    c.fillRect(0, 0, w, h);
    // yellowing, grime in the corners, fine speckle
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(120,100,60,0.10)');
    g.addColorStop(1, 'rgba(70,55,35,0.28)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = `rgba(60,45,30,${0.05 + rand() * 0.12})`;
      c.fillRect(rand() * w, rand() * h, 1 + rand() * 3, 1 + rand() * 3);
    }
    const px = w / W;
    for (let i = 0; i < SOCKETS; i++) {
      const x = w / 2 + socketX(i) * px, y = h / 2;
      c.beginPath();
      c.arc(x, y, 0.0215 * px, 0, 7);
      c.fillStyle = '#cfc7b4';
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(40,30,20,0.55)';
      c.stroke();
    }
    // scorch around the overloaded socket
    const bx = w / 2 + socketX(BURNT) * px;
    for (const [r, col] of [[0.075, 'rgba(96,58,22,0.55)'], [0.05, 'rgba(48,26,10,0.8)'], [0.03, 'rgba(8,6,5,0.95)']]) {
      const rg = c.createRadialGradient(bx, h * 0.45, 0, bx, h * 0.45, r * px);
      rg.addColorStop(0, col);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = rg;
      c.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < 60; i++) {
      c.fillStyle = `rgba(20,12,6,${0.2 + rand() * 0.4})`;
      c.beginPath();
      c.arc(bx + (rand() - 0.5) * 0.09 * px, h * 0.45 + (rand() - 0.5) * 0.07 * px, 1 + rand() * 5, 0, 7);
      c.fill();
    }
    // red rocker switch at the right-hand end
    c.fillStyle = '#b3261e';
    c.fillRect(w - 0.03 * px, h / 2 - 0.012 * px, 0.016 * px, 0.024 * px);

    if (burn > 0 && photo) {
      // Multiplying the photo of a white burnt plate over the white board keeps only its burns.
      // Three different pieces of it, feathered, centred on the socket that failed and its neighbours.
      const pieces = [[330, 150, 320, 330, 0], [40, 180, 340, 330, -1], [540, 150, 320, 330, 1], [250, 60, 380, 300, 0.5]];
      const stamp = document.createElement('canvas');
      stamp.width = stamp.height = 256;
      const s = stamp.getContext('2d');
      pieces.forEach(([sx, sy, sw, sh, offset], i) => {
        const strength = THREE.MathUtils.clamp(burn * 1.6 - Math.abs(offset) * 0.5 - (i === 3 ? 0.4 : 0), 0, 1);
        if (strength <= 0) return;
        s.globalCompositeOperation = 'source-over';
        s.fillStyle = '#fff';
        s.fillRect(0, 0, 256, 256);
        s.globalAlpha = strength;
        s.drawImage(photo, sx, sy, sw, sh, 0, 0, 256, 256);
        s.globalAlpha = 1;
        // fade to white at the rim so the stamp has no edge
        const g = s.createRadialGradient(128, 128, 60, 128, 128, 128);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(255,255,255,1)');
        s.fillStyle = g;
        s.fillRect(0, 0, 256, 256);
        const size = h * (1.15 + 0.5 * burn), x = bx + offset * PITCH * px * 1.15;
        c.globalCompositeOperation = 'multiply';
        c.drawImage(stamp, x - size / 2, h * 0.47 - size / 2, size, size);
      });
      c.globalCompositeOperation = 'source-over';
    }
  }
}

function boardTexture() {
  return canvasTexture(2048, 384, (c, w, h) => drawBoard(c, w, h));
}

function sootTexture() {
  return canvasTexture(256, 512, (c, w, h) => {
    const rand = rng(8);
    for (let i = 0; i < 46; i++) {
      const t = i / 46;
      const x = w / 2 + (rand() - 0.5) * w * (0.12 + 0.5 * t), y = h * (0.96 - 0.9 * t), r = w * (0.1 + 0.28 * t);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(12,9,7,${0.32 * (1 - t) ** 1.6 + 0.02})`);
      g.addColorStop(1, 'rgba(12,9,7,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
  });
}

/**
 * Overloaded extension board with its plugs, cables, wall switch and soot stain.
 * Origin at the centre of the board's back; the wall is the plane z = 0 and `height` its
 * distance above the floor (the cables need it to reach the ground).
 */
export function makeBoard(height) {
  const g = new THREE.Group();
  const rand = rng(21);
  const plasticWhite = interior(new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.52 }));
  const offWhite = interior(new THREE.MeshStandardMaterial({ color: 0xd9d2c0, roughness: 0.55 }));
  const black = interior(new THREE.MeshStandardMaterial({ color: 0x151414, roughness: 0.5 }));
  const cableBlack = interior(new THREE.MeshStandardMaterial({ color: 0x18171a, roughness: 0.58 }));
  const cableBeige = interior(new THREE.MeshStandardMaterial({ color: 0xb9a98a, roughness: 0.6 }));
  const charred = interior(new THREE.MeshStandardMaterial({ color: 0x1d130c, roughness: 0.95 }));
  const SOOT = new THREE.Color(0x15100c), neighbours = [];

  const body = new THREE.Mesh(new RoundedBoxGeometry(W, HB, DB, 5, 0.009), plasticWhite);
  body.position.z = DB / 2;
  g.add(body);
  // only the front face should carry the printed texture: flatten the others to a plain corner
  const uv = body.geometry.attributes.uv, nor = body.geometry.attributes.normal;
  for (let i = 0; i < uv.count; i++) if (nor.getZ(i) < 0.6) uv.setXY(i, 0.02, 0.05);

  const floorY = -height;
  for (let i = 0; i < SOCKETS; i++) {
    const x = socketX(i), burnt = i === BURNT;
    let mat = burnt ? charred : i === 4 ? offWhite : black;
    if (Math.abs(i - BURNT) === 1 || i === 4) {
      // plugs beside the fire get their own material so they can blacken as it burns
      mat = interior(mat.clone());
      mat.userData.clean = mat.color.clone();
      neighbours.push(mat);
    }
    const plug = new THREE.Group();
    plug.position.set(x, 0, DB);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.019, 0.027, 28), mat);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 0.0135;
    const relief = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0046, 0.034, 14), mat);
    relief.position.set(0, -0.03, 0.015);
    plug.add(cap, relief);
    if (burnt) {
      plug.scale.set(1.12, 0.9, 0.82);     // slumped, half melted
      plug.rotation.z = 0.25;
    }
    g.add(plug);

    // cable: hangs down the wall, lands, then wanders off across the floor
    const r = 0.0042 + rand() * 0.0016;
    const heading = -2.5 + (i / (SOCKETS - 1)) * 1.3 + (rand() - 0.5) * 0.5;      // mostly towards the door side
    const pts = [
      new THREE.Vector3(x, -0.045, DB + 0.015),
      new THREE.Vector3(x + (rand() - 0.5) * 0.03, -0.16, DB + 0.02 + rand() * 0.02),
      new THREE.Vector3(x + (rand() - 0.5) * 0.14, floorY * 0.5, 0.03 + rand() * 0.07),
      new THREE.Vector3(x + (rand() - 0.5) * 0.2, floorY + 0.09, 0.05 + rand() * 0.06),
    ];
    let px = pts[3].x + Math.cos(heading) * 0.08, pz = 0.16 + rand() * 0.06, a = heading;
    pts.push(new THREE.Vector3(px, floorY + r, pz));
    const steps = 4 + Math.floor(rand() * 3);
    for (let s = 0; s < steps; s++) {
      a += (rand() - 0.5) * 1.7;
      px += Math.cos(a) * (0.16 + rand() * 0.16);
      pz = Math.max(0.06, pz + Math.abs(Math.sin(a)) * (0.14 + rand() * 0.2));
      pts.push(new THREE.Vector3(px, floorY + r, pz));
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 180, r, 8, false), i === 1 ? cableBeige : cableBlack));
  }

  // wall switch above, its feed running up the wall and a lead down to the board
  const sw = new THREE.Group();
  sw.position.set(-0.3, 0.5, 0);
  const box = new THREE.Mesh(new RoundedBoxGeometry(0.086, 0.086, 0.016, 4, 0.004), offWhite);
  box.position.z = 0.008;
  const rocker = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.046, 0.008, 3, 0.002), offWhite);
  rocker.position.z = 0.018;
  rocker.rotation.x = 0.12;
  const conduit = new THREE.Mesh(new THREE.BoxGeometry(0.014, 1.3, 0.009), offWhite);
  conduit.position.set(0, 0.043 + 0.65, 0.0045);
  sw.add(box, rocker, conduit);
  g.add(sw);
  const lead = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.3, 0.458, 0.008), new THREE.Vector3(-0.302, 0.3, 0.007), new THREE.Vector3(-0.29, 0.1, 0.01),
    new THREE.Vector3(-0.262, 0.02, 0.02), new THREE.Vector3(-W / 2 + 0.004, 0.0, 0.022),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(lead, 60, 0.0036, 8, false), offWhite));

  shadows(g);
  const soot = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.75), new THREE.MeshBasicMaterial({ map: sootTexture(), transparent: true, depthWrite: false, toneMapped: true, color: 0x000000, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  soot.position.set(socketX(BURNT) + 0.01, 0.37, 0.0015);
  soot.userData.noAO = true;
  g.add(soot);

  g.userData.smokeOrigin = new THREE.Vector3(socketX(BURNT), 0.03, DB + 0.02);
  // How burnt the board looks, 0..1: redraws its face from the burnt-socket photo and chars the plugs next to the fire.
  const photo = new Image();
  photo.src = 'assets/fx/burnt_plate.jpg';
  let shown = 0;
  g.userData.setBurn = (level) => {
    const step = Math.round(THREE.MathUtils.clamp(level, 0, 1) * 5) / 5;
    if (step === shown || !photo.complete || !photo.naturalWidth) return;
    shown = step;
    const tex = plasticWhite.map, c = tex.image.getContext('2d');
    drawBoard(c, tex.image.width, tex.image.height, step, photo);
    tex.needsUpdate = true;
    neighbours.forEach((m) => m.color.copy(m.userData.clean).lerp(SOOT, step * 0.75));
  };
  return g;
}
