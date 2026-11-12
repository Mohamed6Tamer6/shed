import * as THREE from 'three';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { quality, params, manager, setMaxAnisotropy, loadHDR, extractSun, interiorMaterials } from './assets.js';
import { buildShed, buildYard, buildOffice, X, Z, GROUND_Y } from './building.js';
import { makeExtinguisher } from './extinguisher.js';
import { makeDrum } from './drum.js';
import { makeSacksAndStraw } from './sacks.js';
import { makeBoard } from './board.js';
import { makeSmoke } from './smoke.js';

// ---- look-and-feel constants, tuned against the reference photo
const SUN_FROM = new THREE.Vector3(-0.8, 0, -0.6);    // where the sun sits relative to the shed (to the left, a little behind)
export const EXPOSURE_OUT = 1.15, EXPOSURE_IN = 4.3;
const PROBE_INTENSITY = 0.85;
const CAMERA_HDRI_HEIGHT = 1.6;                       // tripod height of the sky panorama
export const EXT_SCALE = 1.0;                         // true sizes: 9 L water 0.59 m, 6 kg powder 0.54 m, 5 kg CO2 0.73 m tall
export const HANDLE_HEIGHT = 1.2;                     // carrying handles above the floor: within reach with a bent elbow
export const BOARD_SCALE = 1.2, BOARD_HEIGHT = 0.98, BOARD_X = -1.5;
/**
 * Layer for the first-person view model (hands, whatever they hold). Objects on it are drawn
 * after the ambient-occlusion pass with the depth buffer cleared, so they never poke into walls
 * and get no occlusion halos. Put an object there with `obj.traverse(o => o.layers.set(VIEW_LAYER))`.
 */
export const VIEW_LAYER = 1;

// A light whose `decay` is above 2 has a size: 2 + r falls off as 1 / (d² + r²), an inverse-square
// light from a source r metres across, so whatever stands right next to it is not burnt out.
THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin.replace(
  'float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );',
  'float sourceRadius = max( decayExponent - 2.0, 0.0 );\n\tfloat distanceFalloff = 1.0 / max( pow( lightDistance, min( decayExponent, 2.0 ) ) + sourceRadius * sourceRadius, 0.01 );',
);
const DOOR_SOURCE = 2.5;                              // metres: the doorway is a wide patch of sky, not a bulb
const VIEW_GLOW = 0.5;                                // share of the doorway light the first-person hands receive

class ViewModelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    drawViewModel(renderer, this.scene, this.camera, this.renderToScreen ? null : readBuffer);
  }
}

function drawViewModel(renderer, scene, camera, target) {
  const autoClear = renderer.autoClear, mask = camera.layers.mask;
  renderer.autoClear = false;
  camera.layers.set(VIEW_LAYER);
  renderer.setRenderTarget(target);
  renderer.clearDepth();
  renderer.render(scene, camera);
  camera.layers.mask = mask;
  renderer.autoClear = autoClear;
}

/**
 * Builds the whole place: renderer, sky, sun, yard, shed, props, interior light and the
 * post-processing chain. Used by the orbit viewer (main.js) and the playable scenario (game/play.js).
 *
 * Everything in the shed lives in `world`, a group turned so the sun comes from the shed's left;
 * positions quoted anywhere in this project are in that group's space ("shed space": x right,
 * y up, z out of the door, origin at the middle of the floor).
 *
 * options: { office: also build the supervisor's office next door, onProgress(fraction) }
 */
export async function createStage({ office = false, onProgress = () => {} } = {}) {
  const t0 = performance.now(), mark = (label) => console.info(`[load] ${label}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  // scripted runs (?auto=) are captured by a headless browser, which needs the last frame kept
  const renderer = new THREE.WebGLRenderer({ antialias: !quality.ao, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('auto') });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.dpr));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // each light's shadow map is redrawn only when asked (requestShadowUpdate); see the lights below
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE_IN;
  document.body.appendChild(renderer.domElement);
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.04, 400);
  const world = new THREE.Group();
  scene.add(world);

  // ---- loading progress
  let loaded = 0, total = 0, onIdle = null;
  manager.onProgress = (url, l, t) => {
    loaded = l;
    total = t;
    onProgress(l / t);
  };
  manager.onLoad = () => { if (onIdle) onIdle(); };
  manager.onError = (url) => console.error('failed to load', url);
  const allLoaded = () => new Promise((resolve) => {
    if (total > 0 && loaded === total) resolve();
    else onIdle = resolve;
  });

  const noAO = [];                                      // transparent things the occlusion pass must not see
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.05, 300, cubeRT);
  scene.add(cubeCam);
  let probeTarget = null, composer = null, gtao = null;

  // ---- sky: a 2K float copy drives the lighting, a sharper copy is what you see
  const envEquirect = await loadHDR('2k', THREE.FloatType);
  // When the sky on show is this same 2K panorama, keep a copy from before the sun is cut out of the
  // lighting data instead of fetching the file a second time.
  let skyCopy = null;
  if (quality.sky === '2k') {
    const { data, width, height } = envEquirect.image;
    skyCopy = new THREE.DataTexture(data.slice(), width, height, envEquirect.format, envEquirect.type);
    Object.assign(skyCopy, { colorSpace: envEquirect.colorSpace, minFilter: envEquirect.minFilter, magFilter: envEquirect.magFilter, generateMipmaps: false, flipY: envEquirect.flipY });
    skyCopy.needsUpdate = true;
  }
  const sunInfo = extractSun(envEquirect);
  envEquirect.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(envEquirect).texture;
  envEquirect.mapping = THREE.UVMapping;
  mark('lighting sky ready');
  const skyPromise = skyCopy ? Promise.resolve(skyCopy) : loadHDR(quality.sky, THREE.HalfFloatType);

  // Turn the shed so the sun comes from its left: soft light at the door, like the reference.
  const ang = (v) => Math.atan2(v.x, v.z);
  world.rotation.y = ang(sunInfo.direction) - ang(SUN_FROM);
  world.updateMatrixWorld(true);

  const sun = new THREE.DirectionalLight(sunInfo.colour, sunInfo.intensity);
  sun.position.copy(sunInfo.direction).multiplyScalar(40).add(new THREE.Vector3(0, 1, 0));
  sun.target.position.set(0, 1, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(quality.shadow);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 5, far: 80 });
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.025;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  sun.layers.enable(VIEW_LAYER);                        // lights must share a layer with what they light
  scene.add(sun, sun.target);

  // ---- the place
  const yard = buildYard();
  world.add(yard, buildShed());
  // Tint the yard so that, under this sun and sky, it comes out like the photographed ground around it.
  const SAND = [0.288, 0.158, 0.072];                 // mean linear albedo of the gravelly_sand texture
  const tint = sunInfo.groundRadiance.map((L, c) => {
    const irradiance = sunInfo.sunIrradiance[c] * sunInfo.direction.y + sunInfo.skyIrradianceRGB[c];
    return THREE.MathUtils.clamp((L * Math.PI) / irradiance / SAND[c], 0.3, 2.2);
  });
  yard.material.color.setRGB(...tint);
  const officeInfo = office ? buildOffice() : null;
  if (officeInfo) world.add(officeInfo.group);

  const wallZ = -Z;
  const place = (obj, x, y, z) => { obj.position.set(x, y, z); world.add(obj); return obj; };
  const extinguishers = {};
  for (const [kind, x] of [['water', -0.86], ['powder', -0.2], ['co2', 0.42]]) {
    const e = makeExtinguisher(kind);
    e.scale.setScalar(EXT_SCALE);
    // every unit hangs with its carrying handle at the same height (the handle is 0.07 above the shoulder of the cylinder)
    extinguishers[kind] = place(e, x, HANDLE_HEIGHT - (e.userData.H + 0.07) * EXT_SCALE, wallZ + e.userData.wallGap * EXT_SCALE);
  }
  const drum = place(makeDrum(), 1.62, 0, -0.52);
  drum.rotation.y = 0.7;
  const sacks = makeSacksAndStraw();
  world.add(sacks);
  const board = place(makeBoard(BOARD_HEIGHT / BOARD_SCALE), BOARD_X, BOARD_HEIGHT, wallZ);
  board.scale.setScalar(BOARD_SCALE);
  board.traverse((o) => { if (o.userData.noAO) noAO.push(o); });
  const smoke = makeSmoke();
  smoke.position.copy(board.userData.smokeOrigin).multiplyScalar(BOARD_SCALE).add(board.position);
  world.add(smoke);
  noAO.push(smoke);

  // Soft light entering through the doorway: gives the props their directional shadows.
  const doorLight = new THREE.SpotLight(0xfff1e2, 0, 0, 1.25, 1, 2 + DOOR_SOURCE);
  doorLight.position.set(-1.0, 1.75, Z - 0.02);
  doorLight.target.position.set(0.35, 0.95, -Z);
  doorLight.castShadow = true;
  doorLight.shadow.mapSize.setScalar(1024);
  doorLight.shadow.camera.near = 0.3;
  doorLight.shadow.camera.far = 8;
  doorLight.shadow.bias = -0.0015;
  doorLight.shadow.normalBias = 0.02;
  doorLight.shadow.autoUpdate = false;
  doorLight.shadow.needsUpdate = true;
  world.add(doorLight, doorLight.target);
  // The first-person view model takes the doorway's glow from a plain light of its own (see updateViewLight):
  // hands are often within a metre of the doorway light, where even a wide source is far too strong.
  const viewLight = new THREE.DirectionalLight(0xfff1e2, 0);
  viewLight.layers.set(VIEW_LAYER);
  viewLight.position.set(-1.0, 2.3, Z + 3);
  viewLight.target.position.set(0.2, 1.2, -0.5);
  world.add(viewLight, viewLight.target);

  // ---- sky dome with the photographed ground projected flat, so the shed stands in a real place
  mark('scene built');
  const skyDisplay = await skyPromise;
  mark('display sky ready');
  const skybox = new GroundedSkybox(skyDisplay, CAMERA_HDRI_HEIGHT, 120, 96);
  skybox.position.y = CAMERA_HDRI_HEIGHT + GROUND_Y;
  skybox.renderOrder = -2;
  scene.add(skybox);
  noAO.push(skybox);                                  // its inward-facing dome would read as fully occluded

  let interiorEnv = { map: null, intensity: 1 };
  function setInteriorEnv(texture, intensity) {
    interiorEnv = { map: texture, intensity };
    for (const m of interiorMaterials) {
      m.envMap = texture;
      m.envMapIntensity = intensity * (m.userData.envBoost || 1);
      m.needsUpdate = true;
    }
  }

  /**
   * Captures the light that actually reaches the middle of the room (sky through the door and
   * window, sun bouncing off the yard, the walls lighting each other) and uses it as the ambient
   * light of everything indoors. Repeated so each pass adds one more bounce.
   * `hide` lists extra objects to leave out of the capture (people, held things).
   */
  function bakeInteriorLight(hide = []) {
    const hidden = [...noAO, ...hide].filter((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    skybox.material.map = envEquirect;                  // sun-clipped copy: no fireflies in the probe
    sun.shadow.needsUpdate = doorLight.shadow.needsUpdate = true;
    setInteriorEnv(scene.environment, 0.1);
    cubeCam.position.copy(world.localToWorld(new THREE.Vector3(0.1, 1.35, 0.15)));
    for (let pass = 0; pass < 4; pass++) {
      cubeCam.update(renderer, scene);
      const rt = pmrem.fromCubemap(cubeRT.texture);
      setInteriorEnv(rt.texture, PROBE_INTENSITY);
      if (probeTarget) probeTarget.dispose();
      probeTarget = rt;
    }
    skybox.material.map = skyDisplay;
    hidden.forEach((o) => { o.visible = true; });
    sun.shadow.needsUpdate = doorLight.shadow.needsUpdate = true;
  }

  // Ambient occlusion is the costly pass on an integrated GPU: compute it at half size on big windows.
  function sizeAO() {
    const pr = renderer.getPixelRatio(), w = window.innerWidth * pr, h = window.innerHeight * pr;
    const k = w * h > 1.3e6 ? 0.5 : 1;
    gtao.setSize(Math.round(w * k), Math.round(h * k));
  }

  function setupComposer() {
    if (!quality.ao) return;
    const w = window.innerWidth, h = window.innerHeight;
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: Number(params.get('msaa') ?? 4) }));
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, w, h);
    gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.2, thickness: 1.2, scale: 1.25, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1.5, rings: 2, samples: 12 });
    gtao.blendIntensity = 1;
    const hide = gtao.overrideVisibility.bind(gtao);
    gtao.overrideVisibility = () => { hide(); noAO.forEach((o) => { o.visible = false; }); };
    composer.addPass(gtao);
    composer.addPass(new ViewModelPass(scene, camera));
    composer.addPass(new OutputPass());
    sizeAO();
  }

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) {
      composer.setSize(w, h);
      sizeAO();
    }
  });

  /** 1 inside the shed, 0 well outside it; drives the exposure like a camera's metering. */
  function insideness(position = camera.position) {
    const p = world.worldToLocal(position.clone());
    const d = Math.hypot(Math.max(Math.abs(p.x) - X, 0), Math.max(p.y - 2.6, 0), Math.max(Math.abs(p.z) - Z, 0));
    return 1 - THREE.MathUtils.smoothstep(d, 0.2, 3.5);
  }

  const tmpV = new THREE.Vector3();
  const stage = {
    renderer, scene, camera, world, quality, sunInfo, sun, doorLight, noAO, skybox,
    props: { extinguishers, drum, sacks, board, smoke, office: officeInfo },
    insideness,
    bakeInteriorLight,
    /** Gives materials created after the bake (via `interior(...)`) the room's ambient light. */
    refreshInteriorEnv() { setInteriorEnv(interiorEnv.map, interiorEnv.intensity); },
    /**
     * Ambient light for something that moves between indoors and outdoors: sets `envMap` on the
     * given materials to the room probe when `position` (world space) is inside the shed, to the sky otherwise.
     */
    applyEnv(materials, position) {
      const inside = insideness(position) > 0.6;
      const map = inside ? interiorEnv.map : scene.environment;
      for (const m of materials) {
        if (m.envMap === map) continue;
        m.envMap = map;
        m.envMapIntensity = inside ? interiorEnv.intensity : 1;
      }
    },
    /** Renders at `k` (0.5..1) times the quality tier's resolution; the page keeps its size. */
    setRenderScale(k) {
      const pr = Math.min(window.devicePixelRatio, quality.dpr) * k;
      renderer.setPixelRatio(pr);
      if (composer) {
        composer.setPixelRatio(pr);
        sizeAO();
      }
    },
    /** Switches the ambient-occlusion pass, the most expensive one on an integrated GPU. */
    setAO(on) { if (gtao) gtao.enabled = on; },
    /** Doorway glow on the first-person view model, for an eye at `position` (world space). Call every frame. */
    updateViewLight(position) {
      const p = world.worldToLocal(tmpV.copy(position));
      const d2 = p.distanceToSquared(doorLight.position);
      viewLight.intensity = insideness(position) * VIEW_GLOW * doorLight.intensity / (d2 + 9);
    },
    /**
     * Call when something that casts a shadow has moved; shadows are otherwise frozen.
     * `which`: 'sun' (the 4K map of the whole yard), 'door' (the small map of the room), or both when omitted.
     */
    requestShadowUpdate(which) {
      if (which !== 'door') sun.shadow.needsUpdate = true;
      if (which !== 'sun') doorLight.shadow.needsUpdate = true;
    },
    /** Eases the exposure towards what the camera position calls for (or `?exposure=`). */
    updateExposure(dt) {
      const fixed = params.get('exposure');
      const want = fixed ? Number(fixed) : THREE.MathUtils.lerp(EXPOSURE_OUT, EXPOSURE_IN, insideness());
      renderer.toneMappingExposure += (want - renderer.toneMappingExposure) * (1 - Math.exp(-dt * 3.5));
    },
    settleExposure() {
      renderer.toneMappingExposure = THREE.MathUtils.lerp(EXPOSURE_OUT, EXPOSURE_IN, insideness());
    },
    render(dt = 0) {
      if (composer) {
        composer.render(dt);
      } else {
        renderer.render(scene, camera);
        drawViewModel(renderer, scene, camera, null);
      }
    },
    /**
     * Waits for every texture, then bakes the interior light and builds the post chain.
     * Add your own objects to the scene before calling it so their shaders compile here.
     */
    async finish(hideFromProbe = []) {
      await allLoaded();
      mark('textures ready');
      // The door light takes its strength from what the sky delivers at the doorway.
      doorLight.intensity = Number(params.get('door') ?? 38) * sunInfo.skyIrradiance;
      bakeInteriorLight(hideFromProbe);
      setupComposer();
      mark('interior light baked');
    },
  };
  return stage;
}
