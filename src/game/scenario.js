import * as THREE from 'three';
import { X, Z, DOOR } from '../building.js';
import { BOARD_SCALE, EXT_SCALE } from '../stage.js';
import { tierName, availableTiers } from '../assets.js';
import { speechSeconds } from './face.js';

// SAF-01 "The Wrong Extinguisher": the situation's rules, lines and endings.
// Wording follows the Arabic situation sheet; lines the sheet does not give are kept short and plain.

const NAMES = { mahmoud: 'محمود', fathy: 'عم فتحي', karim: 'م. كريم' };
const KIND_NAME = { water: 'طفاية الماء', powder: 'طفاية البودرة الجافة', co2: 'طفاية ثاني أكسيد الكربون' };
const CAPACITY = { water: 30, powder: 18, co2: 10 };          // seconds of discharge
const STEP_ORDER = ['pin', 'aim', 'squeeze', 'sweep'];
const STEPS = [
  { value: 'squeeze', text: 'اضغط المقبض.' },
  { value: 'sweep', text: 'حرّك الطفاية من جانب لآخر.' },
  { value: 'pin', text: 'اسحب مسمار الأمان.' },
  { value: 'aim', text: 'قف بحيث يكون الهواء خلفك، ووجّه الخرطوم نحو قاعدة الحريق.' },
];
const INFO = {
  water: ['طفاية ماء (الحمراء)', 'الملصق: للمواد الصلبة مثل الخشب والورق والتبن.<br>علامة الكهرباء عليها مشطوبة.'],
  powder: ['طفاية بودرة جافة', 'الملصق: متعددة الأغراض — مواد صلبة وسوائل وغازات ومعدات كهربائية.'],
  co2: ['طفاية ثاني أكسيد الكربون', 'الملصق: للسوائل القابلة للاشتعال.'],
  board: ['لوحة توصيل كهربائية', 'قوابس كثيرة على لوحة واحدة، وأحد المآخذ محترق ويخرج منه الدخان.<br>هذا حريق كهربائي.'],
  straw: ['أكياس تبن', 'مادة صلبة سريعة الاشتعال، وقريبة من اللوحة.'],
  drum: ['برميل سولار', 'سائل قابل للاشتعال، وقريب من الحريق.'],
};
const LOOKED = { board: 'لوحة التوصيل', straw: 'أكياس التبن', drum: 'برميل السولار' };
const REASONS = {
  water: [{ text: 'لأنها الأقرب.', value: 'near' }, { text: 'لأن الماء يطفئ أي حريق.', value: 'any' }],
  powder: [{ text: 'لأن الحريق كهربائي، والبودرة الجافة تلائمه.', value: 'good' }, { text: 'لأنها في المنتصف، لا أكثر.', value: 'none' }],
  co2: [{ text: 'لأنها لا تترك أثرًا بعد الإطفاء.', value: 'clean' }, { text: 'لأنها تبدو الأقوى.', value: 'strong' }],
};
const INTRO = `
<h1>طفاية الحريق الخطأ</h1>
<p class="note">موقف SAF-01 · دليل الطالب، الوحدة الأولى، الدرس الأول · نحو ١٠ دقائق</p>
<p>مخزن مزرعة، الساعة ١١:٠٠. أنت <b>أحمد</b>، طالب في الصف الأول، وأول من يرى الحريق. الباب خلفك وخالٍ.</p>
<ul>
  <li><b>محمود</b>: زميلك قرب الباب.</li>
  <li><b>عم فتحي</b>: عامل داخل المخزن.</li>
  <li><b>م. كريم</b>: المشرف في المكتب المجاور، يقرر ما يتجاوز دورك.</li>
</ul>
<p>على الحائط ثلاث طفايات. تصرّف كما تعلّمت.</p>
<h2>التحكم</h2>
<p><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> مشي · الفأرة للنظر · <kbd>Shift</kbd> جري · <kbd>E</kbd> تفاعل وكلام<br>
<kbd>R</kbd> سحب مسمار الأمان · الزر الأيسر ضغط المقبض · <kbd>H</kbd> تلميح · <kbd>Esc</kbd> تحرير الفأرة</p>
<p class="note">محاكاة تدريبية في مخزن خيالي، وليست إجراء طوارئ حقيقيًا. لا يُعرض أحد مصابًا.</p>`;

// Extras of the briefing card: on a published build the quality cannot come from the address, so it is chosen
// here and remembered; and a device without a mouse is told what the experience needs.
const TIER_LABEL = { low: 'خفيفة (تحميل أصغر)', web: 'متوسطة', sharp: 'عالية (تحميل أكبر)' };
function introExtras() {
  let html = '';
  if (window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches) {
    html += '<p class="note"><span class="tag bad">تنبيه</span> هذه التجربة تحتاج كمبيوتر بلوحة مفاتيح وفأرة.</p>';
  }
  if (window.SHED_BUILD) {
    const options = availableTiers.filter((t) => TIER_LABEL[t]).map((t) => `<option value="${t}"${t === tierName ? ' selected' : ''}>${TIER_LABEL[t]}</option>`).join('');
    html += `<p><label for="buildQuality">جودة الخامات: </label><select id="buildQuality">${options}</select> <span class="note">يُعاد التحميل عند التغيير.</span></p>`;
  }
  return html;
}
function wireIntroExtras() {
  const select = document.getElementById('buildQuality');
  if (!select) return;
  select.addEventListener('change', () => {
    try { localStorage.setItem('shed.quality', select.value); } catch { /* storage may be blocked: the choice then lasts for this page only */ }
    location.reload();
  });
}

const clock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function createScenario(ctx) {
  const { stage, player, ui, interact, npcs, fx, vm, input } = ctx;
  const { world, camera } = stage;
  const { extinguishers, board, drum, smoke, office } = stage.props;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // Waiting is measured on the game clock (advanced in update), not the wall clock.
  let now = 0;
  const timers = [];
  const wait = (s) => new Promise((resolve) => timers.push({ at: now + s, resolve }));
  const toWorld = (v) => world.localToWorld(v.clone());

  // ---- places (shed space)
  const FIRE = board.userData.smokeOrigin.clone().multiplyScalar(BOARD_SCALE).add(board.position);
  FIRE.y -= 0.03;
  const DOOR_MID = V((DOOR.x0 + DOOR.x1) / 2, 1, Z);
  const SPOT = {
    player: V(-1.0, 0, 0.95),
    mahmoud: V(-0.45, 0, 1.2),
    fathy: V(0.9, 0, -0.25),
    karimDoor: V(-0.35, 0, 2.85),
    mahmoudYard: V(0.85, 0, 3.5),
    fathyYard: V(-2.7, 0, 4.4),
  };

  const S = {
    phase: 'intro', t: 0, busy: false, log: [],
    alarm: false, fathyAsked: false, fathyOut: false, karimHere: false, karimComing: false,
    peopleFirst: null, rushWarned: false,
    seen: new Set(), picks: [], reason: null, mistakes: new Set(),
    order: null, pinPulled: false, squeezeBeforePin: false,
    fire: 0.16, fireOut: false, charge: 1, spraying: false,
    waterTime: 0, badTime: 0, hintAt: -99, lastNag: 0, attempt: 1,
  };
  const note = (text) => S.log.push({ t: S.t, text });

  // ---- effects
  const boardFire = fx.addFire({ parent: world, position: FIRE.clone(), height: 0.3, width: 0.2, light: 0, ceiling: 2.55 });   // smoke spreads under the roof
  const blaze = fx.addStrawBlaze({
    parent: world,
    points: [V(1.0, 1.2, -1.3), V(1.75, 1.0, -1.35), V(1.45, 0.5, -0.95), V(0.7, 0.45, -1.1), V(1.9, 0.6, -0.9)],
    light: 1,
    ceiling: 2.6,
  });
  const jets = { water: fx.createDischarge('water'), powder: fx.createDischarge('powder'), co2: fx.createDischarge('co2') };
  for (const l of fx.lights) l.layers.enable(1);
  boardFire.intensity = 0;
  blaze.intensity = 0;

  // ---- people
  const place = (npc, p, facing) => {
    npc.group.position.copy(p);
    if (facing) npc.group.rotation.y = Math.atan2(facing.x - p.x, facing.z - p.z);
  };
  for (const n of Object.values(npcs)) world.add(n.group);
  place(npcs.mahmoud, SPOT.mahmoud, FIRE);
  place(npcs.fathy, SPOT.fathy, FIRE);
  if (office) place(npcs.karim, office.inside, office.door);
  else place(npcs.karim, V(6, 0, 3), SPOT.karimDoor);

  let speaker = null;
  /** A spoken line: subtitle, talking gesture, resolves when it has been read. */
  async function say(who, text, seconds) {
    const npc = npcs[who];
    let d = ui.say(NAMES[who] || who, text, seconds);
    const need = npc ? speechSeconds(who, text) / 0.85 + 0.25 : 0;      // long enough to be said at this man's own pace
    if (need > d) d = ui.say(NAMES[who] || who, text, need);
    if (npc) {
      speaker = npc;
      if (!npc.moving) npc.setAction('talk');
      npc.lookAt(toWorld(camera.position));
      if (npc.speak) npc.speak(text, d * 0.85);          // lips and face follow the line
    }
    await wait(d * 0.85);
    if (npc && speaker === npc) {
      speaker = null;
      if (!npc.moving) npc.setAction(npc.userData?.rest || 'idle');
    }
  }
  const narrate = (text, seconds) => ui.say('', text, seconds);
  /** How a character feels from now on: 'neutral' | 'worried' | 'alarm' | 'stern' | 'relieved' | 'pleased'. */
  const mood = (who, name) => { for (const w of [].concat(who)) if (npcs[w] && npcs[w].setMood) npcs[w].setMood(name); };
  const ALL = ['mahmoud', 'fathy', 'karim'];
  const present = (who) => {
    const p = npcs[who].group.position;
    return Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < 6;
  };

  function bringKarim(fast = false) {
    if (S.karimHere || S.karimComing) return;
    S.karimComing = true;
    const k = npcs.karim;
    const path = office ? [office.door, V(2.6, 0, 3.45), SPOT.karimDoor] : [SPOT.karimDoor];
    if (fast) place(k, V(1.6, 0, 3.4), SPOT.karimDoor);
    k.walkTo(fast ? [SPOT.karimDoor] : path, {
      run: true,
      onArrive: () => {
        S.karimHere = true;
        S.karimComing = false;
        mood('karim', 'stern');
        k.faceTowards(toWorld(V(FIRE.x, 0, FIRE.z)));
        note('وصل م. كريم إلى باب المخزن.');
        if (S.phase === 'play' && !S.busy && !S.fireOut) say('karim', 'أنا هنا يا أحمد. الباب خلفك وخالٍ.', 3);
      },
    });
  }

  // ---- conversations
  async function talkMahmoud() {
    if (S.busy) return;
    S.busy = true;
    const m = npcs.mahmoud;
    m.faceTowards(toWorld(player.pos));
    if (S.alarm) {
      await say('mahmoud', S.karimHere ? 'م. كريم هنا عند الباب.' : 'بلّغته، وهو في الطريق.');
    } else {
      const v = await ui.choose('محمود', [
        { text: 'محمود! بلّغ م. كريم الآن: حريق في لوحة الكهرباء بالمخزن.', value: 'alarm' },
        { text: 'تعال ساعدني نطفئها بسرعة.', value: 'help' },
        { text: 'لا شيء.', value: null },
      ]);
      if (v === 'alarm') {
        S.alarm = true;
        note('طلبتَ من محمود أن يبلّغ م. كريم.');
        await say('mahmoud', 'حاضر! سأبلّغه حالًا.', 1.6);
        const path = office ? [V(-0.9, 0, 1.5), V(-0.9, 0, 2.7), V(2.6, 0, 3.3), office.door] : [V(-0.9, 0, 2.7), V(2.6, 0, 3.3)];
        m.walkTo(path, {
          run: true,
          onArrive: async () => {
            await wait(1.2);
            bringKarim();
            await wait(0.6);
            m.walkTo([V(2.8, 0, 3.7), SPOT.mahmoudYard], { run: true, onArrive: () => m.faceTowards(toWorld(DOOR_MID)) });
          },
        });
      } else if (v === 'help') {
        await say('mahmoud', 'هل أنت متأكد؟ ألا نُبلّغ م. كريم أولًا؟');
      }
    }
    S.busy = false;
  }

  async function talkFathy() {
    if (S.busy) return;
    S.busy = true;
    const f = npcs.fathy;
    f.faceTowards(toWorld(player.pos));
    if (S.fathyAsked) {
      await say('fathy', 'أنا بعيد عن الخطر يا بني. انتبه لنفسك.');
    } else {
      const v = await ui.choose('عم فتحي', [
        { text: 'عم فتحي، اخرج من المخزن الآن من فضلك.', value: 'out' },
        { text: 'ناولني الطفاية الحمراء بسرعة.', value: 'hand' },
        { text: 'لا شيء.', value: null },
      ]);
      if (v === 'out') {
        S.fathyAsked = true;
        note('طلبتَ من عم فتحي أن يخرج.');
        f.pointAt(null);
        mood('fathy', 'worried');
        await say('fathy', 'حاضر يا بني، أنا خارج.', 1.6);
        f.userData = { rest: 'idle' };
        f.walkTo([V(-0.55, 0, 0.5), V(-1.0, 0, 1.5), V(-1.0, 0, 2.8), SPOT.fathyYard], {
          onArrive: () => { S.fathyOut = true; f.faceTowards(toWorld(DOOR_MID)); },
        });
      } else if (v === 'hand') {
        await say('fathy', 'هي بجوارك، خذها أنت! بسرعة!');
      }
    }
    S.busy = false;
  }

  async function talkKarim() {
    if (S.busy) return;
    S.busy = true;
    const k = npcs.karim;
    k.faceTowards(toWorld(player.pos));
    if (!S.fireOut) {
      await say('karim', S.picks.length ? 'أنا معك. الباب خلفك وخالٍ.' : 'انظر ما الذي يشتعل، ثم اختر الطفاية المناسبة.');
      S.busy = false;
      return;
    }
    await say('karim', 'ماذا حدث؟', 1.4);
    const r = await ui.report('بلاغك إلى م. كريم', [
      { key: 'what', text: 'ما الذي احترق؟', options: [{ text: 'لوحة التوصيل الكهربائية', value: 'board' }, { text: 'أكياس التبن', value: 'straw' }, { text: 'برميل السولار', value: 'drum' }] },
      { key: 'which', text: 'أي طفاية استخدمتَ؟', options: [{ text: 'البودرة الجافة', value: 'powder' }, { text: 'الماء', value: 'water' }, { text: 'ثاني أكسيد الكربون', value: 'co2' }] },
      { key: 'cause', text: 'ما السبب المرجّح؟', options: [{ text: 'قوابس كثيرة على لوحة واحدة', value: 'overload' }, { text: 'شرارة من برميل السولار', value: 'drum' }, { text: 'لا أعرف', value: 'unknown' }] },
    ], 'قل «انطفأت» فقط');
    S.report = r;
    note(r.short ? 'بلاغك: «انطفأت» فقط.' : 'أبلغتَ م. كريم بما حدث.');
    S.busy = false;
    finish();
  }

  // ---- extinguishers
  const held = () => vm.holding;
  const heldKind = () => (vm.holding ? vm.holding.userData.kind : null);

  /** Hangs the held unit back on its bracket: the hands stow the hose, walk him to it and hang it up (about 2.5 s).
   *  `instant` (behind a card or a fade) puts it straight back. Resolves when it hangs there again. */
  async function putBack(instant = false) {
    const ext = vm.holding;
    if (!ext) return;
    jets[ext.userData.kind].stop();
    fx.audio.discharge(null);
    S.spraying = false;
    vm.squeeze(0);
    vm.setReady(false);
    await vm.putBack({ player, instant });
    // the training unit comes back as it was: pin in, full
    ext.userData.pin.visible = true;
    S.pinPulled = false;
    S.charge = 1;
    ui.gauge(null);
    stage.requestShadowUpdate();
  }

  async function pick(kind) {
    if (S.busy || vm.holding || S.fireOut) return;
    S.busy = true;
    const ext = extinguishers[kind];
    if (S.peopleFirst === null) {
      S.peopleFirst = S.alarm && S.fathyAsked;
      if (!S.peopleFirst) S.mistakes.add('rushed');
    }
    // walks to the unit, reaches, takes it off its hook and brings it to his side
    if (!(await vm.take(ext, { player }))) { S.busy = false; return; }
    stage.requestShadowUpdate();
    S.picks.push(kind);
    S.charge = 1;
    S.pinPulled = false;
    note(`أمسكتَ ${KIND_NAME[kind]}.`);

    if (!S.peopleFirst && !S.rushWarned && !npcs.mahmoud.moving && present('mahmoud')) {
      S.rushWarned = true;
      await say('mahmoud', 'هل أنت متأكد؟ ألن نُنذر أحدًا أولًا؟');
    }
    S.reason = await ui.choose('لماذا هذه الطفاية؟', REASONS[kind]);

    if (kind === 'water') {
      await say('mahmoud', 'انتظر — هل هذا حريق كهربائي؟');
      const v = await ui.choose(null, [
        { text: 'معك حق. سأعيدها وأختار غيرها.', value: 'back' },
        { text: 'لا وقت للتفكير — سأستخدمها.', value: 'insist' },
      ]);
      if (v === 'back') {
        S.mistakes.add('waterCorrected');
        note('غيّرتَ رأيك وأعدتَ طفاية الماء.');
        await putBack();
        S.busy = false;
        return;
      }
      S.mistakes.add('waterInsist');
      note('أصررتَ على استخدام الماء.');
    } else if (kind === 'co2') {
      S.mistakes.add('co2');
      bringKarim(true);
      while (!S.karimHere) await wait(0.2);
      await say('karim', 'هذه لحرائق السوائل القابلة للاشتعال. الدليل يقول إن البودرة الجافة تلائم الحرائق الكهربائية.');
      note('نبّهك م. كريم إلى أن ثاني أكسيد الكربون ليس الاختيار المناسب هنا.');
      await putBack();
      narrate('حاول مرة أخرى.', 2);
      S.busy = false;
      return;
    } else if (S.reason !== 'good') {
      S.mistakes.add('reason');
    }

    const order = await ui.order('رتّب خطوات استخدام الطفاية', STEPS);
    S.order = order;
    if (order.join() !== STEP_ORDER.join()) {
      S.mistakes.add('order');
      narrate('الترتيب الصحيح: المسمار، ثم الوقوف والتوجيه نحو القاعدة، ثم الضغط، ثم التحريك من جانب لآخر.', 6);
    }
    ui.objective('استخدم الطفاية', '<kbd>R</kbd> مسمار الأمان · الزر الأيسر للضغط');
    S.busy = false;
  }

  async function pullPin() {
    if (S.busy || !vm.holding || S.pinPulled) return;
    S.busy = true;
    await vm.pullPin();
    S.pinPulled = true;
    note('سحبتَ مسمار الأمان.');
    S.busy = false;
  }

  // ---- what the player aims at: nearest of the back wall, the left wall, the floor
  const aim = new THREE.Vector3(), dir = new THREE.Vector3(), jetO = new THREE.Vector3(), jetD = new THREE.Vector3();
  const sweep = [];
  function aimPoint() {
    const o = camera.position;
    dir.set(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
    let best = 4.5;
    const tryPlane = (t) => { if (t > 0.2 && t < best) best = t; };
    if (dir.z < -1e-3) tryPlane((-Z + 0.05 - o.z) / dir.z);
    if (dir.x < -1e-3) tryPlane((-X + 0.05 - o.x) / dir.x);
    if (dir.x > 1e-3) tryPlane((X - 0.05 - o.x) / dir.x);
    if (dir.y < -1e-3) tryPlane((0.02 - o.y) / dir.y);
    return aim.copy(o).addScaledVector(dir, best);
  }

  async function waterOnBoard() {
    S.phase = 'ending';
    note('أصاب الماء اللوحة، وقفز اللهب إلى التبن.');
    mood(ALL, 'alarm');
    narrate('قفز اللهب إلى التبن!', 3);
    fx.audio.alarmShout();
    for (let k = 0; k <= 1; k += 0.02) {
      blaze.intensity = k;
      boardFire.intensity = Math.min(1, S.fire + k);
      boardFire.setSize(0.3 + 0.5 * k, 0.2 + 0.25 * k);
      fx.audio.fire(0.4 + 0.6 * k);
      if (k > 0.25 && k < 0.3) say('karim', 'اخرجوا! اخرجوا كلكم الآن!', 2.5);
      await wait(0.09);
    }
    jets.water.stop();
    fx.audio.discharge(null);
    ui.fade(true);
    await wait(1.7);
    fx.audio.fire(0);
    await ui.card(`
      <span class="tag bad">النهاية ٣ — ماء على اللوحة</span>
      <h1>أصررتَ على الماء</h1>
      <p>قفز اللهب إلى التبن. خرج الجميع بسلام واتصلوا بالدفاع المدني، لكن المخزن خسرناه.</p>
      <h2>الدرس</h2>
      <p>انظر قبل أن تمسك. لا يُستخدم الماء على حريق كهربائي؛ يقول الدليل إن البودرة الجافة تلائمه.</p>
      <p class="note">يعيدك م. كريم إلى الخطوة ٢: انظر ثم اختر.</p>`,
    [{ text: 'العودة إلى الخطوة ٢', value: 'step2', primary: true }]);
    restartAtStep2();
  }

  function restartAtStep2() {
    if (vm.holding) putBack(true);
    for (const e of Object.values(extinguishers)) { e.userData.pin.visible = true; e.userData.leverPivot.rotation.z = 0; }
    blaze.intensity = 0;
    S.fire = 0.3;
    S.fireOut = false;
    S.waterTime = 0;
    S.picks = [];
    S.order = null;
    S.reason = null;
    S.alarm = true;
    S.fathyAsked = true;
    S.fathyOut = true;
    S.karimHere = true;
    S.karimComing = false;
    S.attempt++;
    boardFire.setSize(0.3, 0.2);
    place(npcs.karim, SPOT.karimDoor, FIRE);
    place(npcs.mahmoud, SPOT.mahmoudYard, DOOR_MID);
    place(npcs.fathy, SPOT.fathyYard, DOOR_MID);
    for (const n of Object.values(npcs)) { n.setAction('idle'); n.pointAt(null); }
    mood('karim', 'stern');
    mood(['mahmoud', 'fathy'], 'worried');
    player.pos.copy(SPOT.player);
    player.yaw = 0;
    player.pitch = -0.05;
    S.phase = 'play';
    ui.fade(false);
    ui.objective('الخطوة ٢ — انظر ثم اختر', 'ما الذي يشتعل؟ وما القريب منه؟');
    note('أعادك م. كريم إلى الخطوة ٢.');
    say('karim', 'من جديد يا أحمد: انظر ما الذي يشتعل، ثم اختر.', 3.5);
    stage.requestShadowUpdate();
  }

  // ---- result
  function finish() {
    S.phase = 'ending';
    const M = S.mistakes, r = S.report || {};
    const notes = [];
    if (M.has('rushed')) notes.push(S.alarm && S.fathyAsked ? 'أمسكتَ الطفاية قبل أن تُنذر الناس، ثم أنذرتهم.' : 'اندفعتَ إلى الطفاية قبل إنذار الناس.');
    if (!S.alarm) notes.push('لم تطلب من محمود أن يبلّغ م. كريم.');
    if (!S.fathyAsked) notes.push('لم تطلب من عم فتحي أن يخرج.');
    if (M.has('waterInsist')) notes.push('أصررتَ على الماء في محاولتك الأولى.');
    if (M.has('waterCorrected')) notes.push('أمسكتَ طفاية الماء أولًا، ثم غيّرت رأيك.');
    if (M.has('co2')) notes.push('اخترتَ ثاني أكسيد الكربون قبل البودرة الجافة.');
    if (M.has('reason')) notes.push('لم تذكر سببًا صحيحًا لاختيارك.');
    if (M.has('order')) notes.push('رتّبتَ خطوات الاستخدام بترتيب غير صحيح.');
    if (M.has('squeeze')) notes.push('حاولتَ الضغط على المقبض قبل سحب مسمار الأمان.');
    if (r.short) notes.push('بلاغك كان «انطفأت» فقط.');
    else {
      if (r.what !== 'board') notes.push(r.what ? 'في البلاغ: الذي احترق هو لوحة التوصيل الكهربائية.' : 'في البلاغ: لم تذكر ما الذي احترق.');
      if (r.which !== 'powder') notes.push(r.which ? 'في البلاغ: الطفاية التي استخدمتها هي البودرة الجافة.' : 'في البلاغ: لم تذكر الطفاية التي استخدمتها.');
      if (r.cause !== 'overload') notes.push(r.cause ? 'في البلاغ: السبب المرجّح قوابس كثيرة على لوحة واحدة.' : 'في البلاغ: لم تذكر السبب المرجّح.');
    }
    const strong = notes.length === 0;
    const good = [];
    if (S.peopleFirst) good.push('وضعتَ الناس والإنذار أولًا.');
    if (S.picks[0] === 'powder' && S.attempt === 1) good.push('اخترتَ البودرة الجافة من أول مرة.');
    if (S.reason === 'good') good.push('ذكرتَ سبب اختيارك.');
    if (S.order && S.order.join() === STEP_ORDER.join()) good.push('رتّبتَ الخطوات الأربع ترتيبًا صحيحًا.');
    if (!r.short && r.what === 'board' && r.which === 'powder' && r.cause === 'overload') good.push('قدّمتَ بلاغًا كاملًا.');
    const li = (a) => a.map((x) => `<li>${x}</li>`).join('');
    const head = strong
      ? `<span class="tag good">النهاية ١ — الأداة الصحيحة بالترتيب الصحيح</span><h1>أحسنت</h1>
         <p>انطفأ الحريق في لحظات. نقل م. كريم القوابس إلى مآخذ منفصلة.</p>`
      : `<span class="tag mid">النهاية ٢ — وصلتَ في النهاية</span><h1>انطفأ الحريق</h1>
         <p>وصلتَ إلى النتيجة، وهذه النقاط تحتاج انتباهك:</p><ul>${li(notes)}</ul>`;
    note(strong ? 'النهاية ١.' : 'النهاية ٢.');
    mood(ALL, strong ? 'pleased' : 'neutral');
    ui.card(`${head}
      ${good.length ? `<h2>ما فعلتَه جيدًا</h2><ul>${li(good)}</ul>` : ''}
      <h2>ما فعلتَه بالترتيب</h2>
      <ul class="timeline">${S.log.map((e) => `<li><time>${clock(e.t)}</time><span>${e.text}</span></li>`).join('')}</ul>
      <h2>الدرس</h2>
      <p>انظر قبل أن تمسك. لا يُستخدم الماء على حريق كهربائي؛ يقول الدليل إن البودرة الجافة تلائمه.</p>
      <p class="note">المصدر: دليل الطالب، الوحدة الأولى، الدرس الأول.<br>
      الحدود: لعبة صفية أساسية، ليست تقييمًا معتمدًا ولا إجراء إطفاء. في حريق حقيقي: أنذر الناس واخرج واطلب المساعدة.
      ينبغي أن يراجع الصياغة ضابط دفاع مدني أو لجنة السلامة بالمدرسة قبل الاستخدام.</p>`,
    [{ text: 'العب من البداية', value: 'again', primary: true }, { text: 'ابقَ في المخزن', value: 'stay' }]).then((v) => {
      if (v === 'again') location.reload();
      else { S.phase = 'free'; ui.objective('انتهى الموقف', 'تجوّل بحرية'); }
    });
  }

  // ---- things to look at and use
  const kinds = ['water', 'powder', 'co2'];
  for (const kind of kinds) {
    const ext = extinguishers[kind], h = (ext.userData.H + 0.14) * EXT_SCALE, r = ext.userData.R * EXT_SCALE;
    interact.add({
      id: kind,
      proxy: interact.box(world, [r * 2 + 0.2, h + 0.06, r * 2 + 0.12], ext.position.clone().add(V(-0.03, h / 2, 0))),
      range: 1.8,                                        // within a step or two: he is walked to it, then reaches
      prompt: () => {
        if (S.phase !== 'play' || S.busy || S.fireOut) return null;
        if (heldKind() === kind) return '<kbd>E</kbd> أعد الطفاية إلى مكانها';
        return vm.holding ? null : `<kbd>E</kbd> خذ ${KIND_NAME[kind]}`;
      },
      use: async () => {
        if (heldKind() === kind) {
          if (S.busy || vm.busy) return;
          S.busy = true;
          note(`أعدتَ ${KIND_NAME[kind]}.`);
          await putBack();
          S.busy = false;
        } else pick(kind);
      },
      info: () => ({ title: INFO[kind][0], body: INFO[kind][1] }),
      onInspect: () => S.seen.add(kind),
    });
  }
  const look = (id, size, pos, range = 3.6) => interact.add({
    id, proxy: interact.box(world, size, pos), range, prompt: () => null,
    info: () => ({ title: INFO[id][0], body: INFO[id][1] }),
    onInspect: () => { if (!S.seen.has(id)) { S.seen.add(id); note(`نظرتَ إلى ${LOOKED[id]}.`); } },
  });
  look('board', [0.75, 0.45, 0.2], V(board.position.x, board.position.y + 0.05, -Z + 0.1));
  look('straw', [1.15, 1.5, 0.75], V(1.04, 0.75, -1.3));
  look('drum', [0.66, 0.9, 0.66], V(drum.position.x, 0.45, drum.position.z));
  const person = (who, talk) => interact.add({
    id: who,
    proxy: interact.box(npcs[who].group, [0.7, 1.85, 0.6], V(0, 0.93, 0)),
    range: 3.2,
    prompt: () => (S.phase === 'play' && !S.busy && !npcs[who].moving ? `<kbd>E</kbd> كلّم ${NAMES[who]}` : null),
    use: talk,
  });
  person('mahmoud', talkMahmoud);
  person('fathy', talkFathy);
  person('karim', talkKarim);

  function hint() {
    if (S.phase !== 'play' || S.t - S.hintAt < 2) return;
    S.hintAt = S.t;
    let h;
    if (S.fireOut) h = 'من يجب أن يعرف ما الذي حدث هنا؟';
    else if (vm.holding && !S.pinPulled) h = 'ما أول خطوة قبل الضغط على المقبض؟';
    else if (vm.holding) h = 'إلى أي جزء من الحريق توجّه الخرطوم؟ وأين يكون الباب منك؟';
    else if (!S.alarm || !S.fathyAsked) h = 'من في المخزن غيرك؟ ومن يجب أن يعرف بالحريق؟';
    else h = 'ما الذي يشتعل بالضبط؟ وماذا يوجد بجواره؟ اقرأ ملصقات الطفايات.';
    narrate(`تلميح: ${h}`, 5);
  }

  input.on('KeyE', () => interact.use());
  input.on('KeyR', () => { if (S.phase === 'play') pullPin(); });
  input.on('KeyH', hint);
  input.onClick(() => { if (!vm.holding) interact.use(); });

  async function opening() {
    await wait(1.4);
    const f = npcs.fathy;
    f.setAction('alarm');
    f.userData = { rest: 'alarm' };
    mood('fathy', 'alarm');
    mood('mahmoud', 'worried');
    f.faceTowards(toWorld(player.pos));
    await wait(0.5);
    f.pointAt(toWorld(extinguishers.water.position.clone().add(V(0, 0.45, 0))));
    await say('fathy', 'اللوحة تدخّن! بسرعة — الأسطوانة الحمراء هنا قريبة، خذها!', 5);
    f.pointAt(null);
    f.faceTowards(toWorld(V(FIRE.x, 0, FIRE.z)));
  }

  const scenario = {
    state: S,
    async start() {
      ui.objective(null);
      const briefing = ui.card(INTRO + introExtras(), [{ text: 'ابدأ', value: 'go', primary: true }]);
      wireIntroExtras();
      await briefing;
      fx.audio.unlock();
      S.phase = 'play';
      ui.hud(true);
      ui.objective('حريق في المخزن', 'تصرّف كما تعلّمت · <kbd>H</kbd> تلميح');
      note('رأيتَ الدخان يخرج من لوحة التوصيل.');
      opening();
    },

    update(dt) {
      now += dt;
      for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= now) timers.splice(i, 1)[0].resolve();
      if (S.phase === 'intro') return;
      if (S.phase === 'play') S.t += dt;

      // prompts and info cards
      const target = interact.update(dt);
      const p = target && target.prompt ? target.prompt() : null;
      ui.prompt(ui.modal ? null : p);
      const info = target && target.info && interact.dwell > 0.45 && !ui.modal ? target.info() : null;
      if (info) ui.info(target.id, info.title, info.body);
      else ui.info(null);

      // fire grows slowly on its own until someone deals with it
      if (S.phase === 'play' && !S.fireOut) S.fire = Math.min(0.62, S.fire + dt * 0.0045);

      // spraying
      const ext = vm.holding;
      const pressing = S.phase === 'play' && ext && input.mouseDown && !ui.modal && !S.busy;
      let spraying = false;
      if (ext) {
        const kind = ext.userData.kind;
        // carried at his side until the pin is out; then the other hand takes the hose (or horn) and aims it
        vm.setReady(S.pinPulled && !vm.busy);
        const aimed = vm.aimed ?? true;
        if (pressing && !S.pinPulled) {
          vm.squeeze(1);                                 // the pin holds the lever: the hand strains, nothing moves
          if (!S.mistakes.has('squeeze')) { S.mistakes.add('squeeze'); note('ضغطتَ المقبض قبل سحب مسمار الأمان.'); }
          if (S.t - S.lastNag > 3.5) { S.lastNag = S.t; narrate('المقبض لا ينضغط: مسمار الأمان ما زال في مكانه.', 3); }
        } else if (pressing && !aimed) {
          vm.squeeze(0);                                 // the hose is still coming up into his hand
        } else if (pressing && S.charge > 0) {
          spraying = true;
          vm.squeeze(1);
          S.charge = Math.max(0, S.charge - dt / CAPACITY[kind]);
          const a = aimPoint();
          vm.getJet(jetO, jetD);
          const aw = toWorld(a);
          jetD.copy(aw).sub(jetO).normalize();
          jets[kind].setEmitter(jetO, jetD);
          jets[kind].setTarget(aw);
          sweep.push(S.t, a.x);
          while (sweep.length && S.t - sweep[0] > 1.0) sweep.splice(0, 2);
          let lo = Infinity, hi = -Infinity;
          for (let i = 1; i < sweep.length; i += 2) { lo = Math.min(lo, sweep[i]); hi = Math.max(hi, sweep[i]); }
          const dBase = a.distanceTo(FIRE);
          const onBase = dBase < 0.34;
          const onFlames = !onBase && Math.abs(a.x - FIRE.x) < 0.35 && a.y > FIRE.y && a.y < FIRE.y + 1.0 && a.z < -Z + 0.3;
          const dist = Math.hypot(player.pos.x - FIRE.x, player.pos.z - FIRE.z);
          const away = V(player.pos.x - FIRE.x, 0, player.pos.z - FIRE.z).normalize();
          const toDoor = V(DOOR_MID.x - FIRE.x, 0, DOOR_MID.z - FIRE.z).normalize();
          const windOK = away.dot(toDoor) > 0.72;
          if (kind === 'water') {
            if (dBase < 0.75) S.waterTime += dt;
            if (S.waterTime > 0.7) waterOnBoard();
          } else if (!S.fireOut) {
            let rate = onBase ? 1 : onFlames ? 0.22 : 0;
            if (hi - lo < 0.1) rate *= 0.55;
            if (!windOK) rate *= 0.45;
            if (dist < 0.85 || dist > 3.7) rate *= 0.4;
            S.fire -= rate * dt * 0.11;
            if (rate < 0.5) {
              S.badTime += dt;
              if (S.badTime > 1.6 && S.t - S.lastNag > 4) {
                S.lastNag = S.t;
                S.badTime = 0;
                narrate(!onBase ? 'وجّه الخرطوم نحو قاعدة اللهب، لا نحو أعلاه.' : !windOK ? 'البودرة ترتدّ نحوك: قف والباب خلفك.' : dist > 3.7 ? 'أنت بعيد: اقترب قليلًا.' : dist < 0.85 ? 'أنت قريب جدًا: ارجع خطوة.' : 'حرّك الطفاية من جانب لآخر على قاعدة اللهب.', 3.5);
              }
            } else S.badTime = 0;
            if (S.fire <= 0.02) {
              S.fire = 0;
              S.fireOut = true;
              note('انطفأ الحريق.');
              mood(ALL, 'relieved');
              ui.objective('أبلغ م. كريم', 'قل له ما الذي حدث');
              if (!S.karimHere) bringKarim();
              wait(1.6).then(() => { if (S.phase === 'play') say('karim', 'انطفأ. تعالَ وأخبرني بما حدث.', 3.5); });
            }
          }
        } else {
          vm.squeeze(0);
          if (pressing && S.charge <= 0 && !S.fireOut && S.phase === 'play' && S.t - S.lastNag > 5) {
            S.lastNag = S.t;
            narrate('فرغت الطفاية.', 3);
          }
        }
        ui.gauge(S.charge);
        if (spraying !== S.spraying) {
          S.spraying = spraying;
          if (spraying) jets[kind].start(); else jets[kind].stop();
          fx.audio.discharge(spraying ? kind : null);
        }
      } else if (S.spraying) {
        S.spraying = false;
        fx.audio.discharge(null);
      }
      player.slow = !!ext;

      // the fire itself
      if (S.phase !== 'ending') {
        boardFire.intensity += (S.fire - boardFire.intensity) * Math.min(1, dt * 4);
        boardFire.setSize(0.22 + 0.5 * S.fire, 0.16 + 0.22 * S.fire);
        fx.audio.fire(S.fire * 0.8);
      }
      smoke.visible = (S.fire > 0 && S.fire < 0.3) || S.fireOut;
      S.burn = Math.max(S.burn || 0, S.fire * 1.5, S.phase === 'ending' && blaze.intensity > 0.5 ? 1 : 0);
      board.userData.setBurn(S.burn);

      // people keep an eye on you while you are close, unless they are walking or pointing
      const eye = toWorld(camera.position);
      for (const who of Object.keys(npcs)) {
        const n = npcs[who];
        if (n.moving) { n.lookAt(null); continue; }
        const d = n.group.position.distanceTo(player.pos);
        n.lookAt(d < 4.5 ? eye : null);
      }
      if (S.phase === 'play' && !S.fathyAsked && !S.picks.length && S.t - S.lastNag > 28 && !S.busy && !ui.modal) {
        S.lastNag = S.t;
        say('fathy', 'بسرعة يا أحمد!', 2);
      }
    },
  };
  return scenario;
}
