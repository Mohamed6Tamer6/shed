import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// Texture budget per quality tier. "hero" maps are the colour maps you zoom into
// (extinguishers, drum, sacks, back wall, floor); "aux" their normal/roughness maps;
// "base" everything else. One 4K map costs about 90 MB of GPU memory, one 2K map 22 MB.
const TIERS = {
  max: { hero: '4k', aux: '4k', base: '4k', sky: '8k', shadow: 4096, dpr: 2, ao: true },
  ultra: { hero: '4k', aux: '2k', base: '2k', sky: '8k', shadow: 4096, dpr: 2, ao: true },
  high: { hero: '2k', aux: '2k', base: '2k', sky: '4k', shadow: 4096, dpr: 1.5, ao: true },
  medium: { hero: '2k', aux: '1k', base: '1k', sky: '4k', shadow: 2048, dpr: 1, ao: false },
  low: { hero: '1k', aux: '1k', base: '1k', sky: '1k', shadow: 2048, dpr: 1, ao: false },
  // the published build's default: a download of about 60 MB; its sky is the 2K lighting panorama, fetched once
  web: { hero: '2k', aux: '1k', base: '1k', sky: '2k', shadow: 2048, dpr: 1.5, ao: true },
  sharp: { hero: '2k', aux: '2k', base: '2k', sky: '2k', shadow: 4096, dpr: 2, ao: true },      // the published build's best: about 130 MB
};

export const params = new URLSearchParams(location.search);
// The tier comes from ?q=; a published build (tools/build_web.py sets window.SHED_BUILD) has no query string,
// so there it comes from the viewer's saved choice or the build's default.
const BUILD = window.SHED_BUILD || null;
const savedTier = (() => { try { return BUILD ? localStorage.getItem('shed.quality') : null; } catch { return null; } })();
const wantedTier = params.get('q') || savedTier || (BUILD && BUILD.tier);
export const availableTiers = BUILD ? BUILD.tiers : Object.keys(TIERS);
export const tierName = TIERS[wantedTier] && availableTiers.includes(wantedTier) ? wantedTier : (BUILD ? BUILD.tier : 'ultra');
export const quality = { ...TIERS[tierName] };
if (params.has('ao')) quality.ao = params.get('ao') !== '0';

export const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const cache = new Map();
let maxAniso = 16;
export function setMaxAnisotropy(v) { maxAniso = v; }

function load(url, srgb) {
  if (!cache.has(url)) {
    const t = loader.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    cache.set(url, t);
  }
  return cache.get(url);
}

const res = (cls) => quality[cls] || quality.base;

/** One map of a Poly Haven texture: kind is 'Diffuse', 'nor_gl' or 'arm'. */
export function tex(name, kind, cls = 'base') {
  return load(`assets/tex/${name}/${kind}_${res(cls)}.jpg`, kind === 'Diffuse');
}

/** One generated map from tools/make_textures.py, e.g. gen('drum_diff', 'hero'). */
export function gen(name, cls = 'base') {
  return load(`assets/gen/${name}_${res(cls)}.jpg`, name.endsWith('_diff'));
}

/** A copy that shares the image but has its own repeat/offset/rotation. */
export function tiled(t, rx, ry = rx, rotation = 0) {
  const c = t.clone();
  c.repeat.set(rx, ry);
  c.rotation = rotation;
  c.needsUpdate = true;
  return c;
}

// Materials lit by the light captured inside the shed instead of the open sky.
export const interiorMaterials = new Set();
export function interior(mat) {
  interiorMaterials.add(mat);
  return mat;
}

/**
 * Standard PBR material from colour + normal + ARM (ao/roughness/metal) maps.
 * `maps` is { map, normalMap, arm }; the rest goes straight to the material.
 */
export function pbr(maps, opts = {}) {
  const { normalScale = 1, ...rest } = opts;
  const m = new THREE.MeshStandardMaterial({
    map: maps.map || null,
    normalMap: maps.normalMap || null,
    aoMap: maps.arm || null,
    roughnessMap: maps.arm || null,
    metalnessMap: maps.arm || null,
    roughness: 1,
    metalness: maps.arm ? 1 : 0,
    ...rest,
  });
  if (maps.normalMap) m.normalScale.setScalar(normalScale);
  return m;
}

/** Poly Haven set with one call; cls picks the resolution class of the colour map. */
export function polyhaven(name, cls = 'base', auxCls = cls === 'hero' ? 'aux' : cls) {
  return { map: tex(name, 'Diffuse', cls), normalMap: tex(name, 'nor_gl', auxCls), arm: tex(name, 'arm', auxCls) };
}

export function loadHDR(resolution, type) {
  return new Promise((resolve, reject) => {
    new RGBELoader(manager).setDataType(type).load(`assets/hdri/brick_factory_01_${resolution}.hdr`, resolve, undefined, reject);
  });
}

/**
 * Splits a float equirect HDR into sun and sky. The sun's pixels are clipped out of the data so
 * the map can serve as sky-only ambient light, and the energy removed is returned as the
 * intensity of a directional light, so the pair still adds up to what the camera measured.
 * Also returns the sky's irradiance on level ground and the radiance of the photographed ground.
 */
export function extractSun(hdr, clip = 5) {
  const { data, width, height } = hdr.image;
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, data[i] + data[i + 1] + data[i + 2]);
  const threshold = peak * 0.25;
  const dir = new THREE.Vector3();
  const sunE = [0, 0, 0], skyE = [0, 0, 0], ground = [0, 0, 0];
  let groundW = 0;
  for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    const dOmega = cl * (Math.PI / height) * ((2 * Math.PI) / width);
    const isGround = lat < -0.45 && lat > -1.1;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = data[i] + data[i + 1] + data[i + 2];
      if (lum > threshold) {
        const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2;
        dir.x += Math.cos(phi) * cl * lum;
        dir.y += sl * lum;
        dir.z += Math.sin(phi) * cl * lum;
      }
      const m = Math.max(data[i], data[i + 1], data[i + 2]);
      if (m > clip) {
        const k = clip / m;
        for (let c = 0; c < 3; c++) {
          sunE[c] += data[i + c] * (1 - k) * dOmega;
          data[i + c] *= k;
        }
      }
      if (sl > 0) for (let c = 0; c < 3; c++) skyE[c] += data[i + c] * sl * dOmega;
      if (isGround) {
        for (let c = 0; c < 3; c++) ground[c] += data[i + c] * cl;
        groundW += cl;
      }
    }
  }
  hdr.needsUpdate = true;
  const intensity = Math.max(...sunE) || 1;
  return {
    direction: dir.normalize(),
    colour: new THREE.Color(sunE[0] / intensity, sunE[1] / intensity, sunE[2] / intensity),
    intensity,
    sunIrradiance: sunE,
    skyIrradiance: (skyE[0] + skyE[1] + skyE[2]) / 3,
    skyIrradianceRGB: skyE,
    groundRadiance: ground.map((v) => v / groundW),
  };
}
