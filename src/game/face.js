// A living face for the three bystanders: mood, blinking, gaze and the mouth for Arabic lines.
//
// The GLBs (tools/characters/build_characters.py) carry 67 morph targets on every mesh that sits on the face
// (skin of the head, brows, lashes, teeth, tongue, beard): the 52 ARKit face units and the 15 Meta visemes, same
// names, same order. The eyes are two bones, eye_l and eye_r, children of `head`. A character without them (an old
// GLB, the plain stand-in) gets a Face that does nothing.
//
// Layers, mixed every frame into one weight per target and clamped to 0..1 (docs/characters/design.md 3):
//   1. mood    a recipe of ARKit weights per mood and per man, eased in, slightly lopsided, never at full strength
//   2. blink   random intervals by mood, fast down, slower up; one with every large gaze shift
//   3. gaze    saccades between fixations (held on the player about 3 s, then a short glance away), small jumps
//              while fixating; the eye bones aim at the point, the head takes only what the eyes cannot
//   4. speech  Arabic text -> phones -> the 15 visemes, timed by syllable rate, with coarticulation, lip closure on
//              b and m, the jaw carrying the opening, a small nod and brow lift on stressed syllables
//   5. life    small brow and lip drifts, a swallow now and then, nostrils breathing under alarm
//
// Character (characters.js) calls: tick(dt) at the start of its update, headPoint / nod / eye angles inside its
// look-at overlay (aim()), and commit() after the bones are set. scenario.js calls speak(text, seconds) and
// setMood(name) through the character.

import * as THREE from 'three';

export const ARKIT = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff',
  'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft',
  'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];
export const VISEMES = ['viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_kk', 'viseme_CH',
  'viseme_SS', 'viseme_nn', 'viseme_RR', 'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U'];
export const FACE_KEYS = [...ARKIT, ...VISEMES];
const N = FACE_KEYS.length;
const K = Object.fromEntries(FACE_KEYS.map((n, i) => [n, i]));
export const MOODS = ['neutral', 'worried', 'alarm', 'stern', 'relieved', 'pleased'];

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const smoothstep = (a, b, x) => smooth((x - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------- mood recipes
// Held weights (a face rests between about 20 and 60 % of a pose); a name without Left/Right sets both sides.
// Starting values from docs/characters/motion-speech.md 4.3, tuned on the sheets in docs/characters/final/.
const RECIPES = {
  neutral: { browInnerUp: 0.06, eyeWide: 0.04, mouthPress: 0.06 },
  worried: { browInnerUp: 0.50, browDown: 0.18, eyeSquint: 0.14, eyeWide: 0.10, mouthFrown: 0.20, mouthPress: 0.22,
    mouthShrugLower: 0.14, mouthRollLower: 0.08 },
  alarmPeak: { browInnerUp: 0.72, browOuterUp: 0.45, browDown: 0.12, eyeWide: 0.75, eyeSquint: 0.10,
    mouthStretch: 0.50, jawOpen: 0.20, mouthLowerDown: 0.22, mouthUpperUp: 0.12 },
  alarm: { browInnerUp: 0.55, browOuterUp: 0.30, browDown: 0.15, eyeWide: 0.50, eyeSquint: 0.15, mouthStretch: 0.35,
    jawOpen: 0.12, mouthLowerDown: 0.16, mouthUpperUp: 0.08 },
  stern: { browDown: 0.48, eyeSquint: 0.28, eyeWide: 0.08, mouthPress: 0.36, mouthFrown: 0.22, mouthShrugLower: 0.18,
    jawForward: 0.10, noseSneer: 0.08 },
  relievedExhale: { browInnerUp: 0.16, eyeBlink: 0.55, jawOpen: 0.14, mouthFunnel: 0.16, cheekPuff: 0.10 },
  relieved: { browInnerUp: 0.12, eyeSquint: 0.10, mouthSmile: 0.24, cheekSquint: 0.14 },
  pleased: { browOuterUp: 0.05, cheekSquint: 0.26, eyeSquint: 0.14, mouthSmile: 0.33, mouthDimple: 0.10 },
};
// Each man (motion-speech.md 4.4 and 4.6): stronger side (+1 = his left), how lopsided mouth and brows are, how slow
// his onsets are, smile scale, extra brow weight, speech rate (syllables a second), blink speed.
const MEN = {
  mahmoud: { side: 1, mouthAsym: 0.10, browAsym: 0.05, onset: 1.0, smile: 1.0, browExtra: 0.0, worryBrows: 1.15,
    pleased: 1.0, stern: 1.0, neutralSmile: 0.0, rate: 6.0, blinkSlow: 1.0, seed: 0.37 },
  fathy: { side: -1, mouthAsym: 0.12, browAsym: 0.06, onset: 1.3, smile: 0.7, browExtra: 0.08, worryBrows: 1.0,
    pleased: 1.0, stern: 1.0, neutralSmile: 0.0, rate: 5.0, blinkSlow: 1.15, seed: 0.71 },
  karim: { side: 1, mouthAsym: 0.08, browAsym: 0.04, onset: 1.0, smile: 1.0, browExtra: 0.0, worryBrows: 1.0,
    pleased: 1.2, stern: 0.9, neutralSmile: 0.06, rate: 5.5, blinkSlow: 1.0, seed: 0.13 },
};
// onset of a mood in seconds (times the man's own factor: Fathy 1.3), within the 0.3-0.6 s of design.md 3;
// alarm reaches the eyes within 100 ms
const ONSET = { neutral: 0.46, worried: 0.45, alarm: 0.08, stern: 0.35, relieved: 0.4, pleased: 0.46 };
// region delays (seconds after the mood starts): who leads
const LEAD = {
  alarm: { eye: 0, brow: 0.02, mouth: 0.04 }, worried: { brow: 0, eye: 0.03, mouth: 0.08 },
  stern: { brow: 0, eye: 0.05, mouth: 0.1 }, pleased: { brow: 0, eye: 0.05, mouth: 0.08 },
  relieved: { brow: 0, eye: 0, mouth: 0.05 }, neutral: { brow: 0, eye: 0, mouth: 0.05 },
};
const BLINKS_PER_MIN = { neutral: 17, worried: 30, alarm: 40, stern: 11, relieved: 18, pleased: 18 };
const SPEECH_SCALE = { neutral: 1.0, worried: 0.9, alarm: 1.25, stern: 1.1, relieved: 0.8, pleased: 1.0 };

const region = (name) => (/^brow/.test(name) ? 'brow' : /^(eye|cheekSquint)/.test(name) ? 'eye' : 'mouth');
const side = (name) => (/Left$/.test(name) ? 1 : /Right$/.test(name) ? -1 : 0);

function put(w, name, v) {
  if (name in K) w[K[name]] += v;
  else { w[K[name + 'Left']] += v; w[K[name + 'Right']] += v; }
}
function addRecipe(w, recipe, k = 1) { for (const [n, v] of Object.entries(recipe)) put(w, n, v * k); }

const _tmpA = new Float32Array(N);
const _tmpB = new Float32Array(N);

/** Target weights of a mood `tm` seconds after it started, for one man. */
function moodTarget(out, mood, tm, man) {
  out.fill(0);
  if (mood === 'alarm') {
    // starts as a startle, relaxes within a few seconds into a held alarm with worry in it
    const k = smoothstep(0.8, 3.3, tm);
    addRecipe(out, RECIPES.alarmPeak, 1 - k);
    addRecipe(out, RECIPES.alarm, 0.55 * k);
    addRecipe(out, RECIPES.worried, 0.45 * k);
  } else if (mood === 'relieved') {
    // eyes close with an exhale, then a smile; after a while it settles into a soft pleased face
    const a = 1 - smoothstep(0.7, 1.3, tm);
    const settle = smoothstep(3.5, 5.5, tm);
    addRecipe(out, RECIPES.relievedExhale, a);
    addRecipe(out, RECIPES.relieved, (1 - a) * (1 - settle));
    addRecipe(out, RECIPES.pleased, 0.6 * settle);
  } else if (mood === 'pleased') {
    addRecipe(out, RECIPES.pleased, lerp(1, 0.6, smoothstep(3, 4.5, tm)) * man.pleased);
  } else if (mood === 'stern') {
    addRecipe(out, RECIPES.stern, man.stern);
  } else if (mood === 'worried') {
    addRecipe(out, RECIPES.worried);
    out[K.browInnerUp] *= man.worryBrows;
    out[K.browDownLeft] *= man.worryBrows;
    out[K.browDownRight] *= man.worryBrows;
  } else {
    addRecipe(out, RECIPES.neutral);
    put(out, 'mouthSmile', man.neutralSmile);
  }
  put(out, 'browDown', man.browExtra);
  for (const n of ['mouthSmileLeft', 'mouthSmileRight', 'cheekSquintLeft', 'cheekSquintRight']) out[K[n]] *= man.smile;
  // lopsided: the weaker side gets less
  for (let i = 0; i < ARKIT.length; i++) {
    const s = side(FACE_KEYS[i]);
    if (!s || s === man.side) continue;
    out[i] *= 1 - (region(FACE_KEYS[i]) === 'mouth' ? man.mouthAsym : man.browAsym);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- Arabic speech
// Per-line phonetic strings (motion-speech.md 3.9 and the scenario's other lines): Egyptian consonants, real vowels.
// Notation: consonants b m f t d T D s z S Z sh g k q kh gh n l r H 3 h ' w y, vowels a i u e o, a doubled letter is a
// long vowel or a doubled consonant, '-' joins a clitic to its word, punctuation is kept for the pauses.
const PHONETIC = [
  ['أنا هنا يا أحمد. الباب خلفك وخالٍ.', "ana huna ya aHmad. al-baab khalfak wa khaalin."],
  ['م. كريم هنا عند الباب.', "muhandis kariim huna 3ind al-baab."],
  ['بلّغته، وهو في الطريق.', "ballaghtuh, wa huwa fi T-Tariiq."],
  ['حاضر! سأبلّغه حالًا.', "HaaDir! sa-uballighuhu Haalan."],
  ['هل أنت متأكد؟ ألا نُبلّغ م. كريم أولًا؟', "hal anta muta'akkid? ala nuballigh muhandis kariim awwalan?"],
  ['أنا بعيد عن الخطر يا بني. انتبه لنفسك.', "ana ba3iid 3an il-khaTar ya bunayy. intabih li-nafsak."],
  ['حاضر يا بني، أنا خارج.', "HaaDir ya bunayy, ana khaarig."],
  ['هي بجوارك، خذها أنت! بسرعة!', "hiya bi-giwaarak, khuz-haa anta! bi-sur3a!"],
  ['أنا معك. الباب خلفك وخالٍ.', "ana ma3ak. al-baab khalfak wa khaalin."],
  ['انظر ما الذي يشتعل، ثم اختر الطفاية المناسبة.', "unZur ma llazi yashta3il, summa khtar iT-Tafaaya l-munaasiba."],
  ['ماذا حدث؟', "maaza Hadas?"],
  ['هل أنت متأكد؟ ألن نُنذر أحدًا أولًا؟', "hal anta muta'akkid? alan nunzir aHadan awwalan?"],
  ['انتظر — هل هذا حريق كهربائي؟', "intaZir, hal haaza Hariiq kahrabaa'i?"],
  ['هذه لحرائق السوائل القابلة للاشتعال. الدليل يقول إن البودرة الجافة تلائم الحرائق الكهربائية.',
    "haazihi li-Haraa'iq is-sawaa'il il-qaabila lil-ishti3aal. id-daliil yaquul inna l-buudra l-gaaffa tulaa'im il-Haraa'iq il-kahrabaa'iyya."],
  ['اخرجوا! اخرجوا كلكم الآن!', "ukhruguu! ukhruguu kullukum il-'aan!"],
  ['من جديد يا أحمد: انظر ما الذي يشتعل، ثم اختر.', "min gadiid ya aHmad: unZur ma llazi yashta3il, summa khtar."],
  ['اللوحة تدخّن! بسرعة — الأسطوانة الحمراء هنا قريبة، خذها!', "il-lawHa tudakhkhin! bi-sur3a, il-usTuwaana l-Hamraa' huna qariiba, khuz-haa!"],
  ['انطفأ. تعالَ وأخبرني بما حدث.', "inTafa'. ta3aala wa-akhbirnii bimaa Hadas."],
  ['بسرعة يا أحمد!', "bi-sur3a ya aHmad!"],
];
const arabicKey = (text) => text.replace(/[^ء-ي]/g, '');
const PHON = new Map(PHONETIC.map(([ar, ph]) => [arabicKey(ar), ph]));

// consonant -> viseme ('' = nothing on the lips), relative length
const CONS = {
  b: ['viseme_PP', 1.08], m: ['viseme_PP', 1.08], f: ['viseme_FF', 1.0], v: ['viseme_FF', 1.0],
  t: ['viseme_DD', 1.05], d: ['viseme_DD', 1.05], T: ['viseme_DD', 1.05], D: ['viseme_DD', 1.05],
  s: ['viseme_SS', 1.23], z: ['viseme_SS', 1.23], S: ['viseme_SS', 1.23], Z: ['viseme_SS', 1.23],
  th: ['viseme_TH', 1.0], dh: ['viseme_TH', 1.0], sh: ['viseme_CH', 1.15], j: ['viseme_CH', 1.15],
  g: ['viseme_kk', 1.21], k: ['viseme_kk', 1.21], q: ['viseme_kk', 1.21], kh: ['viseme_kk', 1.21],
  gh: ['viseme_kk', 1.21], n: ['viseme_nn', 0.88], l: ['viseme_nn', 0.88], r: ['viseme_RR', 0.88],
  H: ['', 0.6], 3: ['', 0.6], h: ['', 0.6], "'": ['', 0.6], w: ['viseme_U', 0.7], y: ['viseme_I', 0.7],
};
const VOW = { a: ['viseme_aa', 0.95], e: ['viseme_E', 0.9], i: ['viseme_I', 0.92], o: ['viseme_O', 0.96], u: ['viseme_U', 0.95] };
const BACK = new Set(['T', 'D', 'S', 'Z', 'q', 'kh', 'gh', 'r']);       // pull a towards the back (O colour)
const PAUSE = { word: 0.25, comma: 3, stop: 5.5 };

/** Phonetic string -> list of phones {c|v|p, vis, len, long, word}. */
function parsePhonetic(s) {
  const out = [];
  let word = 0;
  let i = 0;
  const push = (p) => out.push({ word, ...p });
  while (i < s.length) {
    const ch = s[i];
    const two = s.slice(i, i + 2);
    if (ch === ' ') { push({ kind: 'p', units: PAUSE.word }); word++; i++; continue; }
    if (ch === '-') { i++; continue; }
    if (/[,;:—،]/.test(ch)) { push({ kind: 'p', units: PAUSE.comma }); word++; i++; continue; }
    if (/[.!?؟]/.test(ch)) { push({ kind: 'p', units: PAUSE.stop, bang: ch === '!' }); word++; i++; continue; }
    if (VOW[ch]) {
      const long = s[i + 1] === ch;
      push({ kind: 'v', ph: ch, vis: VOW[ch][0], len: VOW[ch][1] * (long ? 1.75 : 1), long });
      i += long ? 2 : 1;
      continue;
    }
    const di = ['sh', 'kh', 'gh', 'th', 'dh'].includes(two) ? two : null;
    const c = di || ch;
    if (!CONS[c]) { i++; continue; }
    const n = c.length;
    const gem = s.slice(i + n, i + 2 * n) === c;
    push({ kind: 'c', ph: c, vis: CONS[c][0], len: CONS[c][1] * (gem ? 1.8 : 1), gem });
    i += gem ? 2 * n : n;
  }
  // drop pauses at the very start, merge repeated ones
  while (out.length && out[0].kind === 'p') out.shift();
  return out.filter((p, j) => !(p.kind === 'p' && out[j - 1] && out[j - 1].kind === 'p'));
}

// Letter rules for a line without a phonetic string (motion-speech.md 3.5): approximate vowels, right closures.
const LETTER = {
  'ب': 'b', 'ت': 't', 'ث': 's', 'ج': 'g', 'ح': 'H', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's',
  'ش': 'sh', 'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'Z', 'ع': '3', 'غ': 'gh', 'ف': 'f', 'ق': "'", 'ك': 'k', 'ل': 'l',
  'م': 'm', 'ن': 'n', 'ه': 'h', 'ء': "'", 'أ': "'", 'إ': "'", 'ؤ': "'", 'ئ': "'", 'ة': 'a',
};
const SUN = new Set(['ت', 'ث', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط', 'ظ', 'ل', 'ن']);
function lettersToPhonetic(text) {
  const words = text.replace(/م\./g, 'مهندس').replace(/ـ/g, '').split(/(\s+|[،,.!?؟:—-])/);
  const out = [];
  for (const w0 of words) {
    if (!w0) continue;
    if (/^\s+$/.test(w0)) { out.push(' '); continue; }
    if (/^[،,.!?؟:—-]$/.test(w0)) { out.push(w0 === '،' ? ',' : w0 === '؟' ? '?' : w0); continue; }
    let w = w0.replace(/[ً-ْٰ]/g, (m) => ({ 'َ': 'َ', 'ِ': 'ِ', 'ُ': 'ُ', 'ّ': 'ّ' }[m] || ''));
    let ph = '';
    let i = 0;
    if (/^ال/.test(w)) {
      const next = w[2];
      ph += SUN.has(next) ? 'a' + (LETTER[next] || '') + '-' : 'al-';
      i = 2;
    } else if (/^ا/.test(w)) { ph += 'i'; i = 1; }
    const cons = [];
    for (; i < w.length; i++) {
      const c = w[i];
      const last = i === w.length - 1;
      if (c === 'َ') { ph += 'a'; continue; }
      if (c === 'ِ') { ph += 'i'; continue; }
      if (c === 'ُ') { ph += 'u'; continue; }
      if (c === 'ّ') { const m = ph.match(/(sh|kh|gh|[a-zA-Z3'])$/); if (m) ph += m[1]; continue; }
      if (c === 'ا' || c === 'ى' || c === 'آ') { ph += 'aa'; continue; }
      if (c === 'و') { ph += (i === 0 || w[i + 1] === 'ا') ? 'w' : (last ? 'uu' : 'uu'); continue; }
      if (c === 'ي') { ph += (i === 0 || w[i + 1] === 'ا') ? 'y' : 'ii'; continue; }
      const p = LETTER[c];
      if (p === undefined) continue;
      ph += p;
      cons.push(i);
      const nx = w[i + 1];
      // unwritten short vowel after a consonant, except at the end and before the last consonant after a vowel
      const vowelNext = nx && /[َُِّاوىيآة]/.test(nx);
      if (!last && !vowelNext && i < w.length - 2 && p !== 'a') ph += 'a';
    }
    out.push(ph);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Stress per phonological word (Cairo rule in outline, motion-speech.md 3.11): marks one vowel per word. */
function markStress(phones) {
  const words = new Map();
  phones.forEach((p, i) => { if (p.kind !== 'p') { if (!words.has(p.word)) words.set(p.word, []); words.get(p.word).push(i); } });
  for (const idx of words.values()) {
    const vowels = idx.filter((i) => phones[i].kind === 'v');
    if (!vowels.length) continue;
    const weight = vowels.map((vi, j) => {
      const end = j + 1 < vowels.length ? vowels[j + 1] - 1 : idx[idx.length - 1] + 1;   // next onset excluded
      const coda = Math.max(0, end - vi - 1);
      return (phones[vi].long ? 1 : 0) + Math.min(coda, 2);
    });
    const L = vowels.length;
    let s;
    if (weight[L - 1] >= 2) s = L - 1;
    else if (L >= 2 && weight[L - 2] >= 1) s = L - 2;
    else s = Math.max(0, L - 3);
    const weak = L === 1 && idx.length <= 3;
    for (const i of idx) phones[i].weak = weak;
    phones[vowels[s]].stress = !weak;
  }
}

/** Plan one line: segments with times (seconds from the start of the mouth movement). */
function planLine(text, seconds, { rate, urgent }) {
  const ph = PHON.get(arabicKey(text)) || lettersToPhonetic(text);
  const phones = parsePhonetic(ph);
  markStress(phones);
  const syll = phones.filter((p) => p.kind === 'v').length || 1;
  const phUnits = phones.reduce((s, p) => s + (p.kind === 'p' ? 0 : p.len), 0) || 1;
  const pUnits = phones.reduce((s, p) => s + (p.kind === 'p' ? p.units : 0), 0);
  let r = urgent ? Math.max(rate, 6.5) : rate;
  const room = Math.max(0.5, seconds - 0.15);
  const need = syll * (1 + pUnits / phUnits) / room;                   // rate that would fill the window exactly
  if (need > r) r = Math.min(need, 7.5);                               // speed up, but never gabble
  const unit = (syll / r) / phUnits;
  let t = 0;
  const segs = [];
  const nods = [];
  let lastNod = -9;
  phones.forEach((p, i) => {
    const dur = (p.kind === 'p' ? p.units : p.len) * unit;
    if (p.kind === 'v') {
      let peak = p.weak ? 0.38 : p.stress ? 0.9 : 0.62;
      if (p.long) peak = Math.min(1, peak + 0.08);
      segs.push({ vis: p.vis, t0: t, t1: t + dur, peak, vowel: true, round: p.ph === 'u' || p.ph === 'o' });
      const prev = phones[i - 1], next = phones[i + 1];
      if (p.ph === 'a' && ((prev && BACK.has(prev.ph)) || (next && BACK.has(next.ph)))) {
        segs.push({ vis: 'viseme_O', t0: t, t1: t + dur, peak: 0.15, vowel: true });
      }
      if (p.stress && t - lastNod > 1.0 && phones.filter((q) => q.word === p.word && q.kind === 'v').length >= 2) {
        nods.push({ t, amp: (urgent ? 4.5 : 3.2) * DEG, brow: nods.length % 2 === 0 || urgent });
        lastNod = t;
      }
    } else if (p.kind === 'c') {
      if (p.vis) {
        const closure = p.vis === 'viseme_PP' || p.vis === 'viseme_FF';
        const peak = closure ? (p.vis === 'viseme_PP' ? 1.0 : 0.85) : p.ph === 'r' ? 0.35 : (p.ph === 'w' || p.ph === 'y') ? 0.45 : 0.6;
        segs.push({ vis: p.vis, t0: t, t1: t + dur, peak, closure, round: p.ph === 'w' || p.vis === 'viseme_CH' });
      }
      if (p.ph === 'H' || p.ph === '3') segs.push({ vis: 'jawOpen', t0: t, t1: t + dur, peak: 0.1 });
    }
    t += dur;
  });
  return { text, phonetic: ph, phones, segs, nods, duration: t, rate: r, syllables: syll, unit };
}

/** Envelope of one segment at time t (JALI-style: rise ahead of the sound, hold, fall after it). */
function segWeight(s, t) {
  const dur = s.t1 - s.t0;
  const lead = s.round ? 0.15 : s.closure ? 0.10 : Math.min(0.12, 0.6 * dur + 0.04);
  const tail = s.round ? 0.15 : s.closure ? 0.06 : 0.12;
  if (t < s.t0 - lead || t > s.t1 + tail) return 0;
  const reach = s.t0 + Math.min(0.025, dur / 2);
  if (t < reach) return s.peak * smoothstep(s.t0 - lead, reach, t);
  const holdTo = s.closure ? s.t1 : s.t0 + 0.75 * dur;
  if (t <= holdTo) return s.peak;
  return s.peak * (1 - smoothstep(holdTo, s.t1 + tail, t));
}

// ------------------------------------------------------------------------------------------------- the Face

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** Random generator per face, so the three men never blink or glance together. */
function rng(seed) {
  let s = Math.floor(seed * 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

export class Face {
  /** root: the GLB scene; name: mahmoud | fathy | karim. */
  constructor(root, name) {
    this.name = name;
    this.man = MEN[name] || MEN.karim;
    this.rand = rng(this.man.seed);
    this.meshes = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary || !o.morphTargetInfluences) return;
      const map = new Int16Array(o.morphTargetInfluences.length).fill(-1);
      for (const [n, i] of Object.entries(o.morphTargetDictionary)) if (n in K) map[i] = K[n];
      this.meshes.push({ mesh: o, map });
    });
    this.enabled = this.meshes.length > 0;
    this.hasEyes = false;                            // set by the character when it found eye bones
    this.time = 0;
    this.w = new Float32Array(N);                    // final weights
    this.moodW = new Float32Array(N);
    this.mood = 'neutral';
    this._moodFrom = new Float32Array(N);
    this._moodT0 = -10;
    this._moodPrev = 'neutral';
    this._lifeW = new Float32Array(N);
    this._speechW = new Float32Array(N);
    this._life = [];
    this._nextMouth = 1 + this.rand() * 3;
    this._nextBrow = 0.5 + this.rand() * 3;
    this._nextSwallow = 30 + this.rand() * 50;
    this.line = null;
    this.nod = 0;                                    // radians, head pitch (down) for the stressed syllables
    this.breath = 0;
    // blink
    this.blink = 0;
    this._blinkR = 0;
    this._blinks = [];
    this._nextBlink = 1 + this.rand() * 3;
    this._noBlinkUntil = 0;
    // gaze
    this.lookTarget = null;                          // world point (the player's eyes) or null
    this.gazeYaw = 0; this.gazePitch = 0;            // eye angles in the head frame (degrees), average of both eyes
    this.eyeAngles = [[0, 0], [0, 0]];
    this.headPoint = null;                           // world point the head should turn to (delayed)
    this._dir = new THREE.Vector3(0, 0, 1);          // current gaze direction (world)
    this._dist = 2;
    this._sac = null;
    this._hold = 'hold';
    this._nextShift = 1 + this.rand() * 2;
    this._off = [0, 0];                              // glance offset from the base direction (degrees)
    this._micro = [0, 0];
    this._nextMicro = 0.5;
    this._headHist = [];
    this._hadTarget = false;
    this._eyeMid = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this.frozen = null;
  }

  // ---------------------------------------------------------------------------------------------- public

  setMood(name) {
    if (!RECIPES[name] && name !== 'relieved') return this;
    if (name === this.mood) return this;
    this._moodFrom.set(this.moodW);
    this._moodPrev = this.mood;
    this.mood = name;
    this._moodT0 = this.time;
    if (name === 'alarm') this._noBlinkUntil = this.time + 1.0;       // the first second of fear: eyes stay open
    if (name === 'relieved') this._blinks = [];
    return this;
  }

  /** Speak an Arabic line, starting now. Returns the planned length in seconds (it may run past `seconds`). */
  speak(text, seconds = 3) {
    const urgent = /!/.test(text) || this.mood === 'alarm';
    const plan = planLine(String(text || ''), seconds, { rate: this.man.rate, urgent });
    this.line = { ...plan, start: this.time + 0.15, urgent };
    return plan.duration + 0.15;
  }

  stopSpeaking() { if (this.line) this.line.stopAt = this.time; }
  get speaking() { return !!this.line && this.time < this.line.start + this.line.duration + 0.2; }

  /** Debug / sheets: hold a fixed state. {mood, moodTime, visemes:{name:w}, weights:{name:w}, blink, eyes:[yaw,pitch]} */
  freeze(state) { this.frozen = state ? { moodTime: 3, ...state } : null; return this; }

  // ---------------------------------------------------------------------------------------------- per frame

  /** Clocks, mood, speech, blinks, life and the gaze plan. Call first in the character's update. */
  tick(dt) {
    this.time += dt;
    const t = this.time;
    const f = this.frozen;
    // ---- mood
    if (f) {
      moodTarget(this.moodW, f.mood || 'neutral', f.moodTime, this.man);
    } else {
      const tm = t - this._moodT0;
      moodTarget(_tmpA, this.mood, tm, this.man);
      const onset = (ONSET[this.mood] || 0.45) * this.man.onset;
      const lead = LEAD[this.mood] || LEAD.neutral;
      for (let i = 0; i < N; i++) {
        const n = FACE_KEYS[i];
        let d = lead[region(n)] || 0;
        const s = side(n);
        if (s && s !== this.man.side) d += 0.04;                         // the weaker side starts later
        const e = smooth((tm - d) / onset);
        this.moodW[i] = lerp(this._moodFrom[i], _tmpA[i], e);
      }
    }
    // ---- speech
    this._speech(t);
    // ---- blinks
    this._blinkTick(t, dt);
    // ---- life
    this._lifeTick(t, dt);
    // ---- gaze plan (the eyes are aimed in aim(), once the head is posed)
    if (!f) this._gazeTick(t, dt);
  }

  _speech(t) {
    const sw = this._speechW;
    sw.fill(0);
    this.nod = 0;
    this._vowelOpen = 0;
    this._talk = 0;
    const f = this.frozen;
    const L = this.line;
    let lt = 0, end = 0, urgent = false;
    let pp = 0;
    if (f && f.visemes) {
      for (const [n, v] of Object.entries(f.visemes)) if (n in K) sw[K[n]] = v;
      pp = sw[K.viseme_PP];
      this._talk = 1;
    } else {
      if (!L) return;
      lt = t - L.start;
      end = L.stopAt !== undefined ? Math.min(L.duration, L.stopAt - L.start) : L.duration;
      if (lt > end + 0.4) { this.line = null; return; }
      urgent = L.urgent;
      this._talk = smoothstep(-0.15, 0.05, lt) * (1 - smoothstep(end, end + 0.3, lt));
      if (lt < 0) {                                                  // the breath in before the line
        sw[K.jawOpen] = 0.05 * smoothstep(-0.15, 0, lt);
        return;
      }
      let sum = 0;
      for (const s of L.segs) {
        if (s.t1 + 0.16 < lt || s.t0 - 0.16 > lt || s.t0 > end) continue;
        const w = segWeight(s, lt);
        if (!w) continue;
        const i = K[s.vis];
        if (s.vis === 'viseme_PP') { pp = Math.max(pp, w); continue; }
        if (s.vis === 'jawOpen') { sw[i] = Math.max(sw[i], w); continue; }
        if (w > sw[i]) { sum += w - sw[i]; sw[i] = w; }
      }
      if (sum > 1) for (let i = ARKIT.length; i < N; i++) sw[i] /= sum;     // overlapping shapes must not gape
      for (let i = ARKIT.length; i < N; i++) sw[i] *= (1 - 0.9 * pp);           // b and m close the lips
      sw[K.viseme_PP] = pp;
    }
    const scale = SPEECH_SCALE[(f && f.mood) || this.mood] || 1;
    const aa = sw[K.viseme_aa], E = sw[K.viseme_E], I = sw[K.viseme_I], O = sw[K.viseme_O], U = sw[K.viseme_U];
    this._vowelOpen = clamp(aa + E + I + O + U, 0, 1);
    // the jaw carries most of the opening
    sw[K.jawOpen] += (0.2 * aa + 0.09 * E + 0.12 * O + 0.04 * I + 0.03 * U) * scale;
    if (urgent) { sw[K.mouthStretchLeft] += 0.12 * aa; sw[K.mouthStretchRight] += 0.12 * aa; }
    for (let i = ARKIT.length; i < N; i++) sw[i] *= scale;
    if (f && f.visemes) return;
    // between phrases the mouth stays a little open
    if (lt < end - 0.1 && this._vowelOpen < 0.05 && pp < 0.05) sw[K.jawOpen] = Math.max(sw[K.jawOpen], 0.035);
    // nods and brow lifts on stressed syllables
    for (const n of L.nods) {
      const x = (lt - n.t + 0.05) / 0.22;
      if (x <= 0 || x >= 1) continue;
      const b = Math.sin(Math.PI * x);
      this.nod += n.amp * b;
      if (n.brow) { sw[K.browInnerUp] += 0.12 * b; sw[K.browOuterUpLeft] += 0.1 * b; sw[K.browOuterUpRight] += 0.09 * b; }
    }
  }

  _blinkTick(t, dt) {
    const f = this.frozen;
    if (f) { this.blink = this._blinkR = f.blink || 0; return; }
    if (t >= this._nextBlink && t >= this._noBlinkUntil) {
      this._startBlink(t);
      let rate = BLINKS_PER_MIN[this.mood] || 16;
      if (this.speaking) rate = Math.max(rate, 26);
      const mean = 60 / rate;
      this._nextBlink = t + clamp(-Math.log(1 - this.rand()) * mean, 0.8, mean * 3.5);
      if (this.rand() < 0.12) this._startBlink(t + 0.42);                   // a double blink now and then
    }
    let l = 0, r = 0;
    const slow = this.man.blinkSlow;
    this._blinks = this._blinks.filter((b) => t - b.t < 0.5 * slow);
    for (const b of this._blinks) {
      l = Math.max(l, blinkShape(t - b.t, slow));
      r = Math.max(r, blinkShape(t - b.t - b.lag, slow));
    }
    this.blink = l;
    this._blinkR = r;
  }

  _startBlink(t) { this._blinks.push({ t, lag: 0.002 + this.rand() * 0.006 }); }

  _lifeTick(t, dt) {
    const lw = this._lifeW;
    lw.fill(0);
    if (this.frozen) { this.breath = 0; return; }
    const strong = this.mood === 'alarm' || this.mood === 'stern' || this.mood === 'worried';
    const cap = strong ? 0.15 : 0.3;
    if (t > this._nextMouth) {
      const opts = ['mouthRollLower', 'mouthRollUpper', 'mouthStretchLeft', 'mouthStretchRight', 'mouthPucker', 'mouthPressLeft'];
      if (!this.speaking) this._life.push({ n: opts[Math.floor(this.rand() * opts.length)], v: 0.04 + 0.2 * this.rand() ** 2, t0: t, up: 0.15 + 0.3 * this.rand(), down: 1 + 2.5 * this.rand() });
      this._nextMouth = t + 1 + 4 * this.rand();
    }
    if (t > this._nextBrow) {
      const opts = ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeSquintLeft', 'browDownLeft'];
      const n = opts[Math.floor(this.rand() * opts.length)];
      this._life.push({ n, v: 0.03 + 0.14 * this.rand() ** 2, t0: t, up: 0.2 + 0.3 * this.rand(), down: 0.8 + 2 * this.rand(), pair: n === 'eyeSquintLeft' ? 'eyeSquintRight' : null });
      this._nextBrow = t + 0.5 + 4.5 * this.rand();
    }
    if (t > this._nextSwallow && !this.speaking) {
      this._life.push({ n: 'mouthPressLeft', pair: 'mouthPressRight', v: 0.3, t0: t, up: 0.12, down: 0.3 });
      this._life.push({ n: 'mouthShrugLower', v: 0.2, t0: t, up: 0.12, down: 0.3 });
      this._nextSwallow = t + 30 + 60 * this.rand();
    }
    this._life = this._life.filter((e) => t - e.t0 < e.up + e.down);
    for (const e of this._life) {
      const x = t - e.t0;
      const v = Math.min(cap, e.v) * (x < e.up ? smooth(x / e.up) : 1 - smooth((x - e.up) / e.down));
      lw[K[e.n]] += v;
      if (e.pair) lw[K[e.pair]] += v;
    }
    // breathing: about 21 a minute under alarm (nostrils and chest), slow and invisible otherwise
    const rate = this.mood === 'alarm' ? 0.35 : this.mood === 'worried' ? 0.3 : 0.23;
    this.breath = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * rate + this.man.seed * 6);
    if (this.mood === 'alarm') { lw[K.noseSneerLeft] += 0.07 * this.breath; lw[K.noseSneerRight] += 0.07 * this.breath; }
  }

  _gazeTick(t, dt) {
    const target = this.lookTarget;
    const talking = this.speaking;
    const alarm = this.mood === 'alarm';
    if (!!target !== this._hadTarget) {               // someone to look at appeared (or left): look now, hold
      this._hadTarget = !!target;
      this._off = [0, 0];
      this._hold = target ? 'hold' : 'idle';
      this._nextShift = t + (target ? 2.0 + 1.5 * this.rand() : 1.0 + 2.0 * this.rand());
    }
    if (t >= this._nextShift) {
      const r = this.rand;
      if (target) {
        if (this._hold === 'hold') {
          // glance away: down and to one side, or to the side only
          this._hold = 'away';
          const s = r() < 0.5 ? -1 : 1;
          this._off = alarm ? [s * (14 + 16 * r()), -4 + 8 * r()] : [s * (8 + 12 * r()), -(4 + 10 * r())];
          this._nextShift = t + (alarm ? 0.3 + 0.3 * r() : 0.3 + 0.5 * r());
        } else {
          this._hold = 'hold';
          this._off = [0, 0];
          this._nextShift = t + (alarm ? 0.8 + 0.7 * r() : talking ? 2.0 + 1.5 * r() : 2.5 + 2.0 * r());
        }
      } else {
        this._hold = 'idle';
        const big = r() < 0.25;
        this._off = big ? [(r() < 0.5 ? -1 : 1) * (14 + 12 * r()), -8 + 8 * r()] : [-12 + 24 * r(), -9 + 11 * r()];
        this._nextShift = t + (alarm ? 0.6 + 0.8 * r() : 1.5 + 2.5 * r());
      }
    }
    if (t >= this._nextMicro) {
      this._micro = [(this.rand() - 0.5) * 2.4, (this.rand() - 0.5) * 1.6];
      this._nextMicro = t + 0.8 + 1.7 * this.rand();
    }
  }

  /** Where the eyes and the head should look, once the character knows where its eyes are this frame.
   *  eyeMid: world position between the eyes; fwd / up: the head's forward and up in world. Returns nothing; sets
   *  this._want (world direction of the gaze) and this.headPoint. */
  plan(eyeMid, fwd, up, dt) {
    this._eyeMid.copy(eyeMid);
    this._fwd.copy(fwd);
    this._up.copy(up);
    const target = this.lookTarget;
    let base, dist;
    if (target) {
      base = _v1.subVectors(target, eyeMid);
      dist = Math.max(base.length(), 0.3);
      base.normalize();
    } else {
      base = _v1.copy(fwd);
      dist = 3;
    }
    const want = offsetDir(_v2.copy(base), up, this._off[0] + this._micro[0], this._off[1] + this._micro[1]);
    this._dist = dist;
    // head: towards the base point (and half of a big glance), 50 ms after the eyes
    const headDir = offsetDir(_v3.copy(base), up, Math.abs(this._off[0]) > 12 ? this._off[0] * 0.5 : 0, 0);
    const slot = this._headHist.length > 8 ? this._headHist.shift() : { t: 0, d: new THREE.Vector3() };
    slot.t = this.time;
    slot.d.copy(headDir);
    this._headHist.push(slot);
    while (this._headHist.length > 2 && this.time - this._headHist[1].t >= 0.05) this._headHist.shift();
    const delayed = this._headHist[0].d;
    this.headPoint = target ? (this.headPoint || new THREE.Vector3()).copy(eyeMid).addScaledVector(delayed, dist) : null;
    // saccade or pursuit
    const ang = this._dir.angleTo(want) / DEG;
    if (this._sac) {
      const s = this._sac;
      const k = (this.time - s.t0) / s.dur;
      if (k >= 1) { this._sac = null; this._dir.copy(want); } else this._dir.copy(s.from).lerp(want, smooth(k)).normalize();
    } else if (ang > 3) {
      this._sac = { from: this._dir.clone(), t0: this.time, dur: 0.025 + 0.0024 * ang };
      if (ang > 20 && !this.frozen) this._startBlink(this.time + this._sac.dur * (0.3 + 0.5 * this.rand()));
    } else {
      this._dir.copy(want);
    }
  }

  /** Gaze point in world for this frame (eyes aim at it). */
  gazePoint(out) { return out.copy(this._eyeMid).addScaledVector(this._dir, this._dist); }

  /** Set the eye angles (degrees, in the head's frame: yaw + = his left, pitch + = up), per eye, already clamped. */
  setEyes(l, r) {
    this.eyeAngles[0][0] = l[0]; this.eyeAngles[0][1] = l[1];
    this.eyeAngles[1][0] = r[0]; this.eyeAngles[1][1] = r[1];
    this.gazeYaw = (l[0] + r[0]) / 2;
    this.gazePitch = (l[1] + r[1]) / 2;
  }

  /** Mix the layers and write the morph influences. Call after the eyes are set. */
  commit() {
    const w = this.w;
    const f = this.frozen;
    w.set(this.moodW);
    // speech on top: the mood's lip-closing shapes give way to open vowels, smile and frown are kept at 60 %
    const open = this._vowelOpen || 0;
    const talk = this._talk || 0;
    for (const n of ['mouthPressLeft', 'mouthPressRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthClose']) w[K[n]] *= 1 - open;
    for (const n of ['mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight']) w[K[n]] *= 1 - 0.4 * talk;
    for (let i = 0; i < N; i++) w[i] += this._speechW[i] + this._lifeW[i];
    if (f && f.weights) for (const [n, v] of Object.entries(f.weights)) if (n in K) w[K[n]] = v;
    // lids follow the gaze (the eyeLook units move the lids and the skin around the eye; the eyeball is a bone)
    const pitch = this.gazePitch, yaw = this.gazeYaw;
    w[K.eyeLookUpLeft] = w[K.eyeLookUpRight] = clamp(pitch / 10.6, 0, 1);
    w[K.eyeLookDownLeft] = w[K.eyeLookDownRight] = clamp(-pitch / 15.6, 0, 1);
    const h = clamp(Math.abs(yaw) / 21, 0, 1) * 0.6;
    w[K.eyeLookOutLeft] = yaw > 0 ? h : 0; w[K.eyeLookInRight] = yaw > 0 ? h : 0;
    w[K.eyeLookInLeft] = yaw < 0 ? h : 0; w[K.eyeLookOutRight] = yaw < 0 ? h : 0;
    // blink
    const bl = this.blink, br = this._blinkR;
    w[K.eyeBlinkLeft] = Math.max(w[K.eyeBlinkLeft], bl);
    w[K.eyeBlinkRight] = Math.max(w[K.eyeBlinkRight], br);
    w[K.eyeWideLeft] *= 1 - bl;
    w[K.eyeWideRight] *= 1 - br;
    if (bl > 0.3) { w[K.eyeLookUpLeft] *= 1 - bl; w[K.eyeLookUpRight] *= 1 - br; }
    for (let i = 0; i < N; i++) w[i] = clamp(w[i], 0, 1);
    for (const { mesh, map } of this.meshes) {
      const infl = mesh.morphTargetInfluences;
      for (let j = 0; j < map.length; j++) infl[j] = map[j] >= 0 ? w[map[j]] : 0;
    }
  }

  /** The top weights now (for debug labels). */
  top(n = 4) {
    return FACE_KEYS.map((k, i) => [k, this.w[i]]).filter(([, v]) => v > 0.02).sort((a, b) => b[1] - a[1]).slice(0, n);
  }
}

/** Blink lid closure at time x after its start: 100 ms down, 30 ms shut, 180 ms up (a little slower for Fathy). */
function blinkShape(x, slow = 1) {
  if (x < 0) return 0;
  const down = 0.10 * slow, hold = 0.03 * slow, up = 0.18 * slow;
  if (x < down) { const k = x / down; return k * k; }
  if (x < down + hold) return 1;
  if (x < down + hold + up) { const k = (x - down - hold) / up; return (1 - k) * (1 - k); }
  return 0;
}

/** Turn a unit direction by yaw (about up) and pitch (about the side axis), degrees. */
const _side = new THREE.Vector3();
function offsetDir(dir, up, yaw, pitch) {
  if (yaw) dir.applyAxisAngle(up, yaw * DEG);
  if (pitch) dir.applyAxisAngle(_side.crossVectors(up, dir).normalize(), -pitch * DEG);
  return dir.normalize();
}

// exposed for the debug pages and checks
/** Seconds this man needs to say the line at his own pace: the least a subtitle should stay up for. 0 if unknown. */
export function speechSeconds(who, text) {
  const man = MEN[who];
  if (!man || !text) return 0;
  return planLine(String(text), 60, { rate: man.rate, urgent: /!/.test(text) }).duration + 0.15;
}

export const _internals = { planLine, parsePhonetic, lettersToPhonetic, arabicKey, PHON, RECIPES, MEN, moodTarget, blinkShape };
