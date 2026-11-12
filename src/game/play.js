import * as THREE from 'three';
import { manager, tierName, params } from '../assets.js';
import { SHED_COLLIDERS, X, Z, T, DOOR } from '../building.js';
import { createStage } from '../stage.js';
import { Player } from './player.js';
import { Interactor } from './interact.js';
import { createUI } from './ui.js';
import { createScenario } from './scenario.js';
import { SimpleCharacter, createSimpleViewModel, createSimpleFx } from './fallbacks.js';

// The playable SAF-01 situation: first person, in the shed built by stage.js.

const ui = createUI();

/** Loads an optional module; the scenario still runs on a plain stand-in when it is missing or broken. */
async function optional(path, what) {
  if (params.get('plain') === '1' || params.get(`no${what}`) === '1') return null;
  try {
    return await import(path);
  } catch (err) {
    console.warn(`[play] ${what} unavailable, using the plain stand-in:`, err.message);
    return null;
  }
}

async function init() {
  const stage = await createStage({ office: true, onProgress: (f) => ui.progress(f * 0.9) });
  const { renderer, scene, camera, world, props } = stage;
  camera.fov = 66;
  camera.near = 0.04;
  camera.updateProjectionMatrix();
  world.add(camera);                                   // the player moves in shed space

  // ---- player and what stops him
  const player = new Player(camera, renderer.domElement);
  player.yaw = -0.33;                                  // facing the board, with Uncle Fathy in view on the right
  const office = props.office;
  const doorLeaf = [0.25, 0.6, 0.95, 1.25].map((d) => ({ x: DOOR.x0 + 0.075 - 0.375 * d, z: Z + T + 0.93 * d, r: 0.07 }));
  player.boxes = [
    ...SHED_COLLIDERS,
    [0.52, -Z, 1.56, -0.98],                           // sack stack
    [1.25, -Z, X, -0.8],                               // straw heap in the corner
    ...(office ? office.colliders : []),
  ];
  const npcCircles = [{ x: 0, z: 0, r: 0.24 }, { x: 0, z: 0, r: 0.24 }, { x: 0, z: 0, r: 0.24 }];
  player.circles = [{ x: props.drum.position.x, z: props.drum.position.z, r: 0.31 }, ...doorLeaf, ...npcCircles];
  if (office) {
    const c = office.colliders;
    player.raised = [[Math.min(...c.map((b) => b[0])) - 0.1, Math.min(...c.map((b) => b[1])) - 0.1, Math.max(...c.map((b) => b[2])) + 0.1, Math.max(...c.map((b) => b[3])) + 0.1]];
  }

  // ---- the three optional parts
  const [fxMod, chMod, vmMod] = await Promise.all([
    optional('./fx.js', 'fx'), optional('./characters.js', 'characters'), optional('./viewmodel.js', 'hands'),
  ]);
  const fx = fxMod ? fxMod.createFx({ scene, camera, renderer, noAO: stage.noAO }) : createSimpleFx({ scene, noAO: stage.noAO });
  let npcs;
  try {
    npcs = chMod ? await chMod.loadCharacters(manager) : null;
  } catch (err) {
    console.warn('[play] characters failed to load:', err);
  }
  if (!npcs) npcs = { mahmoud: new SimpleCharacter('mahmoud'), fathy: new SimpleCharacter('fathy'), karim: new SimpleCharacter('karim') };
  let vm = null;
  try {
    vm = vmMod ? await vmMod.createViewModel({ camera, world, manager }) : null;
  } catch (err) {
    console.warn('[play] hands failed to load:', err);
  }
  if (!vm) vm = createSimpleViewModel({ camera });

  // ---- input
  const handlers = new Map(), clicks = [];
  const input = {
    mouseDown: false,
    on(code, fn) { handlers.set(code, fn); },
    onClick(fn) { clicks.push(fn); },
  };
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (ui.key(e.code)) { e.preventDefault(); return; }
    if (ui.modal || !player.locked) return;
    const h = handlers.get(e.code);
    if (h) h();
  });
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !player.locked || ui.modal) return;
    input.mouseDown = true;
    clicks.forEach((fn) => fn());
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) input.mouseDown = false; });
  addEventListener('contextmenu', (e) => e.preventDefault());

  const interact = new Interactor(camera);
  const scenario = createScenario({ stage, player, ui, interact, npcs, fx, vm, input });

  // Menus and cards need the pointer; the game takes it back when they close.
  let started = false;
  ui.onModalChange = (on) => {
    player.frozen = on;
    input.mouseDown = false;
    if (on) player.unlock();
    else if (started) player.lock();
    ui.resumeOverlay(false);
  };
  player.onLockChange = (locked) => {
    if (!locked) input.mouseDown = false;
    ui.resumeOverlay(started && !locked && !ui.modal);
  };
  ui.onResumeClick(() => player.lock());

  // ---- light the newcomers, then bake the room light without them in it
  const dynamic = [...Object.values(npcs).map((n) => n.group), ...vm.viewObjects, ...(vm.body ? [vm.body] : [])];
  if (fx.ready) await fx.ready;
  await stage.finish(dynamic);
  stage.refreshInteriorEnv();
  player.update(0);
  stage.settleExposure();
  ui.progress(1);
  ui.loaded();

  // ---- frame loop
  const clock = new THREE.Clock();
  const eye = new THREE.Vector3(), tmp = new THREE.Vector3();
  const lighting = { ambient: new THREE.Color(), keyDir: new THREE.Vector3(), keyColor: new THREE.Color() };
  const sunDir = stage.sunInfo.direction.clone(), sunColor = stage.sunInfo.colour.clone().multiplyScalar(stage.sunInfo.intensity / Math.PI);
  const doorDir = new THREE.Vector3(0.1, 0.25, 1).normalize().transformDirection(world.matrixWorld);
  const DOOR_GLOW = new THREE.Color(0.34, 0.31, 0.27);
  let fpsT = 0, shadowTick = 0, wasMoving = false;

  const gov = { on: params.get('adapt') !== '0', scale: 1, ao: true, slow: 0, fast: 0, ms: 16, last: performance.now() };
  let time = 0;
  /** One frame. Pass `step` to advance by a fixed time instead of the real clock; `draw: false` skips rendering. */
  function frame(step, draw = true) {
    const dt = typeof step === 'number' ? step : Math.min(clock.getDelta(), 0.05);
    time += dt;
    const names = Object.keys(npcs);
    names.forEach((k, i) => { npcCircles[i].x = npcs[k].group.position.x; npcCircles[i].z = npcs[k].group.position.z; });
    player.update(dt);
    scenario.update(dt);

    // what light surrounds the player: the dim room, or the sun and sky
    camera.getWorldPosition(eye);
    const inside = stage.insideness(eye);
    lighting.ambient.setScalar(THREE.MathUtils.lerp(0.34, 0.13, inside));
    lighting.keyDir.copy(sunDir).lerp(doorDir, inside).normalize();
    lighting.keyColor.copy(sunColor).lerp(DOOR_GLOW, inside);
    fx.ambient = THREE.MathUtils.lerp(0.5, 0.16, inside);

    let moving = false;
    for (const k of names) {
      const n = npcs[k];
      n.update(dt);
      moving = moving || n.moving;
      stage.applyEnv(n.materials, n.group.getWorldPosition(tmp).setY(1.2));
    }
    stage.updateViewLight(eye);
    vm.update(dt, { player, lighting });
    stage.applyEnv(vm.materials, eye);
    fx.update(dt, time);

    // shadows are frozen unless someone is walking
    if (moving || wasMoving) {
      stage.requestShadowUpdate('door');
      if (++shadowTick % 3 === 0 || !moving) stage.requestShadowUpdate('sun');
    }
    wasMoving = moving;

    stage.updateExposure(dt);
    props.smoke.material.uniforms.uTime.value = time;
    if (draw) stage.render(dt);
    else scene.updateMatrixWorld();                    // rendering normally does this; ray picks need it

    if (params.has('fps') && (fpsT += dt) > 0.5) {
      fpsT = 0;
      ui.fps(`${Math.round(1000 / gov.ms)} fps · ${tierName}${gov.scale < 1 ? ` · ${Math.round(gov.scale * 100)}%` : ''}${gov.ao ? '' : ' · no AO'}`);
    }
  }

  window.play = { stage, player, scenario, npcs, vm, fx, ui, interact, input, frame, governor: gov };
  if (params.has('scale')) {                           // ?scale=0.7 fixes the render resolution
    gov.scale = THREE.MathUtils.clamp(Number(params.get('scale')) || 1, 0.4, 1);
    stage.setRenderScale(gov.scale);
    gov.on = false;
  }
  started = true;
  if (params.has('auto')) {
    // scripted run for automated checks: no animation loop, the script steps the game itself
    const { autoplay } = await import('./autoplay.js');
    scenario.start();
    await autoplay(window.play, params.get('auto'), params.get('shot'));
    return;
  }
  // Hold the frame rate on weak GPUs: first lower the render resolution, then drop ambient occlusion,
  // and raise the resolution again when there is clear headroom. `?adapt=0` keeps full quality.
  const setScale = (k) => { gov.scale = k; stage.setRenderScale(k); };
  function governor() {
    const now = performance.now(), ms = Math.min(now - gov.last, 250);
    gov.last = now;
    gov.ms += (ms - gov.ms) * 0.05;
    if (!gov.on || document.hidden || ui.modal || !player.locked) { gov.slow = gov.fast = 0; return; }
    if (gov.ms > 36) { gov.slow += ms; gov.fast = 0; } else if (gov.ms < 21) { gov.fast += ms; gov.slow = 0; } else gov.slow = gov.fast = 0;
    if (gov.slow > 1500) {
      gov.slow = 0;
      if (gov.scale > 0.71) setScale(Math.max(0.7, gov.scale - 0.15));
      else if (gov.ao) { gov.ao = false; stage.setAO(false); }
      else if (gov.scale > 0.51) setScale(Math.max(0.5, gov.scale - 0.1));
    } else if (gov.fast > 6000 && gov.scale < 1) {
      gov.fast = 0;
      setScale(Math.min(1, gov.scale + 0.1));
    }
  }
  renderer.setAnimationLoop(() => { governor(); frame(); });
  await scenario.start();
}

init().catch((err) => {
  console.error(err);
  document.querySelector('#loading div').textContent = /WebGL/i.test(err.message) ? 'هذا المتصفح لا يوفّر WebGL الآن. افتح العنوان نفسه في Chrome أو Brave، أو أعد تشغيل التطبيق.' : `تعذر تشغيل الموقف: ${err.message}`;
});
