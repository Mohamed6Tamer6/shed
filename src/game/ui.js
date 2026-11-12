// Everything the player reads: prompts, subtitles, choice menus, cards. Right-to-left Arabic.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export function createUI() {
  let subtitleTimer = 0, panelKeys = null, infoKey = null;
  const ui = {
    /** True while a menu or card needs the mouse pointer; the game pauses looking around. */
    modal: false,
    onModalChange: () => {},

    progress(f) { $('loadbar').style.width = `${Math.round(f * 100)}%`; },
    loaded() { $('loading').classList.add('done'); },
    hud(on) {
      for (const id of ['crosshair']) $(id).classList.toggle('hidden', !on);
    },

    prompt(text) {
      const p = $('prompt');
      p.classList.toggle('on', !!text);
      $('crosshair').classList.toggle('on', !!text);
      if (text) p.innerHTML = text;
    },

    /** Speech line at the bottom; stays for `seconds`, or a time that fits its length. */
    say(speaker, text, seconds) {
      const s = $('subtitle');
      s.innerHTML = speaker ? `<b>${speaker}:</b>${text}` : text;
      s.classList.add('on');
      clearTimeout(subtitleTimer);
      const ms = (seconds ?? Math.max(2.6, text.length * 0.075)) * 1000;
      subtitleTimer = setTimeout(() => s.classList.remove('on'), ms);
      return ms / 1000;
    },

    objective(title, sub) {
      const o = $('objective');
      o.classList.toggle('hidden', !title);
      if (title) o.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    },

    status(html) {
      const s = $('status');
      s.classList.toggle('hidden', !html);
      if (html) s.innerHTML = html;
    },

    /** Small card describing what you are looking at. Same key twice does not re-render. */
    info(key, title, body) {
      const i = $('info');
      if (!key) { i.classList.remove('on'); infoKey = null; return; }
      if (key !== infoKey) { i.innerHTML = `<h3>${title}</h3>${body}`; infoKey = key; }
      i.classList.add('on');
    },

    gauge(fraction) {
      $('gauge').classList.toggle('hidden', fraction == null);
      if (fraction != null) $('gaugeFill').style.width = `${Math.round(fraction * 100)}%`;
    },

    fade(on) { $('fade').classList.toggle('on', on); },
    fps(text) { $('fps').textContent = text; },

    closePanel() {
      $('panel').classList.add('hidden');
      $('panel').innerHTML = '';
      panelKeys = null;
      ui.setModal(false);
    },
    setModal(on) {
      if (ui.modal === on) return;
      ui.modal = on;
      ui.onModalChange(on);
    },

    /**
     * A question with up to six answers. Number keys or a click choose.
     * options: [{ text, value }] → resolves with the value.
     */
    choose(title, options) {
      return new Promise((resolve) => {
        const p = $('panel');
        p.innerHTML = '';
        if (title) p.append(el('h3', '', title));
        const pick = (o) => { ui.closePanel(); resolve(o.value); };
        options.forEach((o, i) => {
          const b = el('button', 'opt', `<kbd>${i + 1}</kbd><span>${o.text}</span>`);
          b.type = 'button';
          b.addEventListener('click', () => pick(o));
          p.append(b);
        });
        panelKeys = (code) => {
          const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
          if (m && options[m[1] - 1]) { pick(options[m[1] - 1]); return true; }
          return false;
        };
        p.classList.remove('hidden');
        ui.setModal(true);
      });
    },

    /** Put steps in order by clicking them one after another. Resolves with the chosen order (array of values). */
    order(title, steps) {
      return new Promise((resolve) => {
        const p = $('panel');
        const picked = [];
        const render = () => {
          p.innerHTML = '';
          p.append(el('h3', '', title));
          const box = el('div', 'order');
          steps.forEach((s, i) => {
            const at = picked.indexOf(s.value);
            const b = el('button', `opt${at >= 0 ? ' sel' : ''}`, `<span class="n">${at >= 0 ? at + 1 : ''}</span><span>${s.text}</span>`);
            b.type = 'button';
            b.dataset.i = i;
            b.addEventListener('click', () => {
              if (at >= 0) picked.splice(at, 1);
              else picked.push(s.value);
              render();
            });
            box.append(b);
          });
          p.append(box);
          const row = el('div', 'row');
          const ok = el('button', 'primary', 'تأكيد الترتيب');
          ok.type = 'button';
          ok.disabled = picked.length !== steps.length;
          ok.style.opacity = ok.disabled ? 0.45 : 1;
          ok.addEventListener('click', () => { ui.closePanel(); resolve(picked.slice()); });
          const clear = el('button', 'ghost', 'ابدأ من جديد');
          clear.type = 'button';
          clear.addEventListener('click', () => { picked.length = 0; render(); });
          row.append(ok, clear);
          p.append(row);
        };
        render();
        panelKeys = (code) => {
          const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
          if (m && steps[m[1] - 1]) { p.querySelector(`[data-i="${m[1] - 1}"]`).click(); return true; }
          if (code === 'Enter' && picked.length === steps.length) { ui.closePanel(); resolve(picked.slice()); return true; }
          return false;
        };
        p.classList.remove('hidden');
        ui.setModal(true);
      });
    },

    /**
     * The report: several questions, one answer each (or none), plus a short way out.
     * questions: [{ key, text, options: [{ text, value }] }] → resolves { key: value | null, ..., short: bool }
     */
    report(title, questions, shortText) {
      return new Promise((resolve) => {
        const p = $('panel');
        const answers = Object.fromEntries(questions.map((q) => [q.key, null]));
        const render = () => {
          p.innerHTML = '';
          p.append(el('h3', '', title));
          for (const q of questions) {
            p.append(el('div', 'q', q.text));
            const chips = el('div', 'chips');
            for (const o of q.options) {
              const c = el('button', `chip${answers[q.key] === o.value ? ' sel' : ''}`, o.text);
              c.type = 'button';
              c.addEventListener('click', () => { answers[q.key] = answers[q.key] === o.value ? null : o.value; render(); });
              chips.append(c);
            }
            p.append(chips);
          }
          const row = el('div', 'row');
          const send = el('button', 'primary', 'أبلغ م. كريم');
          send.type = 'button';
          send.addEventListener('click', () => { ui.closePanel(); resolve({ ...answers, short: false }); });
          const brief = el('button', 'ghost', shortText);
          brief.type = 'button';
          brief.addEventListener('click', () => { ui.closePanel(); resolve({ ...answers, short: true }); });
          row.append(send, brief);
          p.append(row);
        };
        render();
        panelKeys = () => false;
        p.classList.remove('hidden');
        ui.setModal(true);
      });
    },

    /** Full-screen card. buttons: [{ text, value, primary }] → resolves with the value. */
    card(html, buttons) {
      return new Promise((resolve) => {
        const c = $('card');
        c.innerHTML = html;
        const row = el('div', 'row');
        for (const b of buttons) {
          const btn = el('button', b.primary ? 'primary' : 'ghost', b.text);
          btn.type = 'button';
          btn.addEventListener('click', () => {
            $('screen').classList.add('hidden');
            ui.setModal(false);
            resolve(b.value);
          });
          row.append(btn);
        }
        c.append(row);
        $('screen').classList.remove('hidden');
        ui.setModal(true);
        row.querySelector('button').focus();
      });
    },

    resumeOverlay(on) { $('resume').classList.toggle('hidden', !on); },
    onResumeClick(fn) { $('resume').addEventListener('click', fn); },
    /** Lets an open menu consume a key. Returns true when it did. */
    key(code) { return panelKeys ? panelKeys(code) : false; },
  };
  return ui;
}
