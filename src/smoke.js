import * as THREE from 'three';
import { canvasTexture, rng } from './util.js';

function puffTexture() {
  return canvasTexture(128, 128, (c, w) => {
    const rand = rng(4);
    c.clearRect(0, 0, w, w);
    for (let i = 0; i < 26; i++) {
      const x = w / 2 + (rand() - 0.5) * w * 0.45, y = w / 2 + (rand() - 0.5) * w * 0.45, r = w * (0.12 + rand() * 0.2);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, w);
    }
  }, { srgb: false });
}

/** A thin wisp of smoke: camera-facing puffs whose whole motion is computed in the vertex shader. */
export function makeSmoke(count = 150) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  const seeds = new Float32Array(count * 2), rand = rng(77);
  for (let i = 0; i < count; i++) {
    seeds[i * 2] = (i + rand()) / count;
    seeds[i * 2 + 1] = rand();
  }
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2));
  g.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uTex: { value: puffTexture() }, uColor: { value: new THREE.Color(0.2, 0.2, 0.215) }, uOpacity: { value: 0.22 } },
    vertexShader: /* glsl */`
      attribute vec2 aSeed;
      uniform float uTime;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float life = fract(uTime * 0.085 * (0.75 + 0.5 * aSeed.y) + aSeed.x);
        float h = life * (0.9 + 0.3 * aSeed.y);
        float spread = 0.006 + 0.12 * life * life;
        vec3 p = vec3(0.0, h, 0.0);
        p.x += sin(h * 6.5 + aSeed.x * 37.0 + uTime * 0.55) * spread * 0.45 + (aSeed.y - 0.5) * spread;
        p.z += cos(h * 5.1 + aSeed.y * 29.0 + uTime * 0.4) * spread * 0.35 + 0.06 * life;
        float size = mix(0.018, 0.2, pow(life, 0.9));
        float rot = aSeed.x * 6.283 + uTime * 0.25 * (aSeed.y - 0.5);
        vec2 q = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * position.xy;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        mv.xy += q * size;
        gl_Position = projectionMatrix * mv;
        vAlpha = smoothstep(0.0, 0.05, life) * pow(1.0 - life, 1.6);
        vUv = uv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        float a = texture2D(uTex, vUv).a * vAlpha * uOpacity;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.userData.noAO = true;
  mesh.renderOrder = 5;
  return mesh;
}
