import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { tierName, params } from './assets.js';
import { GROUND_Y } from './building.js';
import { createStage } from './stage.js';

// The orbit viewer: look around the shed freely. The playable scenario is play.html.
const VIEWS = {
  ref: { pos: [-1.5, 1.5, 2.05], target: [0.45, 1.1, -1.7] },
  outside: { pos: [-6.0, 2.4, 8.0], target: [0, 1.25, 0] },
  aerial: { pos: [5, 15, 13], target: [0, 1, 0] },
  extinguishers: { pos: [-0.2, 1.38, 0.2], target: [-0.2, 1.3, -1.7] },
  board: { pos: [-1.15, 1.15, -0.5], target: [-1.5, 0.95, -1.7] },
  drum: { pos: [0.35, 1.2, 0.45], target: [1.3, 0.62, -0.9] },
};
const $ = (id) => document.getElementById(id);

async function init() {
  const stage = await createStage({ onProgress: (f) => { $('loadbar').style.width = `${Math.round(f * 100)}%`; } });
  const { renderer, camera, world, props } = stage;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = true;
  controls.minDistance = 0.12;
  controls.maxDistance = 70;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.zoomSpeed = 1.3;

  const toWorld = (v) => world.localToWorld(new THREE.Vector3(...v));
  let tween = null;
  function goTo(name, instant = false) {
    const v = VIEWS[name];
    if (!v) return;
    const pos = toWorld(v.pos), target = toWorld(v.target);
    if (instant) {
      camera.position.copy(pos);
      controls.target.copy(target);
      controls.update();
      return;
    }
    tween = { t: 0, p0: camera.position.clone(), p1: pos, t0: controls.target.clone(), t1: target };
  }

  goTo(params.get('view') || 'ref', true);
  await stage.finish();
  $('loading').classList.add('done');

  const clock = new THREE.Clock();
  let fpsT = 0, fpsN = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.4);
      const k = tween.t * tween.t * (3 - 2 * tween.t);
      camera.position.lerpVectors(tween.p0, tween.p1, k);
      controls.target.lerpVectors(tween.t0, tween.t1, k);
      if (tween.t >= 1) tween = null;
    }
    controls.update();
    if (camera.position.y < GROUND_Y + 0.12) camera.position.y = GROUND_Y + 0.12;
    stage.updateExposure(dt);
    props.smoke.material.uniforms.uTime.value = clock.elapsedTime;
    stage.render(dt);

    fpsN++;
    fpsT += dt;
    if (fpsT > 0.5) {
      $('fps').textContent = `${Math.round(fpsN / fpsT)} fps · ${tierName}`;
      fpsT = 0;
      fpsN = 0;
    }
  }

  window.shedDebug = {
    ...stage, controls, goTo, frame,
    // Jump to a view and draw it at its settled exposure (works while the tab is in the background).
    show(name) {
      goTo(name, true);
      stage.settleExposure();
      frame();
    },
    // Average milliseconds per frame, forcing the GPU to finish each one.
    bench(n = 20) {
      const gl = renderer.getContext(), px = new Uint8Array(4);
      frame();
      const t = performance.now();
      for (let i = 0; i < n; i++) {
        frame();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t) / n;
    },
  };
  renderer.setAnimationLoop(frame);

  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => goTo(b.dataset.view));
  $('quality').value = tierName;
  $('quality').addEventListener('change', (e) => {
    params.set('q', e.target.value);
    location.search = params.toString();
  });
  $('smokeBtn').addEventListener('click', (e) => {
    props.smoke.visible = !props.smoke.visible;
    e.currentTarget.setAttribute('aria-pressed', props.smoke.visible);
  });
  $('refBtn').addEventListener('click', (e) => {
    const on = $('ref').classList.toggle('show');
    e.currentTarget.setAttribute('aria-pressed', on);
  });
}

init().catch((err) => {
  console.error(err);
  $('loading').querySelector('div').textContent = /WebGL/i.test(err.message) ? 'هذا المتصفح لا يوفّر WebGL الآن. افتح العنوان نفسه في Chrome أو Brave، أو أعد تشغيل التطبيق.' : `تعذر تحميل المشهد: ${err.message}`;
});
