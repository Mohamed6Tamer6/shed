import * as THREE from 'three';

// Scripted playthroughs for automated checks (headless Chrome):
//   play.html?auto=strong|water|co2|rushed|look&shot=<moment>&q=low&ao=0
// The script steps the game by hand at 20 steps per game second without drawing, then draws one
// frame at the chosen moment (or at the end) and prints what happened in a corner of the page.
// Moments: start, fathy, hold, pin, spray, out, report, blaze, end.

const tick = () => new Promise((r) => setTimeout(r, 0));

// Errors the page reports while the script runs (console.error, uncaught errors, rejected promises): printed at the end.
const pageErrors = [];
{
  const keep = (m) => { if (pageErrors.length < 20) pageErrors.push(String(m).slice(0, 300)); };
  const err = console.error.bind(console);
  console.error = (...a) => { keep(a.map((x) => (x && x.stack) || x).join(' ')); err(...a); };
  addEventListener('error', (e) => keep((e.error && e.error.stack) || e.message));
  addEventListener('unhandledrejection', (e) => keep((e.reason && e.reason.stack) || e.reason));
}

export async function autoplay(play, name, shot) {
  const { player, scenario, ui, input, npcs, vm } = play;
  const S = scenario.state;
  const log = [];
  const out = document.createElement('pre');
  out.id = 'autolog';
  out.dir = 'ltr';
  out.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99;margin:0;padding:6px 8px;max-width:70vw;font:11px/1.35 ui-monospace,monospace;color:#bfe3bf;background:rgba(0,0,0,.7);white-space:pre-wrap';
  document.body.append(out);
  if (new URLSearchParams(location.search).get('log') === '0') out.style.display = 'none';
  const say = (line) => { log.push(line); out.textContent = log.join('\n'); };
  player.locked = true;

  let frozen = false;
  const step = async (seconds = 0.05) => {
    for (let t = 0; t < seconds && !frozen; t += 0.05) {
      play.frame(0.05, false);
      await tick();
    }
  };
  const until = async (fn, max = 20) => {
    for (let t = 0; t < max && !frozen; t += 0.05) {
      if (fn()) return true;
      play.frame(0.05, false);
      await tick();
    }
    return fn();
  };
  /** Stop the run at a named moment so it can be drawn as it is. */
  const STOP = { stop: true };
  const moment = async (id) => {
    if (shot !== id) return;
    await step(0.3);
    frozen = true;
    say(`shot: ${id}`);
    throw STOP;
  };
  const key = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code })); dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const lookAt = (x, y, z) => player.lookAtPoint(new THREE.Vector3(x, y, z));
  const head = (who) => { const p = npcs[who].group.position; return [p.x, 1.35, p.z]; };
  const panel = () => document.getElementById('panel').innerText;
  const menu = (text) => until(() => panel().includes(text), 15);
  const stand = (x, z) => player.pos.set(x, 0, z);
  const talk = async (who, option, from) => {
    if (from) stand(...from);
    lookAt(...head(who));
    await step(0.3);
    const cur = play.interact.current;
    if (!cur || cur.id !== who) say(`${who}: looking at ${cur ? cur.id : 'nothing'} from ${player.pos.x.toFixed(2)},${player.pos.z.toFixed(2)}; he is at ${npcs[who].group.position.x.toFixed(2)},${npcs[who].group.position.z.toFixed(2)} moving=${npcs[who].moving} busy=${S.busy}`);
    key('KeyE');
    if (option) {
      const ok = await until(() => panel().length > 0, 8);
      say(`${who}: menu ${ok ? 'shown' : 'MISSING'}`);
      key(option);
      await until(() => !S.busy, 12);
    }
  };
  const take = async (kind, x) => {
    // a step back from the wall, looking at the unit (its handle hangs at 1.2 m): E walks him to it and takes it
    stand(x, -0.55);
    lookAt(x, 1.0, -1.6);
    await step(0.3);
    const target = play.interact.current;
    if (!target || target.id !== kind) say(`take ${kind}: looking at ${target ? target.id : 'nothing'}`);
    key('KeyE');
    say(`take ${kind}: reason menu ${await menu('لماذا') ? 'shown' : 'MISSING'} (held: ${vm.holding ? vm.holding.userData.kind : 'nothing'})`);
  };
  const orderSteps = async (correct) => {
    say(`order menu ${await menu('رتّب') ? 'shown' : 'MISSING'}`);
    for (const k of (correct ? ['Digit3', 'Digit4', 'Digit1', 'Digit2'] : ['Digit1', 'Digit2', 'Digit3', 'Digit4'])) { key(k); await step(0.1); }
    key('Enter');
    await until(() => !S.busy, 5);
  };
  const spray = async (seconds, sweep = true) => {
    stand(-1.25, 0.45);
    input.mouseDown = true;
    let t = 0;
    await until(() => {
      t += 0.05;
      lookAt(-1.54 + (sweep ? 0.16 * Math.sin(t * 5) : 0), 1.0, -1.63);
      return S.fireOut || S.phase !== 'play';
    }, seconds);
  };

  try {
    // start: press the briefing's button
    await until(() => !document.getElementById('screen').classList.contains('hidden'), 3);
    document.querySelector('#card button').click();
    player.locked = true;
    ui.resumeOverlay(false);
    await step(0.5);
    await moment('start');
    await step(3.2);
    await moment('fathy');
    if (name === 'look') {
      // just stand somewhere and look at something: &at=x,z&look=x,y,z
      const q = new URLSearchParams(location.search);
      const at = (q.get('at') || '-1,0.95').split(',').map(Number), to = (q.get('look') || '-1.5,1,-1.7').split(',').map(Number);
      stand(...at);
      lookAt(...to);
      await step(Number(q.get('wait') || 1));
      play.stage.settleExposure();
    } else if (name === 'strong' || name === 'rushed') {
      if (name === 'strong') {
        await until(() => !S.busy, 8);
        await talk('mahmoud', 'Digit1');
        await talk('fathy', 'Digit1');
        stand(-0.9, 0.3);
        for (const p of [[-1.5, 1.0, -1.7], [1.04, 0.8, -1.3], [1.62, 0.5, -0.52]]) { lookAt(...p); await step(0.8); }
      }
      await take('powder', -0.2);
      key('Digit1');
      await orderSteps(true);
      await moment('hold');
      key('KeyR');
      say(`pin pulled: ${await until(() => S.pinPulled, 5)}`);
      await moment('pin');
      if (shot === 'spray') { stand(-1.25, 0.45); lookAt(-1.54, 1.0, -1.63); input.mouseDown = true; await step(2.6); await moment('spray'); }      // the aim takes 1.2 s before powder comes
      await spray(14);
      input.mouseDown = false;
      say(`fire out: ${S.fireOut} at t=${S.t.toFixed(1)} charge=${S.charge.toFixed(2)}`);
      await moment('out');
      await until(() => S.karimHere, 14);
      await step(4);
      await talk('karim', null, [-0.9, 1.35]);
      say(`report menu ${await menu('بلاغك') ? 'shown' : 'MISSING'}`);
      await moment('report');
      const chips = () => [...document.querySelectorAll('#panel .chip')];
      for (const i of [0, 3, 6]) chips()[i].click();
      document.querySelector('#panel .primary').click();
      await step(0.5);
    } else if (name === 'co2') {
      await until(() => !S.busy, 8);
      await talk('fathy', 'Digit1');
      await step(3);
      await take('co2', 0.42);
      key('Digit1');
      if (shot === 'hold') { await step(2.5); await moment('hold'); }
      say(`karim corrected: ${await until(() => S.mistakes.has('co2') && !vm.holding, 20)}`);
      say(`subtitle: ${document.getElementById('subtitle').innerText}`);
      await step(2);                                   // let the hands settle after putting it back
    } else if (name === 'water') {
      await take('water', -0.86);
      key('Digit1');
      say(`insist menu ${await menu('لا وقت') ? 'shown' : 'MISSING'}`);
      key('Digit2');
      await orderSteps(false);
      key('KeyR');
      await until(() => S.pinPulled, 5);
      stand(-1.25, 0.45);
      lookAt(-1.54, 1.0, -1.63);
      input.mouseDown = true;
      say(`blaze started: ${await until(() => S.phase === 'ending', 8)}`);
      await step(4.5);
      await moment('blaze');
      input.mouseDown = false;
      say(`ending card: ${await until(() => !document.getElementById('screen').classList.contains('hidden'), 20)}`);
    }
    await moment('end');
  } catch (err) {
    if (err !== STOP) {
      say(`ERROR ${err.message}`);
      console.error(err);
    }
  }
  say(JSON.stringify({ phase: S.phase, t: +S.t.toFixed(1), alarm: S.alarm, fathy: S.fathyAsked, picks: S.picks, fire: +S.fire.toFixed(2), out: S.fireOut, mistakes: [...S.mistakes], attempt: S.attempt }));
  const card = document.getElementById('card').innerText.split('\n')[0];
  if (!document.getElementById('screen').classList.contains('hidden')) say(`card: ${card}`);
  say(`hands: ${vm.hands ? 'view model' : 'plain stand-in'} · page errors: ${pageErrors.length}${pageErrors.length ? `\n  ${pageErrors.join('\n  ')}` : ''}`);
  // draw inside animation frames so the headless browser's capture has something to show
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => { play.frame(0.016, true); r(); }));
  document.title = 'autoplay done';
}
