/* vt_watch_rules.js — blok „Hlídání" v panelu agenta (T27).
 *
 * Trvalá hlídání „když X, udělej Y", která drží jádro agenta bez modelu
 * (vitulus_agent src/vitulus_claude/agent/watchrules.py).  Blok jen ukazuje
 * seznam a umí Pozastavit / Obnovit / Zrušit; zakládá je majitel větou v chatu.
 *
 *   GET  /agent/api/watch                         → {ok, rules[], shadow_motion}
 *   POST /agent/api/watch/<id>/(pause|resume|cancel)
 *
 * Kontrakt bloku: window.VAgent.registerBlock (viz agent_blocks.js).  Texty
 * rámu přes i18n (watchr.*), co napsalo jádro (popis podmínky a akce), je
 * data a ukazuje se doslova.
 */
(function () {
  'use strict';

  function T(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function ago(ts) {
    if (!ts) return T('watchr.never');
    var s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 90) return T('common.ago.s', {n: Math.round(s)});
    if (s < 5400) return T('common.ago.min', {n: Math.round(s / 60)});
    if (s < 172800) return T('common.ago.h', {n: (s / 3600).toFixed(1)});
    return T('common.ago.d', {n: Math.round(s / 86400)});
  }
  // Čas zablokování: dnes jen HH:MM, jindy i den („7. 11. 23:16").
  function hhmm(ts) {
    var d = new Date(ts * 1000), now = new Date();
    var t = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' +
      (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    if (d.toDateString() === now.toDateString()) return t;
    return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + t;
  }
  // Poslední spuštění: zablokované (novější než provedené) má přednost —
  // „naposled 23:16 zablokováno (dok)", ne „zatím ne".
  function lastText(r) {
    var b = r.last_blocked;
    if (b && b.ts) {
      return T('watchr.blocked', {when: hhmm(b.ts),
        why: T('watchr.block.' + (b.kind || 'other'), {n: b.mission || ''})});
    }
    return T('watchr.last', {when: ago(r.last_fired)});
  }

  var CSS = [
    '.vwr-list{display:flex;flex-direction:column;gap:.5rem}',
    '.vwr-card{border-radius:.6rem;padding:.55rem .7rem;',
    'background:rgba(13,202,240,.06);border:1px solid var(--bs-border-color,#3a3f45)}',
    '.vwr-card.paused,.vwr-card.blind{background:rgba(255,193,7,.07)}',
    '.vwr-head{display:flex;align-items:center;gap:.5rem;min-width:0}',
    '.vwr-id{font-variant-numeric:tabular-nums;opacity:.75;flex:0 0 auto}',
    '.vwr-state{margin-left:auto;flex:0 0 auto;font-size:.78rem;padding:.05rem .45rem;',
    'border-radius:1rem;background:var(--bs-secondary-bg,#2b3035)}',
    '.vwr-main{margin-top:.25rem;overflow-wrap:anywhere;hyphens:auto}',
    '.vwr-sub{font-size:.82rem;opacity:.75;overflow-wrap:anywhere}',
    '.vwr-acts{display:flex;gap:.4rem;margin-top:.4rem;flex-wrap:wrap}',
    '.vwr-acts .btn{min-height:40px}',
    '.vwr-note{font-size:.82rem;opacity:.8;margin-bottom:.4rem}'
  ].join('');

  function injectCss() {
    if (document.getElementById('vwr-css')) return;
    var st = document.createElement('style');
    st.id = 'vwr-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var registered = false;
  function tryRegister() {
    if (registered || !window.VAgent || !window.VAgent.registerBlock) return false;
    registered = true;
    register(window.VAgent);
    return true;
  }
  if (!tryRegister()) {
    window.addEventListener('vagent:ready', tryRegister);
    var waited = 0;
    var timer = setInterval(function () {
      waited += 500;
      if (tryRegister() || waited >= 10000) clearInterval(timer);
    }, 500);
  }

  function register(VA) {
    var box = null, last = null, busy = false;
    injectCss();

    function paint() {
      if (!box) return;
      box.textContent = '';
      if (!last) {
        box.appendChild(el('div', 'vt-muted', T('watchr.loading')));
        return;
      }
      if (last.error) {
        box.appendChild(el('div', 'vagent-errline', T('watchr.error', {e: last.error})));
        return;
      }
      if (last.shadow_motion) {
        box.appendChild(el('div', 'vwr-note', T('watchr.shadow')));
      }
      var rules = last.rules || [];
      if (!rules.length) {
        box.appendChild(el('div', 'vt-muted', T('watchr.empty')));
        return;
      }
      var list = el('div', 'vwr-list');
      rules.forEach(function (r) {
        var card = el('div', 'vwr-card ' + (r.state || ''));
        var head = el('div', 'vwr-head');
        head.appendChild(el('span', 'vwr-id', '#' + r.id));
        head.appendChild(el('span', '', r.moves ? T('watchr.kind.move') : T('watchr.kind.say')));
        head.appendChild(el('span', 'vwr-state', T('watchr.state.' + (r.state || 'active'))));
        card.appendChild(head);
        card.appendChild(el('div', 'vwr-main', r.when + ' → ' + r.action));
        var sub = T(r.mode === 'stream' ? 'watchr.mode.stream' : 'watchr.mode.poll',
                    {s: r.every_s || ''}) + ' · ' + lastText(r);
        if (r.repeat === 'once') sub += ' · ' + T('watchr.repeat.once');
        if (r.state === 'paused' && r.why) sub += ' · ' + r.why;
        card.appendChild(el('div', 'vwr-sub', sub));
        var acts = el('div', 'vwr-acts');
        if (r.state === 'paused') {
          acts.appendChild(button(r, 'resume', 'watchr.resume', 'btn-outline-info'));
        } else {
          acts.appendChild(button(r, 'pause', 'watchr.pause', 'btn-outline-warning'));
        }
        acts.appendChild(button(r, 'cancel', 'watchr.cancel', 'btn-outline-danger'));
        card.appendChild(acts);
        list.appendChild(card);
      });
      box.appendChild(list);
    }

    function button(rule, act, key, cls) {
      var b = el('button', 'btn btn-sm ' + cls, T(key));
      b.type = 'button';
      b.onclick = function () {
        if (busy) return;
        if (act === 'cancel' && !window.confirm(T('watchr.cancel.confirm', {id: rule.id}))) {
          return;
        }
        busy = true;
        b.disabled = true;
        VA.api('/api/watch/' + rule.id + '/' + act, {body: {}, timeout_ms: 8000})
          .then(function () { return poll(); }, function (e) {
            if (VA.notify) VA.notify('error', T('watchr.error', {e: String(e)}));
          })
          .then(function () { busy = false; b.disabled = false; });
      };
      return b;
    }

    function poll() {
      return VA.api('/api/watch', {timeout_ms: 6000}).then(function (d) {
        last = d && d.ok ? d : {error: (d && d.error) || 'agent'};
        paint();
      }, function (e) {
        last = {error: String(e)};
        paint();
      });
    }

    VA.registerBlock({
      id: 'watch', title: T('watchr.title'), titleKey: 'watchr.title', order: 8,
      render: function (root) { box = root; paint(); poll(); },
      onOpen: function () { poll(); },
      poll: {every_ms: 15000, fn: function () { if (box && box.offsetParent) { poll(); } }}
    });
    document.addEventListener('vt:lang', function () { paint(); });
  }
})();
