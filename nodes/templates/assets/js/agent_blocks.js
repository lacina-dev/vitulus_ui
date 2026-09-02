/* agent_blocks.js — extra bloky agentního panelu ve vitulus_ui.
 *
 * Doplňuje shell v agent_chat.js (blok "chat", "práce", "úkoly", "schválení") o:
 *   robot   (order 30) — stav robota + náhled mapy (/api/state, /api/mapview)
 *   mise    (order 40) — běžící/odstavená mise (/api/missions)
 *   zdravi  (order 50) — nálezy doktora, senses/selfcare, příští vizita (/api/doctor)
 *   nastroje(order 60) — nástroje, skills, růst schopností (/api/growth)
 *
 * Kontrakt: window.VAgent.registerBlock({id,title,order,summaryExtra,render,poll,onOpen}),
 * VAgent.api(path,opts) -> Promise<json>, VAgent.notify(kind,text),
 * VAgent.submitText(text, meta), VAgent.activateTab(id), VAgent.highlightJob(id),
 * VAgent.incidentActions(id,title,text), VAgent.actionButtons(container,id,actions),
 * VAgent.state (poslední /api/state + /api/health). Registrace je defenzivní:
 * když VAgent při načtení není, čeká se na event 'vagent:ready' a zároveň se
 * 10 s polluje — pořadí <script> tagů pak nerozhoduje.
 *
 * Vzhled: třídy v agent_panel.css (vz-* zdraví, vm-* mise, vt-* nástroje),
 * jen --bs-* proměnné, žádné externí knihovny, chyby se kreslí do bloku.
 */
(function () {
  'use strict';

  /* The base is resolved by agent_chat.js (the same-origin /agent proxy under
     webnode), so ask it every time instead of guessing here. */
  var AGENT_HTTP = '/agent';                     // used only before VAgent loads
  function agentBase(VA) {
    if (VA && typeof VA.httpBase === 'function') { return VA.httpBase(); }
    if (window.VAgent && typeof window.VAgent.httpBase === 'function') {
      return window.VAgent.httpBase();
    }
    return AGENT_HTTP;
  }

  // ---- registrace ---------------------------------------------------------
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

  // ---- drobné utility -----------------------------------------------------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var s = Math.max(0, (Date.now() / 1000) - ts);
    if (s < 90) return Math.round(s) + ' s';
    if (s < 5400) return Math.round(s / 60) + ' min';
    if (s < 172800) return (s / 3600).toFixed(1) + ' h';
    return Math.round(s / 86400) + ' d';
  }
  function fmtIn(ts) {
    if (!ts) return '—';
    var s = ts - Date.now() / 1000;
    if (s < 0) return 'now';
    if (s < 90) return 'in ' + Math.round(s) + ' s';
    if (s < 5400) return 'in ' + Math.round(s / 60) + ' min';
    return 'in ' + (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' h';
  }
  function fmtAbs(ts) {
    if (!ts) return '';
    try { return new Date(ts * 1000).toLocaleString('cs-CZ'); } catch (e) { return ''; }
  }
  function fmtClock(ts) {
    var d = new Date((ts || 0) * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function fmtElapsed(startTs) {
    if (!startTs) return '';
    var s = Math.max(0, (Date.now() / 1000) - startTs);
    return s < 90 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min';
  }
  /* ---- age: a LENGTH is not a MOMENT (U40) --------------------------------
     The core reports how old a thing was WHEN IT ANSWERED (`age_s`,
     a length in seconds).  Turning that into what the owner reads needs the
     moment the answer arrived — `__at`, stamped on every response by the
     shared api() in agent_chat.js — because the picture keeps ageing after
     the answer stops changing.

     The bug this closes: the panel built the capture moment as
     `Date.now()/1000 - age_s`, i.e. it pretended the answer had JUST come in,
     every single time it redrew.  fmtAgo() then handed back exactly `age_s`
     for ever: „taken 0 s ago" over a picture two minutes old, and the red
     „older than two minutes" branch could never fire from the passing of
     time — only from a number the core happened to send.

     capturedAt(res, ageS) is the only way this file turns a length into a
     moment; nothing computes an age from `Date.now()` and a length any more.
     A chip made by ageChip() also re-reads its own clock once a second, so
     the number on screen is a measurement and not a memory. */
  function capturedAt(res, ageS) {
    if (ageS == null || isNaN(Number(ageS))) { return null; }
    // no __at (a hand-made object, an old response) -> assume it is fresh,
    // which is the same guess the code used to make, but only ONCE and only
    // at the moment the object appears
    var atMs = (res && res.__at) ? Number(res.__at) : Date.now();
    return atMs / 1000 - Number(ageS);
  }

  var ageTicker = null;
  function paintAge(n) {
    var at = Number(n.getAttribute('data-age-at'));
    if (!at) { return; }
    n.textContent = (n.getAttribute('data-age-pre') || '') + fmtAgo(at) +
                    (n.getAttribute('data-age-post') || '');
    var warn = Number(n.getAttribute('data-age-warn') || 0);
    if (warn) {
      var stale = (Date.now() / 1000 - at) > warn;
      n.classList.toggle('failed', stale);
      n.classList.toggle('done', !stale);
    }
  }
  function tickAges() {
    var nodes = document.querySelectorAll('[data-age-at]');
    for (var i = 0; i < nodes.length; i++) { paintAge(nodes[i]); }
  }
  function startAgeTicker() {
    if (ageTicker) { return; }
    /* Clock only: no network, no /api call — U2 stays closed.  There is no
       `document.hidden` gate on purpose: an age that stops while you are
       looking somewhere else is exactly the fault this fixes, and a
       querySelectorAll over a panel once a second costs nothing (browsers
       throttle background timers to 1 Hz anyway). */
    ageTicker = setInterval(function () { try { tickAges(); } catch (e) {} }, 1000);
    /* A browser throttles timers in a tab nobody is looking at — down to
       once a minute — so the second the tab (or the panel) comes back into
       view, every age is re-read from its own timestamp rather than waiting
       for the next tick.  The number on screen is a measurement taken now;
       the timer is only how often it is refreshed. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { try { tickAges(); } catch (e) {} }
    });
  }

  /* A chip that keeps ageing on screen.  `warnS` is the age at which it turns
     red — and it now turns red because TIME PASSED, not only because the core
     said so. */
  function ageChip(capturedAtSec, opts) {
    opts = opts || {};
    var c = el('span', 'vagent-pill');
    if (capturedAtSec == null) {
      c.className += ' queued';
      c.textContent = opts.unknown || 'age unknown';
      c.title = opts.unknownTitle ||
        'The core did not say when this was taken — treat it as unknown, ' +
        'not as fresh.';
      return c;
    }
    c.setAttribute('data-age-at', String(Math.round(capturedAtSec * 1000) / 1000));
    c.setAttribute('data-age-pre', opts.pre || '');
    c.setAttribute('data-age-post', opts.post || '');
    if (opts.warnS) { c.setAttribute('data-age-warn', String(opts.warnS)); }
    c.className += ' done';
    if (opts.title) { c.title = opts.title; }
    // paint it NOW, on the node itself: it is not in the document yet, so a
    // querySelectorAll sweep would not find it and the chip would be born blank
    paintAge(c);
    startAgeTicker();
    return c;
  }

  function pill(text, color) {
    var p = el('span', null, text);
    p.style.cssText = 'display:inline-block;padding:0 .45em;border-radius:.6em;' +
      'font-size:.75em;line-height:1.5;margin-right:.35em;color:#fff;background:' +
      (color || 'var(--bs-secondary)');
    return p;
  }
  function errLine(box, message) {
    box.textContent = '';
    var e = el('div', null, message);
    e.style.cssText = 'color:var(--bs-danger);font-size:.85em;padding:.25em 0';
    box.appendChild(e);
  }
  function row(label, value) {
    var r = el('div');
    r.style.cssText = 'display:flex;justify-content:space-between;gap:.6em;' +
      'padding:.1em 0;font-size:.9em';
    var l = el('span', null, label);
    l.style.color = 'var(--bs-gray-500, #888)';
    // a value may arrive as a NODE (VAgent.num(), an age chip) so that it can
    // carry its own provenance in `data-src`; a plain string still works
    var v;
    if (value && value.nodeType === 1) { v = value; }
    else { v = el('span', null, value == null ? '—' : String(value)); }
    v.style.fontWeight = '500';
    r.appendChild(l); r.appendChild(v);
    return r;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function badge(cls) {
    var b = el('span', 'vagent-cnt' + (cls ? ' ' + cls : ''));
    return b;
  }

  /* ---- redraw discipline (Robert: „nějaký update mi to zase vrátí do
     nerozkliknutého stavu") -----------------------------------------------
     1. A poll that brings the SAME data must not touch the DOM at all —
        every block keeps a fingerprint of what it last rendered.
     2. What the user opened lives outside the DOM: a Set of keys
        "<id>:<section>" mirrored to sessionStorage, applied on every render.
     3. No redraw under the user's hand: hover / focus inside the block or a
        click in the last 3 s defers the redraw until the coast is clear. */
  var OPEN_KEY = 'vitulus_agent_open_sections';
  var openSet = (function () {
    var s = new Set();
    try { JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]').forEach(function (k) { s.add(k); }); } catch (e) {}
    return s;
  })();
  function saveOpen() {
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(Array.from(openSet))); } catch (e) {}
  }
  function isOpen(key, dflt) { return openSet.has(key) ? true : (openSet.has('!' + key) ? false : !!dflt); }
  function setOpen(key, open) {
    if (open) { openSet.add(key); openSet.delete('!' + key); }
    else { openSet.delete(key); openSet.add('!' + key); }
    saveOpen();
  }
  var lastClick = 0;
  document.addEventListener('pointerdown', function () { lastClick = Date.now(); }, true);
  document.addEventListener('keydown', function () { lastClick = Date.now(); }, true);
  function interacting(box) {
    if (!box) return false;
    if (Date.now() - lastClick < 3000 && box.contains(document.activeElement)) return true;
    if (Date.now() - lastClick < 3000) return true;
    try { if (box.matches(':hover')) return true; } catch (e) {}
    if (document.activeElement && box.contains(document.activeElement) &&
        document.activeElement !== document.body) return true;
    return false;
  }
  var deferred = {};
  function whenIdle(name, box, fn) {
    if (!interacting(box)) { delete deferred[name]; fn(); return; }
    if (deferred[name]) return;
    deferred[name] = setInterval(function () {
      if (interacting(box)) return;
      clearInterval(deferred[name]); delete deferred[name]; fn();
    }, 1500);
  }
  function fp(obj) { try { return JSON.stringify(obj); } catch (e) { return String(Math.random()); } }
  function cssEsc(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&');
  }
  function apiUnavailable(box, what, err) {
    var e = el('div', 'vagent-empty',
      what + ': ' + (/HTTP 404/.test(String(err)) ? 'API not available yet' : 'the agent (/agent) is not responding'));
    box.textContent = '';
    box.appendChild(e);
  }

  function register(VA) {

    // ---- blok: Dokový zámek ----------------------------------------------
    /* Rozhodnutí majitele (30. 8.): „Dokovy zamek muzu odemknout jen ja
       kliknutim v ui."  Tahle karta je to kliknutí — a proto ukazuje ROZSAH,
       ne sloveso: kterou akci, jak dlouho, kolikrát, kdo to podepisuje.
       Jednorázové svolení, druhé klepnutí na potvrzení, po použití zaniká.
       Vynucuje to jádro (v2/ros_wire), tohle je jen lidská půlka. */
    var dockBox = null, dockTick = null, dockGrantOpen = false;

    VA.registerBlock({
      id: 'dock', title: 'Dock lock', order: 5,
      render: function (root) { dockBox = root; drawDock(VA); },
      onOpen: function () { if (VA.dock) { VA.dock.poll(true); } drawDock(VA); }
    });

    document.addEventListener('vagent:dock', function () { drawDock(VA); });

    function dockRow(label, value) {
      var r = el('div', 'dk-r');
      r.appendChild(el('span', 'dk-l', label));
      r.appendChild(el('span', 'dk-v', value));
      return r;
    }

    function drawDock(VA) {
      if (!dockBox || !VA.dock) return;
      var st = VA.dock.state();
      var rel = st.release;
      var live = rel && VA.dock.left(rel) > 0 && VA.dock.usesLeft(rel) > 0;
      /* While the owner is reading WHAT he is about to allow, a 5 s poll must
         not pull the card out from under him — caught in the browser doing
         exactly that.  The scope panel stays until he decides or cancels;
         a release appearing (or the endpoint going away) still wins. */
      if (dockGrantOpen && !live && st.supported === true) { return; }
      if (dockTick) { clearInterval(dockTick); dockTick = null; }
      dockBox.textContent = '';

      var head = el('div', 'dk-h');
      var pill = el('span', 'dk-pill ' + (live ? 'open' : 'shut'),
                    live ? 'UNLOCKED' : 'LOCKED');
      head.appendChild(pill);
      dockBox.appendChild(head);

      if (st.supported === false) {
        dockBox.appendChild(el('div', 'dk-note',
          'The robot stays in the dock. This robot\u2019s agent does not serve ' +
          'the unlock endpoint yet, so there is nothing to click — and nothing ' +
          'can move without it.'));
        return;
      }
      if (st.supported === null) {
        dockBox.appendChild(el('div', 'dk-note', 'Reading the lock\u2026'));
        return;
      }

      if (live) {
        dockBox.appendChild(dockRow('Allowed', (rel.actions || []).join(', ')));
        dockBox.appendChild(dockRow('Uses left',
          VA.dock.usesLeft(rel) + ' of ' + (rel.max_runs || 1)));
        var leftRow = dockRow('Expires in', VA.dock.mmss(VA.dock.left(rel)));
        dockBox.appendChild(leftRow);
        dockBox.appendChild(dockRow('Signed by', rel.by || '?'));
        if (rel.used) {
          dockBox.appendChild(el('div', 'dk-note',
            'Already used ' + rel.used + '\u00d7.'));
        }
        var back = el('button', 'dk-btn dk-back', 'Lock again');
        back.type = 'button';
        back.title = 'Take the permission back now';
        back.addEventListener('click', function () {
          back.disabled = true;
          VA.dock.relock().catch(function () { back.disabled = false; });
        });
        dockBox.appendChild(back);
        // the countdown is display only; the core decides when it is over
        dockTick = setInterval(function () {
          var l = VA.dock.left(rel);
          leftRow.querySelector('.dk-v').textContent = VA.dock.mmss(l);
          if (l <= 0) { clearInterval(dockTick); dockTick = null; drawDock(VA); }
        }, 1000);
        return;
      }

      dockBox.appendChild(el('div', 'dk-note',
        'The robot cannot leave the dock. Only you can allow it, only here, ' +
        'and only for the named moves below \u2014 one go at a time.'));
      VA.dock.grants().forEach(function (g) {
        var open = el('button', 'dk-btn', g.button);
        open.type = 'button';
        open.title = g.actions.join(' + ');
        open.addEventListener('click', function () { drawGrant(VA, g); });
        dockBox.appendChild(open);
      });
    }

    /* The scope, written out.  The owner should see WHAT he is allowing,
       not just a verb — so every field of the grant is on the card before
       the button that gives it. */
    function drawGrant(VA, g) {
      dockGrantOpen = true;
      dockBox.textContent = '';
      var head = el('div', 'dk-h');
      head.appendChild(el('span', 'dk-pill shut', 'LOCKED'));
      dockBox.appendChild(head);
      dockBox.appendChild(el('div', 'dk-title', g.title));
      g.lines.forEach(function (pair) {
        dockBox.appendChild(dockRow(pair[0], pair[1]));
      });
      var until = new Date(Date.now() + g.ttl_s * 1000);
      dockBox.appendChild(dockRow('Until',
        ('0' + until.getHours()).slice(-2) + ':' +
        ('0' + until.getMinutes()).slice(-2)));

      var row = el('div', 'dk-acts');
      var yes = el('button', 'dk-btn dk-yes', 'Unlock \u2014 tap again to confirm');
      yes.type = 'button';
      var armed = false, timer = null;
      yes.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          yes.textContent = 'Yes \u2014 unlock the dock';
          yes.classList.add('armed');
          timer = setTimeout(function () {
            armed = false;
            yes.classList.remove('armed');
            yes.textContent = 'Unlock \u2014 tap again to confirm';
          }, 6000);
          return;
        }
        if (timer) { clearTimeout(timer); }
        yes.disabled = true;
        yes.textContent = 'Unlocking\u2026';
        VA.dock.unlock(g).then(function (d) {
          if (!d || d.ok === false) {
            // stay on the card: the refusal has to stay readable, and a
            // poll must not wipe it away
            yes.disabled = false;
            armed = false;
            yes.textContent = 'Unlock \u2014 tap again to confirm';
            dockBox.appendChild(el('div', 'dk-err',
              'Not unlocked: ' + ((d && d.error) || 'the core refused it')));
            return;
          }
          dockGrantOpen = false;
          drawDock(VA);
        }).catch(function (e) {
          yes.disabled = false;
          armed = false;
          yes.textContent = 'Unlock \u2014 tap again to confirm';
          dockBox.appendChild(el('div', 'dk-err',
            /HTTP 404/.test(String(e))
              ? 'Not unlocked: this agent does not serve the unlock endpoint yet.'
              : 'Not unlocked: ' + e));
        });
      });
      row.appendChild(yes);
      var no = el('button', 'dk-btn', 'Cancel');
      no.type = 'button';
      no.addEventListener('click', function () { dockGrantOpen = false; drawDock(VA); });
      row.appendChild(no);
      dockBox.appendChild(row);
    }

    // ---- blok: Modely a poskytovatelé -------------------------------------
    /* Majitel (31. 8.): „Jinak ja potrebuju prepinat ty modely. […] potrrebuju
       mit moznost menit modely", „ne ja chci poradne reseni, zadna
       provizoria", „chci menit modely a poskytovatele i hermesovi."

       Tenhle tab je ta obrazovka.  Schválně to NENÍ editor YAMLu: jméno modelu
       i jméno poskytovatele se vybírá ze seznamu od jádra (překlep dnes
       znamená tiše zhasnutý backend), u každého druhu práce je vidět, co stojí,
       a zábrany jsou napsané lidsky — ne jako záhadná chyba po uložení.

       DVĚ VĚCI, KTERÉ SE TU NESMÍ ZTRATIT:

       1. `vendor` (dodavatel) NEODVOZUJEME Z NÁZVU.  Bere se výhradně ten,
          který v tu chvíli poslal server — a u backendu, který nese
          `provider_choices` (dnes Hermes), jde dodavatel S POSKYTOVATELEM.
          Přesunout Hermese na DeepSeek tedy změní i jeho dodavatele, takže
          dvojice soudce/vykonavatel, která byla před vteřinou zakázaná, může
          být povolená — a naopak.  Proto se všechno počítá z `mdPlan()`
          (co by platilo, kdybych teď uložil), ne z toho, co server poslal.
          Bez toho by zábrana chránila stav, který už neplatí.

       2. Účtování NENÍ podmínka.  Chybějící nebo odhadnutá cena se ukáže jako
          odhad a Save se kvůli ní nezamyká — sloupec s cenou je na tabu to
          nejcennější, ale brzdou být nesmí.

       Lidská jména druhů prací, seznamy modelů, ceny i stav zdrojů dodává
       jádro (`GET /api/models` -> `model.assignment_view()`).  Anglické názvy
       rolí jsou překlad TÉHOŽ, co jádro pošle česky (rám anglicky, směrnice
       z 24. 8.); původní česká věta zůstává v tooltipu, takže se nic neztrácí,
       a neznámou roli vypíšeme tak, jak ji jádro pojmenovalo. */

    var mdBox = null, mdData = null, mdDraft = null, mdState = null,
        mdProblems = [], mdErr = null, mdSaving = false, mdShowLocked = false,
        mdSaved = 0;

    /* Anglický rám nad českými jmény roli z jádra. */
    /* U36, and the line this panel keeps: ENGLISH IS THE FRAME — every word
       the panel writes itself (labels, buttons, statuses, headings).  What
       the CORE wrote for the owner (rules, `problems`, refusals, role notes)
       is shown in the core's own words, verbatim, and is never paraphrased
       away — a warning that gets translated by whoever is passing it on is
       a warning that eventually stops arriving.  The tab drifted the other
       way tonight: `operator` split into `chat` + `robot`, the frame did not
       know the two new names, so it fell through to the core's Czech labels
       and put them in an English column. */
    var MD_ROLE_EN = {
      coder: 'Working with code',
      chat: 'Answering in chat',
      robot: 'Driving the robot',
      operator: 'Chat and robot together (old, replaced by the two above)',
      checker: 'Judging finished work',
      reflector: 'Lessons from finished work',
      grower: 'Looking for gaps in its own skills',
      triage: 'Sorting (one word, cheapest model)'
    };
    var MD_NOTE_EN = {
      chat: 'Talking to the owner. Safe to switch any time — it wants ' +
            'personality, continuity, speed and a low price, and there is ' +
            'a lot of it.',
      robot: 'DRIVES A MACHINE THAT MOVES. Change it deliberately and ' +
             'rarely. When it fails nothing stands in for it — the work ' +
             'waits instead.',
      operator: 'The old shared name for chat and robot. While it is still ' +
                'set it applies to both of the new roles — set those two ' +
                'instead.',
      checker: 'Must be a different vendor than the code work, or the agent ' +
               'marks its own homework.',
      reflector: 'Must be a different vendor than the code work.',
      grower: 'Must be a different vendor than the code work.'
    };
    var MD_BACKEND_EN = {
      claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek',
      hermes: 'Hermes — the robot’s own agent'
    };
    var MD_STATUS_EN = {
      ok: 'available', limited: 'rate limited', rate_limited: 'rate limited',
      quota_exhausted: 'quota used up', exhausted: 'quota used up',
      no_key: 'no key', down: 'not answering', unknown: 'unknown'
    };
    var MD_SOURCE_EN = {
      provider: 'list came from the provider itself',
      cache: 'list came from the provider’s own cache file',
      fixed: 'fixed aliases of the command-line tool',
      config: 'only what the config file happens to name',
      unknown: 'nobody here knows this provider’s models — pick the ' +
               'default and let it say what it runs'
    };

    VA.registerBlock({
      id: 'models', title: 'Models', order: 70,
      render: function (root) { mdBox = root; drawModels(VA); pollModels(VA); },
      // Opening the tab always asks again: „not served yet" is a statement
      // about a moment, not a verdict, and the endpoint may land while the
      // page is open.
      onOpen: function () { pollModels(VA, true); },
      poll: { every_ms: 30000, fn: function () {
        if (!mdDirty()) { pollModels(VA); }   // never clobber an unsaved edit
      } }
    });

    function mdDirty() {
      return !!(mdDraft && Object.keys(mdDraft).length);
    }

    function pollModels(VA, force) {
      if (mdState === 'unsupported' && !force) { return; }
      VA.api('/api/models', {timeout_ms: 12000}).then(function (d) {
        if (!d || d.agent_down) { return; }
        // Roles are the one thing the tab cannot be drawn without.
        if (d.ok === false || !d.roles || !d.roles.length) {
          mdState = 'unsupported';
          mdErr = (d && d.error) || null;
          drawModels(VA);
          return;
        }
        mdState = 'ok';
        mdData = d;
        drawModels(VA);
      }).catch(function (e) {
        if (/HTTP 404/.test(String(e))) { mdState = 'unsupported'; drawModels(VA); }
      });
    }

    function mdBackendRow(id) {
      return ((mdData && mdData.providers) || []).filter(function (p) {
        return p.backend === id;
      })[0] || null;
    }

    /* Backend, který si vybírá i POSKYTOVATELE, ne jen model.  Poznáváme ho
       podle toho, že nese `provider_choices` — ne podle jména „hermes",
       aby druhý takový backend fungoval bez zásahu do UI. */
    function mdTwoStep(p) {
      return !!(p && p.provider_choices && p.provider_choices.length);
    }

    /* U36 was closed by adding three names to MD_ROLE_EN.  That is a patch,
       not a fix: the MECHANISM was `MD_ROLE_EN[r.role] || r.label`, and the
       fallback silently prints the core's Czech sentence in an English
       column as if the frame had written it.  The ninth role brings the bug
       straight back — verified by feeding one in.

       The rule, the same one `blockTabActive()` established for tab names:
       NOBODY OUTSIDE THIS FUNCTION NAMES A ROLE, and the frame never passes
       off the core's words as its own.  A role the frame has no English name
       for is SAID to be one.  The core's own label is still shown — beside
       the name, quoted and attributed (mdRoleLabel), never in its place.
       `label_en` is honoured the day the core starts sending it, and then
       this stops being a list at all. */
    function mdRoleName(r) {
      if (MD_ROLE_EN[r.role]) { return MD_ROLE_EN[r.role]; }
      if (r.label_en) { return String(r.label_en); }
      return String(r.role) + ' — no English name yet';
    }

    /* The core's own label for a role, when the frame is showing a name of
       its own next to it.  Returns '' when there is nothing to quote. */
    function mdRoleLabel(r) {
      var lab = r.label ? String(r.label) : '';
      if (!lab || lab === mdRoleName(r)) { return ''; }
      return lab;
    }
    function mdRoleKnown(r) {
      return !!(MD_ROLE_EN[r.role] || r.label_en);
    }

    /* Co by platilo, kdybych teď uložil.  Jedno místo pro celý tab. */
    function mdPlan() {
      var plan = {roles: {}, providers: {}};
      ((mdData && mdData.providers) || []).forEach(function (p) {
        if (!mdTwoStep(p)) { return; }
        var key = '__prov_' + p.backend;
        plan.providers[p.backend] =
          (mdDraft && mdDraft[key] != null) ? mdDraft[key] : (p.provider || null);
      });
      ((mdData && mdData.roles) || []).forEach(function (r) {
        var d = mdDraft && mdDraft[r.role];
        plan.roles[r.role] = d
          ? {backend: d.backend, model: d.model}
          : {backend: r.backend, model: r.model == null ? '' : r.model};
      });
      return plan;
    }

    /* DODAVATEL VŽDY OD SERVERU, NIKDY Z NÁZVU.  U dvoustupňového backendu
       cestuje dodavatel s poskytovatelem, takže se to přepočítá i tehdy, když
       majitel Hermese přesune jinam. */
    function mdVendorOf(backendId, plan) {
      var p = mdBackendRow(backendId);
      if (!p) { return null; }
      if (mdTwoStep(p)) {
        var want = plan.providers[p.backend];
        if (want == null) { want = p.provider; }
        var c = p.provider_choices.filter(function (x) {
          return x.provider === want;
        })[0];
        if (c && c.vendor) { return c.vendor; }
        if (c) { return null; }        // known choice, vendor withheld: say nothing
      }
      return p.vendor || null;
    }

    /* Zábrany, přepočítané z plánu.  `hard` = server to odmítne vždy, takže
       Save zamykáme; `soft` = server odmítne jen NOVOU kolizi, poslední slovo
       má on. */
    function mdViolations(plan) {
      var out = [];
      var roles = (mdData && mdData.roles) || [];
      var coder = plan.roles.coder;
      var coderVendor = coder ? mdVendorOf(coder.backend, plan)
                              : ((mdData && mdData.coder_vendor) || null);
      if (coder && mdTwoStep(mdBackendRow(coder.backend))) {
        out.push({hard: true, text:
          'The code work cannot run on ' + (MD_BACKEND_EN[coder.backend] ||
          coder.backend) + ' — that one is the robot’s voice and ' +
          'hands, not a builder. The core refuses it.'});
      }
      var op = plan.roles.operator;
      var opVendor = op ? mdVendorOf(op.backend, plan) : null;
      var shareOp = [];
      roles.forEach(function (r) {
        if (!r.must_differ_from_coder) { return; }
        var jv = mdVendorOf(plan.roles[r.role].backend, plan);
        if (jv && coderVendor && jv === coderVendor) {
          out.push({hard: true, text:
            mdRoleName(r) + ' and the code work would both come from ' + jv +
            ' — then the agent marks its own homework. Move one of them ' +
            'to a different vendor.'});
        } else if (jv && opVendor && jv === opVendor) {
          shareOp.push(mdRoleName(r));
        }
      });
      // Jedna věta na dodavatele, ne jedna na roli: tři skoro stejné
      // odstavce pod sebou se přestanou číst, a přesně tohle je věta, kterou
      // majitel číst má — v noci 31. 8. mu kvůli tomuhle oněměl chat.
      if (shareOp.length) {
        out.push({hard: false, text:
          shareOp.join(', ') + ' and the chat/robot work all run on ' +
          opVendor + ' — one outage takes out ' +
          (shareOp.length > 1 ? 'all of them' : 'both') + ' at once, and the ' +
          'judge is grading its own vendor’s work. The core refuses this only ' +
          'if you make it worse, so Save still tries.'});
      }
      return out;
    }

    function mdSelect(options, value, onChange, disabled) {
      var sel = el('select', 'md-sel');
      (options || []).forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.label || o.id;
        if (o.locked) { opt.disabled = true; }
        if (o.title) { opt.title = o.title; }
        if (o.id === value) { opt.selected = true; }
        sel.appendChild(opt);
      });
      if (disabled) { sel.disabled = true; }
      sel.addEventListener('change', function () { onChange(sel.value); });
      return sel;
    }

    function mdField(label, control, hint, hintTitle, cls) {
      var w = el('label', 'md-f' + (cls ? ' ' + cls : ''));
      w.appendChild(el('span', 'md-fl', label));
      w.appendChild(control);
      if (hint) {
        var h = el('span', 'md-fh', hint);
        if (hintTitle) { h.title = hintTitle; }
        w.appendChild(h);
      }
      return w;
    }

    function mdMoney(usd) {
      var n = Number(usd || 0);
      if (!n) { return '$0'; }
      return '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
    }

    function mdTokens(n) {
      n = Number(n || 0);
      if (n >= 1e6) { return (n / 1e6).toFixed(1) + ' M'; }
      if (n >= 1e3) { return Math.round(n / 1e3) + ' k'; }
      return String(n);
    }

    /* Cena a provoz role.  NIKDY nebrzdí uložení: když čísla chybí nebo jsou
       jen odhadnutá, řekne se to a jede se dál. */
    function mdStat(r, days) {
      var box = el('div', 'md-stats');
      /* U35: `operator` split into `chat` + `robot` tonight, and the spend
         from before the split stayed on the old name — so the core reports
         the SAME $9.40 / 502 calls on `chat` and on `operator`.  Both are
         right; adding them up is not.  The panel showed both as peer rows
         and the owner read double what the night had cost him.  A role the
         core marks `legacy: true` (with `replaced_by`) therefore states
         WHERE its money is counted instead of counting it again — one
         number, one place. */
      if (r.legacy) {
        var whom = (r.replaced_by || []).map(function (x) {
          return MD_ROLE_EN[x] || x;
        });
        var lg = el('span', 'md-s',
          whom.length
            ? 'spend before the split is counted under “' + whom[0] + '” — ' +
              'not added again here'
            : 'replaced — its spend is counted under the role that took over');
        lg.title = r.note || '';
        box.appendChild(lg);
        return box;
      }
      var calls = Number(r.calls_7d || 0);
      if (!calls && !Number(r.usd_7d || 0)) {
        var none = el('span', 'md-s', 'no runs in the last ' + days + ' d');
        none.title = 'Nothing recorded — not a reason to leave it as it is.';
        box.appendChild(none);
        return box;
      }
      var est = Number(r.usd_estimated_7d || 0);
      var whole = est > 0 && est >= Number(r.usd_7d || 0) - 1e-9;
      var money = el('span', 'md-s money' + (whole ? ' est' : ''),
                     mdMoney(r.usd_7d) + ' / ' + days + ' d' +
                     (whole ? ' (estimate)' : ''));
      money.title = whole
        ? 'The provider did not report usage, so the core priced it from the ' +
          'length of the prompt. An estimate does not stop you from saving.'
        : (est > 0 ? mdMoney(est) + ' of that is the core’s own estimate.'
                   : 'Billed from what the provider reported.');
      /* Both numbers say where they come from, so VAgent.auditNumbers() can
         re-ask the core and prove them.  U35 was two cards quoting one
         ledger row; a number that carries its own pointer cannot be added to
         itself unnoticed again. */
      money.setAttribute('data-src', '/api/models#roles[role=' + r.role + '].usd_7d');
      money.setAttribute('data-num', String(Number(r.usd_7d || 0)));
      box.appendChild(money);
      var c = el('span', 'md-s', calls + ' call' + (calls === 1 ? '' : 's'));
      c.title = 'How many times this kind of work asked a model.';
      c.setAttribute('data-src', '/api/models#roles[role=' + r.role + '].calls_7d');
      c.setAttribute('data-num', String(calls));
      box.appendChild(c);
      var t = el('span', 'md-s', mdTokens(r.tokens_in_7d) + ' in · ' +
                                mdTokens(r.tokens_out_7d) + ' out');
      t.title = 'Tokens read and written in the last ' + days + ' days.';
      box.appendChild(t);
      return box;
    }

    function mdApplyProvider(VA, p, value) {
      mdDraft = mdDraft || {};
      var key = '__prov_' + p.backend;
      if (value === (p.provider || '')) { delete mdDraft[key]; }
      else { mdDraft[key] = value; }
      // Model patřil STARÉMU poskytovateli — nechat ho tam by znamenalo
      // uložit jméno, které nový poskytovatel nezná.
      ((mdData && mdData.roles) || []).forEach(function (r) {
        if (r.backend !== p.backend) { return; }
        var cur = (mdDraft[r.role] || {backend: r.backend});
        mdDraft[r.role] = {backend: cur.backend || r.backend, model: ''};
        if (mdDraft[r.role].backend === r.backend && r.model == null &&
            !mdDraft[key]) {
          delete mdDraft[r.role];
        }
      });
      drawModels(VA);
    }

    function drawModels(VA) {
      if (!mdBox) return;
      mdBox.textContent = '';
      if (mdState === 'unsupported') {
        mdBox.appendChild(el('div', 'md-note',
          'This robot’s agent does not serve the model settings yet ' +
          '(GET /api/models). Nothing here can be changed from the panel ' +
          'until it does — the wiring still lives in the core’s ' +
          'config files.'));
        if (mdErr) { mdBox.appendChild(el('div', 'md-err', String(mdErr))); }
        return;
      }
      if (!mdData) {
        mdBox.appendChild(el('div', 'md-note', 'Reading the model wiring…'));
        return;
      }
      var days = mdData.days || 7;
      var plan = mdPlan();

      // ---- co na čem běží
      mdBox.appendChild(el('div', 'md-h', 'What runs on what'));
      // U35: a replaced role goes last — it is still live while it is set,
      // so it cannot be hidden, but it must not sit among the roles the
      // owner is meant to be choosing between.
      var mdRoles = (mdData.roles || []).slice().sort(function (a, b) {
        return (a.legacy ? 1 : 0) - (b.legacy ? 1 : 0);
      });
      mdRoles.forEach(function (r) {
        var cur = plan.roles[r.role];
        var p = mdBackendRow(cur.backend);
        var row = el('div', 'md-row');
        var head = el('div', 'md-rh');
        var nm = el('span', 'md-name', mdRoleName(r));
        var coreLab = mdRoleLabel(r);
        if (coreLab) { nm.title = 'The core calls this role: ' + coreLab; }
        head.appendChild(nm);
        if (!mdRoleKnown(r)) {
          /* U43: an unknown role used to borrow the core's Czech sentence and
             wear it as an English name.  Now the frame admits it has no name
             for it, and the core's words are shown AS the core's words. */
          var unk = el('span', 'md-lock', 'unknown role');
          unk.title = 'This panel has no English name for `' + r.role + '`. ' +
            'The core’s own label is printed next to it, word for word, ' +
            'instead of being passed off as this panel’s.';
          head.appendChild(unk);
          if (coreLab) {
            var q = el('span', 'md-ven', '„' + coreLab + '” (core)');
            q.title = 'The core’s own label for this role, quoted.';
            head.appendChild(q);
          }
        }
        var ven = mdVendorOf(cur.backend, plan);
        var vch = el('span', 'md-ven', ven || 'vendor unknown');
        vch.title = ven
          ? 'The vendor the core reports for this choice. The judge rule is ' +
            'checked against this, never against the provider’s name.'
          : 'The core did not name a vendor for this choice, so the judge ' +
            'rule cannot be checked here — the server still checks it.';
        head.appendChild(vch);
        if (r.no_fallback) {
          var nf = el('span', 'md-lock', 'no stand-in');
          nf.title = 'Work that touches the robot never switches to another ' +
                     'model — a different model has a different opinion ' +
                     'about a machine that moves.';
          head.appendChild(nf);
        }
        if (r.must_differ_from_coder) {
          var jd = el('span', 'md-badge', 'judge');
          jd.title = 'Must not share a vendor with the code work.';
          head.appendChild(jd);
        }
        if (r.legacy) {
          var lgb = el('span', 'md-lock', 'replaced');
          lgb.title = r.note ||
            'Superseded by newer roles; still applies while it is set.';
          head.appendChild(lgb);
        }
        row.appendChild(head);
        var note = MD_NOTE_EN[r.role] || '';
        if (note) {
          var nd = el('div', 'md-desc', note);
          if (r.note) { nd.title = r.note; }
          row.appendChild(nd);
        }

        var picks = el('div', 'md-picks');

        // 1) backend
        var backOpts = (mdData.providers || []).map(function (b) {
          return {id: b.backend, label: MD_BACKEND_EN[b.backend] || b.backend};
        });
        var backSel = mdSelect(backOpts, cur.backend, function (v) {
          mdDraft = mdDraft || {};
          if (v === r.backend && (r.model == null || r.model === '')) {
            delete mdDraft[r.role];
          } else {
            mdDraft[r.role] = {backend: v, model: ''};
          }
          drawModels(VA);
        });
        /* U dvoustupňového backendu dostane „Runs on" vlastní řádek, aby
           poskytovatel a model zůstali VEDLE SEBE — to je ta dvojice, kterou
           majitel mění spolu. */
        picks.appendChild(mdField('Runs on', backSel, null, null,
                                  mdTwoStep(p) ? 'wide' : null));

        // 2) poskytovatel — jen u dvoustupňového backendu (Hermes)
        var provMoved = false;
        if (mdTwoStep(p)) {
          var want = plan.providers[p.backend];
          var choices = p.provider_choices.slice().sort(function (a, b) {
            if (!!a.ready !== !!b.ready) { return a.ready ? -1 : 1; }
            return String(a.provider).localeCompare(String(b.provider));
          });
          var ready = choices.filter(function (c) { return c.ready; }).length;
          var provOpts = choices.map(function (c) {
            return {id: c.provider,
                    label: (c.display || c.provider) +
                           (c.ready ? '' : ' — locked, no key'),
                    locked: !c.ready && c.provider !== want,
                    title: c.ready ? (c.description || '')
                                   : (c.locked_why || 'no key on this machine')};
          });
          var provSel = mdSelect(provOpts, want, function (v) {
            mdApplyProvider(VA, p, v);
          });
          picks.appendChild(mdField('Provider', provSel,
            ready + ' of ' + choices.length + ' ready',
            'The rest are listed but locked — they have no key on this ' +
            'machine. Nothing is hidden from you.'));
          provMoved = (want || '') !== (p.provider || '');
        }

        // 3) model
        var modelOpts = [];
        // Po přesunu poskytovatele NESMÍ u „Default" stát model toho starého —
        // je to jméno, které nový poskytovatel nezná.
        var deflt = provMoved ? null : (p ? (p.selected || p.accounting_fallback) : null);
        modelOpts.push({id: '',
                        label: deflt ? 'Default (' + deflt + ')'
                             : provMoved ? 'Default of the new provider'
                                         : 'Default of this backend',
                        title: 'Leave the choice to the backend itself.'});
        if (!provMoved) {
          ((p && p.models) || []).forEach(function (m) {
            modelOpts.push({id: m.id, label: m.label || m.id});
          });
        }
        var modSel = mdSelect(modelOpts, provMoved ? '' : (cur.model || ''),
          function (v) {
            mdDraft = mdDraft || {};
            var base = mdDraft[r.role] || {backend: cur.backend};
            mdDraft[r.role] = {backend: base.backend || cur.backend, model: v};
            if (mdDraft[r.role].backend === r.backend &&
                (v || '') === (r.model == null ? '' : r.model)) {
              delete mdDraft[r.role];
            }
            drawModels(VA);
          });
        var srcTxt, srcTitle;
        if (provMoved) {
          srcTxt = 'save the provider first';
          srcTitle = 'The list below still belongs to the provider that is ' +
            'running now. Save this change and the models of the new one ' +
            'arrive with the next read — the panel will not guess them.';
        } else {
          srcTxt = MD_SOURCE_EN[(p && p.models_source) || 'unknown'] ||
                   String((p && p.models_source) || '');
          srcTitle = 'Where this list comes from. A list on paper and a list ' +
                     'from the provider are not the same thing.';
        }
        picks.appendChild(mdField('Model', modSel, srcTxt, srcTitle));
        row.appendChild(picks);
        row.appendChild(mdStat(r, days));
        mdBox.appendChild(row);
      });

      // ---- zamčení poskytovatelé, vypsaní jménem
      (mdData.providers || []).forEach(function (p) {
        if (!mdTwoStep(p)) { return; }
        var locked = p.provider_choices.filter(function (c) { return !c.ready; });
        if (!locked.length) { return; }
        var head = el('div', 'md-more');
        var btn = el('button', 'md-mini wide',
          (mdShowLocked ? '▾ hide ' : '▸ show ') + locked.length +
          ' locked provider' + (locked.length === 1 ? '' : 's'));
        btn.type = 'button';
        btn.title = 'They exist and they are not hidden from you — each ' +
                    'one says what it would take to switch to it.';
        btn.addEventListener('click', function () {
          mdShowLocked = !mdShowLocked; drawModels(VA);
        });
        head.appendChild(btn);
        mdBox.appendChild(head);
        if (!mdShowLocked) { return; }
        locked.forEach(function (c) {
          var row = el('div', 'md-locked');
          row.appendChild(el('span', 'md-name', c.display || c.provider));
          var need = (c.env_vars || []).join(' or ');
          var why = el('span', 'md-s',
            need ? 'needs ' + need + ' in the agent’s secrets file'
                 : 'needs a sign-in of its own');
          why.title = c.locked_why || '';
          row.appendChild(why);
          if (c.signup_url) {
            var a = el('a', 'md-s link', 'where to get one');
            a.href = c.signup_url; a.target = '_blank'; a.rel = 'noopener';
            row.appendChild(a);
          }
          mdBox.appendChild(row);
        });
      });

      // ---- pořadí náhradníků
      if (mdData.fallback_order) {
        var oh = el('div', 'md-h', 'Stand-in order');
        oh.title = 'Who gets asked when the first choice says it cannot. ' +
                   'Work that touches the robot never uses this list.';
        mdBox.appendChild(oh);
        var order = (mdDraft && mdDraft.__order) || mdData.fallback_order.slice();
        order.forEach(function (id, i) {
          var row = el('div', 'md-ord');
          row.appendChild(el('span', 'md-num', (i + 1) + '.'));
          row.appendChild(el('span', 'md-name', MD_BACKEND_EN[id] || id));
          var up = el('button', 'md-mini', '↑');
          up.type = 'button'; up.title = 'Move up';
          up.disabled = i === 0;
          up.addEventListener('click', function () {
            var o = order.slice();
            o[i - 1] = order[i]; o[i] = order[i - 1];
            mdDraft = mdDraft || {}; mdDraft.__order = o; drawModels(VA);
          });
          var dn = el('button', 'md-mini', '↓');
          dn.type = 'button'; dn.title = 'Move down';
          dn.disabled = i === order.length - 1;
          dn.addEventListener('click', function () {
            var o = order.slice();
            o[i + 1] = order[i]; o[i] = order[i + 1];
            mdDraft = mdDraft || {}; mdDraft.__order = o; drawModels(VA);
          });
          row.appendChild(up); row.appendChild(dn);
          mdBox.appendChild(row);
        });
      }

      // ---- stav zdrojů
      mdBox.appendChild(el('div', 'md-h', 'Providers right now'));
      ((mdData.backends && mdData.backends.length)
          ? mdData.backends
          : (mdData.providers || []).map(function (p) {
              return {backend: p.backend, vendor: p.vendor, status: 'unknown'};
            })
      ).forEach(function (b) {
        var row = el('div', 'md-prov');
        row.appendChild(el('span', 'md-name',
                           MD_BACKEND_EN[b.backend] || b.backend));
        var v = el('span', 'md-ven', b.vendor || '?');
        v.title = 'Who is behind it.';
        row.appendChild(v);
        var st = String(b.status || 'unknown');
        var cls = st === 'ok' ? 'good'
          : (st === 'limited' || st === 'rate_limited') ? 'warn'
          : (st === 'quota_exhausted' || st === 'exhausted') ? 'bad'
          : st === 'no_key' ? 'off' : '';
        var pill = el('span', 'md-pill ' + cls, MD_STATUS_EN[st] || st);
        if (b.why) { pill.title = String(b.why).slice(0, 400); }
        row.appendChild(pill);
        if (b.until) {
          var u = new Date(b.until * 1000);
          var us = el('span', 'md-s', 'until ~' +
            ('0' + u.getHours()).slice(-2) + ':' +
            ('0' + u.getMinutes()).slice(-2) +
            (b.estimated ? ' (estimate)' : ''));
          us.title = b.estimated
            ? 'The provider does not say when; this is the core’s estimate.'
            : 'Reported by the provider.';
          row.appendChild(us);
        }
        if (b.model) { row.appendChild(el('span', 'md-s', b.model)); }
        mdBox.appendChild(row);
      });

      // ---- pravidla, lidsky
      /* U35, and the half that matters more than the number: the core sends
         its rules HERE TO BE SHOWN TO THE OWNER, and the panel was pushing
         them into a `title=` tooltip and printing three sentences of its own
         instead.  So when the core added a fourth rule tonight — „chat and
         driving the robot are TWO independent settings" — the owner could
         not see it, and a panel that silently drops a sentence the server
         asked it to show is worse than a panel with no rules at all,
         because it looks like there are none.  Every rule the core sends is
         printed, in the core's own words (they are written for a person,
         and a paraphrased warning is a warning on its way to being lost).
         The panel's own three sentences stay only as a fallback for a core
         that sends none. */
      var rules = el('div', 'md-rules');
      var coreRules = (mdData.rules || []).map(function (x) {
        return typeof x === 'string' ? x : (x && (x.text || x.rule)) || '';
      }).filter(function (t) { return !!t; });
      if (coreRules.length) {
        // U36: the frame stays English and says whose words follow, so the
        // core's Czech sentences read as a quotation, not as a tab that
        // could not make up its mind which language it is in.
        var rh = el('div', 'md-rulehead', 'Rules the core enforces, in its own words');
        rules.appendChild(rh);
        coreRules.forEach(function (t) {
          rules.appendChild(el('div', 'md-rule', t));
        });
      } else {
        [ 'The judge may not come from the same vendor as the code work — ' +
          'otherwise the agent marks its own homework.',
          'Work that touches the robot gets no stand-in model, from here or ' +
          'from a config file.',
          'A model is picked from a list; free text is refused.'
        ].forEach(function (t) { rules.appendChild(el('div', 'md-rule', t)); });
      }
      mdBox.appendChild(rules);

      // ---- uložení
      var dirty = mdDirty();
      var bad = mdViolations(plan);
      var hard = bad.filter(function (b) { return b.hard; });
      mdProblems.forEach(function (t) {
        // Hotové věty od jádra. Vypisují se doslova a nepřekládají se.
        mdBox.appendChild(el('div', 'md-err', t));
      });
      if (mdErr) { mdBox.appendChild(el('div', 'md-err', mdErr)); }
      bad.forEach(function (b) {
        mdBox.appendChild(el('div', b.hard ? 'md-err' : 'md-warn', b.text));
      });
      var when = el('div', 'md-note small',
        mdData.applies === 'runtime'
          ? 'A change here takes effect straight away — no restart.'
          : 'A change here takes effect after the agent restarts.');
      if (mdData.overlay) {
        when.title = 'Written to ' + mdData.overlay + ', which sits on top of ' +
          'the hand-written config — that file keeps its comments.';
      }
      mdBox.appendChild(when);
      if (mdSaved) {
        mdBox.appendChild(el('div', 'md-ok', mdSaved === 'revert'
          ? 'Back to the last working wiring. This is what is running now.'
          : 'Saved. This is what is running now.'));
      }

      var acts = el('div', 'md-acts');
      var save = el('button', 'md-btn primary', mdSaving ? 'Saving…' : 'Save');
      save.type = 'button';
      save.disabled = !dirty || hard.length > 0 || mdSaving;
      if (hard.length) { save.title = 'A rule the core enforces is broken above.'; }
      save.addEventListener('click', function () { mdSave(VA, plan); });
      acts.appendChild(save);

      var cancel = el('button', 'md-btn', 'Discard changes');
      cancel.type = 'button';
      cancel.disabled = !dirty || mdSaving;
      cancel.addEventListener('click', function () {
        mdDraft = null; mdErr = null; mdProblems = []; mdSaved = 0;
        drawModels(VA);
      });
      acts.appendChild(cancel);

      var back = el('button', 'md-btn', 'Back to last working');
      back.type = 'button';
      back.disabled = mdSaving;
      back.title = 'Undo the last save in one step — the core keeps the ' +
                   'previous wiring beside the current one.';
      back.addEventListener('click', function () {
        if (back.dataset.armed !== '1') {
          back.dataset.armed = '1';
          back.textContent = 'Yes — go back';
          setTimeout(function () {
            if (back.dataset) { back.dataset.armed = '0'; }
            if (back.textContent === 'Yes — go back') {
              back.textContent = 'Back to last working';
            }
          }, 6000);
          return;
        }
        mdSaving = true; mdProblems = []; mdErr = null; drawModels(VA);
        VA.api('/api/models/revert', {body: {}, timeout_ms: 20000,
                                      keep_error_body: true})
          .then(function (d) {
            mdSaving = false; mdDraft = null; mdSaved = 'revert';
            if (d && d.roles) { mdData = d; }
            drawModels(VA);
            pollModels(VA, true);
          }).catch(function (e) { mdFail(VA, e, 'Not reverted'); });
      });
      acts.appendChild(back);
      mdBox.appendChild(acts);
    }

    function mdFail(VA, e, lead) {
      mdSaving = false;
      var body = e && e.body;
      if (body && body.problems && body.problems.length) {
        mdProblems = body.problems.map(String);
        mdErr = null;
      } else {
        mdProblems = [];
        mdErr = /HTTP 404/.test(String(e))
          ? lead + ': this agent does not serve model settings yet.'
          : lead + ': ' + e;
      }
      drawModels(VA);
    }

    function mdSave(VA, plan) {
      /* Posílají se JEN klíče, které jádro zná (`roles`, `backends`,
         `fallback_order`) a JEN to, co se změnilo — cokoli navíc jádro
         odmítne jako neznámý klíč, a to je správně: „uložilo se a nezměnilo
         se nic" je horší výsledek než odmítnutí. */
      var body = {};
      var roles = {};
      ((mdData && mdData.roles) || []).forEach(function (r) {
        var want = plan.roles[r.role];
        var was = {backend: r.backend, model: r.model == null ? '' : r.model};
        if (want.backend === was.backend && (want.model || '') === was.model) {
          return;
        }
        roles[r.role] = {backend: want.backend,
                         model: want.model ? want.model : null};
      });
      if (Object.keys(roles).length) { body.roles = roles; }
      ((mdData && mdData.providers) || []).forEach(function (p) {
        if (!mdTwoStep(p)) { return; }
        var want = plan.providers[p.backend];
        if ((want || '') !== (p.provider || '')) {
          body.backends = body.backends || {};
          body.backends[p.backend] = {provider: want};
        }
      });
      if (mdDraft && mdDraft.__order) { body.fallback_order = mdDraft.__order; }
      if (!Object.keys(body).length) { return; }
      mdSaving = true; mdProblems = []; mdErr = null; mdSaved = 0;
      drawModels(VA);
      VA.api('/api/models', {body: body, timeout_ms: 25000,
                             keep_error_body: true}).then(function (d) {
        mdSaving = false;
        if (!d || d.ok === false) {
          mdProblems = (d && d.problems) ? d.problems.map(String)
                                         : ['jádro to odmítlo a neřeklo proč'];
          drawModels(VA);
          return;
        }
        mdDraft = null; mdSaved = 'save';
        if (d.roles) { mdData = d; }        // POST answers with the new view
        drawModels(VA);
      }).catch(function (e) { mdFail(VA, e, 'Not saved'); });
    }

    // ---- blok: Robot ------------------------------------------------------
    var robotBox, robotImg, robotImgStamp = 0, robotImgNote, mapRefreshBtn;
    var robotSeen = {};     // U46: fields this panel has EVER been told
    VA.registerBlock({
      id: 'robot', title: 'Robot', order: 30,
      render: function (root) {
        robotBox = el('div');
        root.appendChild(robotBox);
        var wrap = el('div');
        wrap.style.cssText = 'margin-top:.4em;position:relative';
        robotImg = el('img');
        robotImg.alt = 'map preview';
        robotImg.style.cssText = 'width:100%;border-radius:.4em;display:none;' +
          'cursor:zoom-in;border:1px solid var(--bs-gray-700,#444)';
        robotImg.addEventListener('click', function () {
          if (robotImg.src) window.open(robotImg.src, '_blank');
        });
        robotImgNote = el('div', null, '');
        robotImgNote.style.cssText = 'font-size:.75em;color:var(--bs-gray-500,#888)';

        /* Vykreslení mapy stojí robota skoro pět sekund procesoru, takže si
           o ně říká člověk, ne stopky. */
        mapRefreshBtn = el('button', null, 'Refresh map');
        mapRefreshBtn.type = 'button';
        mapRefreshBtn.className = 'btn btn-sm btn-outline-secondary';
        mapRefreshBtn.style.cssText = 'margin-top:.35em;font-size:.75em;min-height:2em';
        mapRefreshBtn.title = 'Redraw the map on the robot (takes a few seconds)';
        mapRefreshBtn.addEventListener('click', function () { pollMapview(VA, true); });

        wrap.appendChild(robotImg); wrap.appendChild(robotImgNote);
        wrap.appendChild(mapRefreshBtn);

        /* „Součet a stáří jsou dvě místa, kde panel přestává citovat a
           začíná tvrdit — a obě dnes v noci lhaly." (tester, round 3)
           Every number in this panel now carries `data-src`, so the panel
           can be asked to check itself against the core: it re-asks each
           endpoint it is quoting and reports every number that no longer
           matches.  Same thing as `VAgent.auditNumbers()` in the console —
           this button is here so the OWNER can run it too. */
        var auditBtn = el('button', null, 'Check numbers');
        auditBtn.type = 'button';
        auditBtn.className = 'btn btn-sm btn-outline-secondary';
        auditBtn.style.cssText = 'margin:.35em 0 0 .35em;font-size:.75em;min-height:2em';
        auditBtn.title = 'Re-ask the core for every number this panel is ' +
          'showing and say which no longer match. Reads only.';
        var auditOut = el('div', null, '');
        auditOut.style.cssText = 'font-size:.75em;margin-top:.3em;white-space:pre-wrap';
        auditBtn.addEventListener('click', function () {
          auditBtn.disabled = true;
          auditOut.textContent = 'checking…';
          auditOut.className = '';
          VA.auditNumbers().then(function (rep) {
            auditBtn.disabled = false;
            var bad = rep.mismatches.length;
            auditOut.className = bad ? 'vagent-unknown' : '';
            auditOut.textContent = rep.checked + ' numbers checked against the ' +
              'core · ' + bad + ' mismatch' + (bad === 1 ? '' : 'es') +
              (rep.unreadable.length ? ' · ' + rep.unreadable.length + ' could not be read' : '') +
              (rep.derived.length ? ' · ' + rep.derived.length + ' computed here (listed in the console)' : '') +
              (bad ? '\n' + rep.mismatches.map(function (m) {
                return m.src + ': panel ' + m.drawn + ', core ' + m.core;
              }).join('\n') +
              '\nA mismatch is either a wrong number or a stale one — read it ' +
              'with the age shown next to it.' : '');
          }, function (e) {
            auditBtn.disabled = false;
            auditOut.className = 'vagent-unknown';
            auditOut.textContent = 'the audit itself could not run: ' + e;
          });
        });
        wrap.appendChild(auditBtn);
        wrap.appendChild(auditOut);
        root.appendChild(wrap);
        root.appendChild(buildLidarObjects());
        showLastMapview();
        askCachedMapview(VA);
      },
      poll: { every_ms: 5000, fn: function () { drawRobot(VA); drawLidar(); } },
      onOpen: function () {
        drawRobot(VA); showLastMapview(); askCachedMapview(VA);
        startLidarObjects();
      }
    });

    /* ---- Lidar objects -------------------------------------------------
       Robot sám (uzel vitulus_safety/lidar_objects) drží 60s statické pozadí
       a hlásí jen potvrzené shluky velikosti 0,15–1,2 m — kočka, pes, člověk.
       Panel je jen okno do toho, NIC nepočítá: čte /safety/lidar_objects
       (std_msgs/String s JSON) přes rosbridge.

       Vlastní spojení, ne `window.ros`: to je připojení mapy a app.js ho
       zavírá (`suspend()`), kdykoli uživatel není v sekci Map — agentní panel
       je vidět i jinde. Odběr je škrcený na 1 Hz (topic jede 5 Hz), takže
       rosbridge nepřidá měřitelnou zátěž. */
    var loRos = null, loTopic = null, loData = null, loAt = 0, loErr = null;
    var loBox = null, loHead = null, loBody = null;

    function buildLidarObjects() {
      var wrap = el('div');
      wrap.style.cssText = 'margin-top:.6em;border-top:1px solid var(--bs-gray-700,#444);padding-top:.4em';
      loHead = el('div');
      loHead.style.cssText = 'display:flex;align-items:center;gap:.4em;flex-wrap:wrap;font-size:.9em';
      var t = el('span', null, 'Lidar objects');
      t.style.color = 'var(--bs-gray-500, #888)';
      t.title = 'People, dogs and cats seen by the lidar. The robot confirms ' +
        'an object over three consecutive scans and ignores anything that ' +
        'has been standing still long enough to become background.';
      loHead.appendChild(t);
      loBody = el('div');
      loBody.style.cssText = 'font-size:.85em;margin-top:.25em';
      wrap.appendChild(loHead); wrap.appendChild(loBody);
      loBox = wrap;
      drawLidar();
      return wrap;
    }

    function startLidarObjects() {
      if (loRos || typeof ROSLIB === 'undefined') { return; }
      try {
        loRos = new ROSLIB.Ros({
          url: 'ws://' + location.hostname + ':9090', groovyCompatibility: false
        });
        loRos.on('error', function () { loErr = 'rosbridge unreachable'; drawLidar(); });
        loRos.on('close', function () { loErr = 'rosbridge disconnected'; drawLidar(); });
        loRos.on('connection', function () { loErr = null; drawLidar(); });
        loTopic = new ROSLIB.Topic({
          ros: loRos, name: '/safety/lidar_objects',
          messageType: 'std_msgs/String',
          throttle_rate: 1000, queue_length: 1, queue_size: 1
        });
        loTopic.subscribe(function (msg) {
          try { loData = JSON.parse(msg.data); loAt = Date.now(); loErr = null; }
          catch (e) { loErr = 'bad payload'; }
          drawLidar();
        });
      } catch (e) { loErr = String(e); drawLidar(); }
    }

    function loDir(deg) {
      // směr slovem — na telefonu je „front-left" čitelnější než „-137°"
      var d = Number(deg) || 0;
      if (d > 180) d -= 360; if (d < -180) d += 360;
      var a = Math.abs(d), side = d >= 0 ? 'left' : 'right';
      if (a <= 22.5) return 'front';
      if (a >= 157.5) return 'rear';
      if (a < 67.5) return 'front-' + side;
      if (a <= 112.5) return side;
      return 'rear-' + side;
    }

    function drawLidar() {
      if (!loBox || !loBody) { return; }
      while (loHead.childNodes.length > 1) { loHead.removeChild(loHead.lastChild); }
      loBody.textContent = '';

      var stale = !loAt || (Date.now() - loAt) > 8000;
      if (loErr || !loData || stale) {
        loHead.appendChild(pill('no data', 'var(--bs-gray-600,#666)'));
        var m = el('div', null, loErr ? loErr
          : (loData ? 'the detector stopped publishing'
                    : 'lidar_objects is not running on the robot'));
        m.style.cssText = 'color:var(--bs-gray-500,#888)';
        m.title = 'Start it with: roslaunch vitulus_safety safety.launch lidar_objects:=true';
        loBody.appendChild(m);
        return;
      }
      if (loData.moving) {
        loHead.appendChild(pill('robot moving', 'var(--bs-gray-600,#666)'));
        var mv = el('div', null, 'not watching while the robot drives');
        mv.style.color = 'var(--bs-gray-500,#888)';
        loBody.appendChild(mv);
        return;
      }
      if (!loData.background_ready) {
        loHead.appendChild(pill('learning', 'var(--bs-gray-600,#666)'));
        var lr = el('div', null, 'building the static background…');
        lr.style.color = 'var(--bs-gray-500,#888)';
        loBody.appendChild(lr);
        return;
      }
      var objs = loData.objects || [];
      if (!objs.length) {
        loHead.appendChild(pill('clear', 'var(--bs-success,#198754)'));
        var c = el('div', null, 'nothing bigger than a cat around');
        c.style.color = 'var(--bs-gray-500,#888)';
        loBody.appendChild(c);
        return;
      }
      loHead.appendChild(pill(objs.length + (objs.length === 1 ? ' object' : ' objects'),
                              'var(--bs-danger,#dc3545)'));
      /* Tabulka, ne mřížka: na telefonu se čtyři sloupce vejdou jen když
         mají pevná procenta a nezalamují se uprostřed čísla. */
      var tbl = el('table');
      tbl.style.cssText = 'width:100%;table-layout:fixed;border-collapse:collapse';
      var head = el('tr');
      ['Class', 'Dist', 'Dir', 'Seen'].forEach(function (h, i) {
        var th = el('th', null, h);
        th.style.cssText = 'text-align:' + (i ? 'right' : 'left') +
          ';color:var(--bs-gray-500,#888);font-weight:400;padding:.1em .2em;' +
          'width:' + [34, 20, 26, 20][i] + '%';
        head.appendChild(th);
      });
      tbl.appendChild(head);
      var CLS = {small: 'cat-sized', medium: 'dog-sized', large: 'person-sized',
                 unknown: 'unknown'};
      objs.forEach(function (o) {
        var tr = el('tr');
        var cells = [
          CLS[o.cls] || o.cls,
          (Number(o.range_m) || 0).toFixed(1) + ' m',
          loDir(o.bearing_deg),
          (Number(o.age_s) || 0).toFixed(0) + ' s'
        ];
        cells.forEach(function (v, i) {
          var td = el('td', null, v);
          td.style.cssText = 'text-align:' + (i ? 'right' : 'left') +
            ';padding:.1em .2em;overflow:hidden;text-overflow:ellipsis';
          tr.appendChild(td);
        });
        tr.title = 'id ' + o.id + ' · ' + (Number(o.size) || 0).toFixed(2) +
          ' m wide · ' + (Number(o.speed) || 0).toFixed(1) + ' m/s · ' +
          (Number(o.bearing_deg) || 0).toFixed(0) + '°';
        tbl.appendChild(tr);
      });
      loBody.appendChild(tbl);
      var note = el('div', null,
        'class is a rough guess from size and speed — the lidar does not ' +
        'recognise identity');
      note.style.cssText = 'color:var(--bs-gray-500,#888);font-size:.9em;margin-top:.2em';
      loBody.appendChild(note);
    }

    function drawRobot(VA) {
      tickAges();          // ages are re-read on every draw, not remembered
      var st = (VA.state && (VA.state.robot || VA.state.state)) || null;
      if (!robotBox) return;
      if (!st) {
        // Before the first /api/state answer there is nothing to show yet —
        // saying "unavailable" there was the whole U1 complaint.
        errLine(robotBox, (VA.state && VA.state.ts)
          ? 'robot state unavailable' : 'robot state — loading…');
        return;
      }
      robotBox.textContent = '';
      var age = VA.state.age_s != null ? VA.state.age_s : null;
      robotBox.appendChild(row('Battery',
        VA.num(st.battery_pct, '/api/state#state.battery_pct', {unit: ' %'})));
      robotBox.appendChild(row('In dock', st.in_dock === true ? 'yes' : st.in_dock === false ? 'no' : null));
      var rtk = st.rtk && typeof st.rtk === 'object'
        ? (st.rtk.fix || '?') + (st.rtk.sats != null ? ' (' + st.rtk.sats + ' sat)' : '')
        : st.rtk;
      robotBox.appendChild(row('RTK', rtk || null));
      robotBox.appendChild(row('Motors', st.motor_power === true ? 'on' : st.motor_power === false ? 'off' : null));
      optRow('mower', 'Mower (RPM)', (st.mower && st.mower.moto_rpm != null) ? st.mower.moto_rpm : null);
      optRow('charging', 'Charging', (st.battery_pct != null && st.charger) ? st.charger : null);
      optRow('map', 'Map', st.map || st.active_map || null);
      var rain = st.rain != null ? st.rain : (st.rain_alert ? st.rain_alert.alert : null);
      optRow('rain', 'Rain', rain == null ? null : (rain ? 'reported' : 'no'));

      /* U40, second place: `age_s` is the age AT THE MOMENT THE CORE
         ANSWERED.  Printed straight, it stood still — measured „Measured 2 s
         ago" 45 s after the last answer.  The moment is
         `VA.state.ts - age_s`, and the row ticks with everything else. */
      var at = (age != null && VA.state.ts)
        ? (VA.state.ts / 1000 - Number(age)) : null;
      if (at != null) {
        var mv = ageChip(at, {post: ' ago', title:
          'The core said this reading was ' + Number(age).toFixed(1) + ' s ' +
          'old when it answered; the rest is time that has passed since.'});
        mv.setAttribute('data-src', 'derived: /api/state#age_s + time since the answer arrived');
        robotBox.appendChild(row('Measured', mv));
      }

      /* U46: a row that vanishes is worse than a row that admits it did not
         read.  `/api/state` flaps — `active_map` came back as `SITE` once in
         twelve calls and `null` the other eleven — and the table jumped every
         five seconds because the Map row appeared and disappeared with it.
         A field the panel has EVER seen keeps its row from then on; when this
         answer did not carry it, the row says so.  Same rule the Findings tab
         already holds: „could not be read" is not „none". */
      function optRow(key, label, value) {
        if (value != null && value !== '') { robotSeen[key] = true; }
        if (value == null || value === '') {
          if (!robotSeen[key]) { return; }
          var r = row(label, '—');
          r.lastChild.className = 'vagent-unknown';
          r.title = 'This answer from the core did not carry ' + label.toLowerCase() +
                    '. It was there before, so the row stays — an empty line ' +
                    'is not the same as „no map".';
          robotBox.appendChild(r);
          return;
        }
        robotBox.appendChild(row(label, value));
      }
    }

    /* Pohled do mapy je NÁSTROJ AGENTA, ne widget na stopkách.
       Obrázek vzniká tak, že ho robot pokaždé znovu vykreslí — naměřeno
       `GET /api/mapview 200 4901ms`, tedy skoro pět sekund procesoru na
       jedno vyžádání. Dokud se to volalo každých 15 s, pálil robot třetinu
       jádra na obrázek, který má člověk vedle sebe v three.js mapě lepší
       (posouvatelný, přibližitelný, živý), zatímco agent — pro kterého ten
       pohled vznikl — si o něj nikdy neřekl.
       Nově se kreslí jen na vyžádání: při otevření panelu jednou, pak už
       jen po stisku Refresh. */
    var mapviewBusy = false;
    var LS_MAPVIEW = 'vitulus_agent_mapview_last';   // {url, ts, layers}

    /* U37: `Math.round(s/3600)` turned 159 minutes into „3 h old" — the
       age of a picture is exactly the thing that must not be rounded away
       from what it is.  Below ten hours it keeps a decimal. */
    function mapAge(ts) {
      var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 90) return s + ' s old';
      if (s < 5400) return Math.round(s / 60) + ' min old';
      if (s < 36000) return (s / 3600).toFixed(1) + ' h old';
      return Math.round(s / 3600) + ' h old';
    }

    /* Otevření panelu NIC nekreslí. Nově se ale smí ZEPTAT: jádro dostalo
       `?cached=1`, které vrací poslední hotový render bez překreslení
       (naměřeno 3 ms proti 6,4 s u plného renderu), takže i cizí prohlížeč,
       který nemá nic v localStorage, uvidí poslední obrázek zadarmo.
       Pojistka pro jádro, které ten parametr neumí: dotaz má 2s strop a po
       prvním neúspěchu se na téhle stanici už nikdy neopakuje — jinak by
       „levný dotaz" byl tichý návrat k tomu, co jsme v kole 1 vypnuli. */
    var LS_MAPCACHE = 'vitulus_agent_mapview_cacheable';

    /* U37: the „this core cannot do ?cached=1" flag was a LATCH WITH NO WAY
       BACK — written once, read forever, never cleared.  One answer from an
       older core (or one that happened to answer oddly) and that browser
       never asked for the cheap cached render again: the panel sat on a
       159-minute-old picture while a 107-minute-old one lay finished on the
       robot, and nothing short of clearing localStorage by hand could undo
       it.  A conclusion drawn from one reply is allowed to be wrong, so it
       expires; the plain '0' written by the old code is dropped on sight. */
    var MAPCACHE_RETRY_S = 600;          // ask again after ten minutes

    function mapCacheBlocked() {
      var raw = null;
      try { raw = localStorage.getItem(LS_MAPCACHE); } catch (e) {}
      if (!raw || raw === '1') { return false; }
      if (raw === '0') {                 // the old permanent latch — let it go
        try { localStorage.removeItem(LS_MAPCACHE); } catch (e) {}
        return false;
      }
      var o = null;
      try { o = JSON.parse(raw); } catch (e) {}
      if (!o || !o.no) { return false; }
      return (Date.now() / 1000 - (o.ts || 0)) < MAPCACHE_RETRY_S;
    }

    function askCachedMapview(VA) {
      if (!robotImg) return;
      if (mapCacheBlocked()) return;
      VA.api('/api/mapview?cached=1', {timeout_ms: 2000}).then(function (data) {
        if (!data || data.cached === undefined) {
          // an older core rendered instead of answering from cache.  Time
          // stamped, not permanent: the core gets restarted and learns.
          try {
            localStorage.setItem(LS_MAPCACHE,
              JSON.stringify({no: true, ts: Date.now() / 1000}));
          } catch (e) {}
          return;
        }
        try { localStorage.setItem(LS_MAPCACHE, '1'); } catch (e) {}
        if (!data.ok || !data.url) return;
        try {
          localStorage.setItem(LS_MAPVIEW, JSON.stringify(
            {url: data.url, ts: (data.ts || Date.now() / 1000) * 1000,
             layers: data.layers || []}));
        } catch (e) {}
        showLastMapview();
      }).catch(function () {
        /* A timeout is NOT proof that the core ignores `cached=1` — it may
           just have been busy.  Only an answer without the `cached` key
           proves that, so a failure leaves the flag unknown and we simply
           skip the cheap ask this once. */
      });
    }

    function showLastMapview() {
      if (!robotImg || !robotImgNote) return;
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem(LS_MAPVIEW) || 'null'); } catch (e) {}
      if (!raw || !raw.url) {
        robotImg.style.display = 'none';
        robotImgNote.textContent = 'No map render yet — press Refresh (takes a few seconds on the robot).';
        return;
      }
      robotImg.src = agentBase() + raw.url;
      robotImg.style.display = '';
      robotImgNote.textContent = mapAge(raw.ts || 0) +
        (raw.layers && raw.layers.length ? ' · layers: ' + raw.layers.join(', ') : '');
    }

    function pollMapview(VA, force) {
      if (mapviewBusy || !robotImg || !force) return;
      mapviewBusy = true;
      if (mapRefreshBtn) { mapRefreshBtn.disabled = true; }
      robotImgNote.textContent = 'drawing on the robot…';
      VA.api('/api/mapview', {timeout_ms: 20000}).then(function (data) {
        mapviewBusy = false;
        if (mapRefreshBtn) { mapRefreshBtn.disabled = false; }
        if (!data || !data.ok || !data.url) {
          robotImgNote.textContent = (data && data.error) ? 'map: ' + data.error
            : 'map render failed';
          return;
        }
        try {
          localStorage.setItem(LS_MAPVIEW, JSON.stringify(
            {url: data.url, ts: Date.now(), layers: data.layers || []}));
        } catch (e) {}
        robotImg.src = agentBase(VA) + data.url;
        robotImg.style.display = '';
        robotImgNote.textContent = 'just now' +
          ((data.layers || []).length ? ' · layers: ' + data.layers.join(', ') : '');
      }).catch(function () {
        mapviewBusy = false;
        if (mapRefreshBtn) { mapRefreshBtn.disabled = false; }
        robotImgNote.textContent = 'map render failed';
      });
    }

    // ---- blok: Mise / řízení ---------------------------------------------
    /* Nic neběží → jeden tichý řádek; běží → karta s fázemi jako progres,
       aktuální fáze zvýrazněná, verdikt jako pill, tlačítka. */
    var missionBox, missionBadge = badge(), missionsFp = null;
    VA.registerBlock({
      id: 'mise', title: 'Mission / driving', order: 40, summaryExtra: missionBadge,
      render: function (root) { missionBox = el('div', 'vm'); root.appendChild(missionBox); },
      poll: { every_ms: 5000, fn: function () { pollMissions(VA); } },
      onOpen: function () { pollMissions(VA); }
    });

    var PLAN_CLS = {
      running: 'running', planning: 'running', done: 'done', failed: 'failed',
      cancelled: 'cancelled', gated: 'queued', refused: 'failed', parked: 'queued'
    };

    function verdictPill(v) {
      var p = el('span', 'vagent-pill ' + (
        /ok|continue|done|hotovo/i.test(v) ? 'done' :
        /retry|replan|nudge/i.test(v) ? 'queued' :
        /stop|fail|ask/i.test(v) ? 'failed' : ''), v);
      return p;
    }

    function pollMissions(VA) {
      if (!missionBox) return;
      VA.api('/api/missions').then(function (data) {
        if (!data || data.ok === false) {
          errLine(missionBox, 'mission: ' + ((data && data.error) || 'unavailable')); return;
        }
        var msig = fp([data.missions, data.token]);
        if (msig === missionsFp) return;            // nothing changed → no DOM
        if (interacting(missionBox)) { whenIdle('missions', missionBox, function () { pollMissions(VA); }); return; }
        missionsFp = msig;
        missionBox.textContent = '';
        var missions = data.missions || [];
        var live = missions.filter(function (m) {
          return m.state === 'running' || m.state === 'blocked' || m.plan_state === 'parked';
        });
        missionBadge.textContent = live.length ? String(live.length) : '';
        var lend = data.token && data.token.lend;
        var tokenText = lend ? ('token lent: ' + (lend.purpose || lend.holder || 'mission'))
          : 'token held by the main agent';
        if (!missions.length) {
          var none = el('div', 'vm-none');
          none.appendChild(el('span', 'vagent-pill queued', 'no mission'));
          none.appendChild(el('span', 'vm-tok', tokenText));
          missionBox.appendChild(none);
          return;
        }
        missions.forEach(function (m) {
          var st = m.plan_state || m.state;
          var card = el('div', 'vm-card ' + (PLAN_CLS[st] || ''));
          var head = el('div', 'vm-head');
          head.appendChild(VA.highlightJob
            ? (function () {
                var b = el('button', 'vagent-ref', '#' + m.job_id);
                b.type = 'button';
                b.title = 'Show job #' + m.job_id;
                b.addEventListener('click', function () { VA.highlightJob(m.job_id); });
                return b;
              })()
            : el('span', 'vagent-pill', '#' + m.job_id));
          head.appendChild(el('span', 'vagent-pill ' + (PLAN_CLS[st] || ''), st || '?'));
          var when = el('span', 'vm-when', m.finished ? fmtAgo(m.finished) + ' ago' : fmtElapsed(m.started));
          head.appendChild(when);
          card.appendChild(head);
          var goal = el('div', 'vm-goal', m.goal || m.title || '');
          goal.title = m.goal || m.title || '';
          card.appendChild(goal);
          if (m.phase_count) {
            var cur = (m.phase_index || 0);
            var prog = el('div', 'vm-prog');
            for (var i = 0; i < m.phase_count; i++) {
              var seg = el('span', 'vm-seg' + (i < cur ? ' done' : i === cur ? ' cur' : ''));
              seg.title = 'phase ' + (i + 1) + (i === cur && m.phase_title ? ': ' + m.phase_title : '');
              prog.appendChild(seg);
            }
            var lab = el('span', 'vm-plab', 'phase ' + (cur + 1) + '/' + m.phase_count +
              (m.phase_title ? ' · ' + m.phase_title : ''));
            lab.title = m.phase_title || '';
            card.appendChild(prog);
            card.appendChild(lab);
          }
          if (m.last_verdict) {
            var vr = el('div', 'vm-verdict');
            vr.appendChild(el('span', 'vm-lbl', 'verdict'));
            vr.appendChild(verdictPill(m.last_verdict));
            if (m.last_reason) {
              var rs = el('span', 'vm-reason', m.last_reason);
              rs.title = m.last_reason;
              vr.appendChild(rs);
            }
            card.appendChild(vr);
          }
          if (m.state === 'running' || m.state === 'blocked' || m.plan_state === 'parked') {
            var btns = el('div', 'vagent-actions');
            btns.appendChild(actionBtn(VA, 'Stop', 'danger', function () {
              return VA.api('/api/stop', { method: 'POST', body: { author: 'ui' } });
            }));
            btns.appendChild(actionBtn(VA, 'Resume', 'primary', function () {
              return VA.api('/api/task', { method: 'POST', body: { text: 'pokračuj' } });
            }));
            btns.appendChild(actionBtn(VA, 'Cancel', '', function () {
              return VA.api('/api/task', { method: 'POST', body: { text: 'zruš #' + m.job_id } });
            }));
            card.appendChild(btns);
          }
          missionBox.appendChild(card);
        });
        missionBox.appendChild(el('div', 'vm-tok', tokenText));
      }).catch(function (e) { apiUnavailable(missionBox, 'mission', e); });
    }

    function actionBtn(VA, label, cls, run) {
      var b = el('button', 'vagent-actbtn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        b.disabled = true;
        run().then(function () {
          VA.notify && VA.notify('ok', label + ' sent');
          b.disabled = false;
        }).catch(function (e) {
          VA.notify && VA.notify('error', label + ': ' + e);
          b.disabled = false;
        });
      });
      return b;
    }

    // ---- blok: Zdraví / vizita -------------------------------------------
    /* Stavový řádek nahoře, nálezy jako karty (Dnes / Dříve), druh jako
       ikona + čip, dlouhý text za „více", incident tlačítka u každého. */
    /* Own tab „Incidents" (Robert): badge = findings newer than the last
       time the tab was opened; opening the tab marks them seen. */
    var doctorBox, doctorBadge = badge('warn');
    var doctorFilter = lsGet('vitulus_agent_zdravi_filter') || 'all';
    var showResolved = lsGet('vitulus_agent_incidents_resolved') === '1';
    var doctorData = null;
    var expanded = {};
    var LS_INC_SEEN = 'vitulus_agent_incidents_seen_ts';
    var incSeenTs = parseFloat(lsGet(LS_INC_SEEN) || '0') || 0;
    /* The shell fires every block's onOpen when the PANEL opens, so "is the
       Incidents tab the active one" is read from the tab bar, not remembered. */
    /* U19: this used to be `querySelector('.vagent-tab[data-tab="incidents"]')`,
       which has returned null ever since the tab was renamed to `findings`.
       The function was therefore ALWAYS false: markIncidentsSeen() was never
       reached from onOpen, the "seen" timestamp never moved, and the badge
       stayed lit however long you sat on the tab.  The shell owns the block
       -> tab mapping, so ask it instead of naming the tab here. */
    function incidentsTabActive() {
      if (!VA.blockTabActive) return false;
      return !!(VA.blockTabActive('incidents') && VA.isVisible && VA.isVisible());
    }
    function markIncidentsSeen() {
      var max = incSeenTs;
      ((doctorData && doctorData.findings) || []).forEach(function (f) {
        if ((f.ts || 0) > max) max = f.ts;
      });
      if (max > incSeenTs) { incSeenTs = max; lsSet(LS_INC_SEEN, String(max)); }
      doctorBadge.textContent = '';
    }
    VA.registerBlock({
      id: 'incidents', title: 'Incidents', order: 45, summaryExtra: doctorBadge,
      render: function (root) { doctorBox = el('div', 'vz'); root.appendChild(doctorBox); },
      poll: { every_ms: 10000, fn: function () { pollDoctor(VA); } },
      onOpen: function () { pollDoctor(VA); if (incidentsTabActive()) markIncidentsSeen(); }
    });

    var GROUP = {
      senses: {label: 'senses', icon: '⚠', cls: 'senses'},
      selfcare: {label: 'selfcare', icon: '🛠', cls: 'selfcare'},
      log: {label: 'logs', icon: '📜', cls: 'log'},
      other: {label: 'other', icon: '•', cls: 'other'}
    };
    function groupOf(f) {
      var k = String(f.kind || ''), s = String(f.source || '');
      if (/log/.test(k) || s === 'log') return 'log';
      if (s === 'selfcare' || /repair|escalat|selfcare/.test(k)) return 'selfcare';
      if (s === 'senses' || k) return 'senses';
      return 'other';
    }
    function todayStart() {
      var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000;
    }

    function pollDoctor(VA) {
      if (!doctorBox) return;
      VA.api('/api/doctor').then(function (data) {
        if (!data || data.ok === false) {
          errLine(doctorBox, 'health: ' + ((data && data.error) || 'unavailable')); return;
        }
        doctorData = data;
        drawDoctor(VA);
      }).catch(function (e) { apiUnavailable(doctorBox, 'health', e); });
    }

    /* What one card renders from — a change here is the only reason to
       touch that card's DOM. */
    function cardFp(f) {
      var act = Array.isArray(f.activity) ? f.activity : [];
      return fp([incidentId(f), stateOf(f), f.severity, f.count, f.last_seen || f.ts,
                 f.resolution, f.title, f.summary, f.problem, f.suggested,
                 f.related_job_id, (f.evidence || []).length, f.text, f.kind, f.source,
                 f.investigation, localInvestigation[incidentId(f)],
                 act.length, act[0] && (act[0].ts_done || act[0].ts),
                 f.plan && f.plan.state, f.plan && f.plan.approval_id]);
    }
    var docRendered = {};          // id → fp of the card currently in the DOM
    var docListSig = null, docHeadSig = null;

    function drawDoctor(VA, force) {
      var data = doctorData;
      if (!doctorBox || !data) return;
      if (!force && interacting(doctorBox)) {   // never under the user's hand
        whenIdle('doctor', doctorBox, function () { drawDoctor(VA); });
        return;
      }
      var findings = data.findings || [];
      var senses = data.senses || {}, selfcare = data.selfcare || {};
      var headSig = fp([senses.muted, selfcare.repairs_enabled, data.next_visit,
                        selfcare.last_repair, doctorFilter, showResolved,
                        data.counts]);   // U33: the count line lives up here
      var visible = findings.filter(function (f) {
        return (showResolved || !isResolved(f)) && (doctorFilter === 'all' || groupOf(f) === doctorFilter);
      });
      var listSig = fp([headSig, findings.length, visible.map(function (f) {
        return [incidentId(f), SEV_RANK[String(f.severity || '').toLowerCase()] || 0,
                (f.last_seen || f.ts || 0) >= todayStart()];
      })]);
      if (!force && listSig === docListSig && headSig === docHeadSig) {
        // same list, same header → patch only the cards whose data changed
        var touched = 0;
        visible.forEach(function (f) {
          var id = incidentId(f), sig = cardFp(f);
          if (docRendered[id] === sig) return;
          var old = doctorBox.querySelector('.vz-card[data-inc="' + cssEsc(id) + '"]');
          if (!old) return;
          old.replaceWith(findingCard(VA, f));
          docRendered[id] = sig;
          touched += 1;
        });
        updateDoctorBadge(VA, findings);
        return;
      }
      docListSig = listSig; docHeadSig = headSig; docRendered = {};
      var pane = doctorBox.closest('.vagent-pane');
      var keepScroll = pane ? pane.scrollTop : 0;
      renderDoctorFull(VA);
      if (pane) pane.scrollTop = keepScroll;
    }

    function updateDoctorBadge(VA, findings) {
      var hasSev = findings.some(function (f) { return !!f.severity; });
      if (hasSev) {
        var hot = findings.filter(function (f) {
          return !isResolved(f) && (SEV_RANK[String(f.severity || '').toLowerCase()] || 0) >= 3;
        }).length;
        doctorBadge.textContent = hot ? String(hot) : '';
        if (hot && VA.flagTab && !incidentsTabActive()) VA.flagTab('incidents');
      } else if (incidentsTabActive()) {
        markIncidentsSeen();
      } else {
        var fresh = findings.filter(function (f) { return (f.ts || 0) > incSeenTs; }).length;
        doctorBadge.textContent = fresh ? String(fresh) : '';
        if (fresh && VA.flagTab) VA.flagTab('incidents');
      }
    }

    function renderDoctorFull(VA) {
      var data = doctorData;
      if (!doctorBox || !data) return;
      doctorBox.textContent = '';
      var senses = data.senses || {};
      var selfcare = data.selfcare || {};
      var findings = data.findings || [];
      updateDoctorBadge(VA, findings);

      // stavový řádek
      var status = el('div', 'vz-status');
      status.appendChild(el('span', 'vagent-pill ' + (senses.muted ? 'queued' : 'done'),
        senses.muted ? 'reports muted' : 'reports on'));
      status.appendChild(el('span', 'vagent-pill ' + (selfcare.repairs_enabled === false ? 'queued' : 'done'),
        selfcare.repairs_enabled === false ? 'repairs off' : 'repairs on'));
      var visit = el('button', 'vagent-actbtn primary', 'Visit now');
      visit.type = 'button';
      visit.addEventListener('click', function () {
        visit.disabled = true;
        VA.api('/api/doctor/visit', { method: 'POST', body: {} }).then(function (r) {
          VA.notify && VA.notify(r && r.ok ? 'ok' : 'error',
            r && r.ok ? 'Visit queued (#' + r.id + ')' : 'Visit: ' + (r && r.error));
          visit.textContent = r && r.ok ? 'Visit queued ✓' : 'Visit now';
          visit.disabled = false;
          if (r && r.ok && VA.activateTab) VA.activateTab('chat');
        }).catch(function (e) {
          VA.notify && VA.notify('error', 'Visit: ' + e); visit.disabled = false;
        });
      });
      status.appendChild(visit);
      doctorBox.appendChild(status);
      var facts = el('div', 'vz-facts');
      if (data.next_visit && (data.next_visit.at || data.next_visit.ts)) {
        var nv = data.next_visit.ts || null;
        var f1 = el('div', 'vz-fact');
        f1.appendChild(el('span', 'vm-lbl', 'next visit'));
        var nvv = el('span', null, nv ? fmtIn(nv) + ' · ' + fmtAbs(nv) : String(data.next_visit.at));
        nvv.title = data.next_visit.at || '';
        f1.appendChild(nvv);
        facts.appendChild(f1);
      }
      if (selfcare.last_repair) {
        var f2 = el('div', 'vz-fact');
        f2.appendChild(el('span', 'vm-lbl', 'last repair'));
        f2.appendChild(el('span', null, (selfcare.last_repair.what || '?') +
          ' · ' + fmtAgo(selfcare.last_repair.ts) + ' ago'));
        facts.appendChild(f2);
      }
      if (facts.childNodes.length) doctorBox.appendChild(facts);

      // filters: state (open by default, "show resolved" toggle) + kind
      var resolvedCount = findings.filter(isResolved).length;
      var base = findings.filter(function (f) { return showResolved || !isResolved(f); });
      var counts = {all: base.length, senses: 0, selfcare: 0, log: 0, other: 0};
      base.forEach(function (f) { counts[groupOf(f)] += 1; });
      var chips = el('div', 'vz-chips');
      ['all', 'senses', 'selfcare', 'log'].forEach(function (g) {
        if (g !== 'all' && !counts[g]) return;
        /* U47: this chip said „all 12" one line above „114 open".  Both
           numbers were true and the second one was the honest correction
           added by U33 — but „all" means all, and all is 114.  The chip
           filters the LIST, so it says what the list is: what is shown. */
        var c = el('button', 'vagent-fchip' + (doctorFilter === g ? ' on' : ''),
          (g === 'all' ? 'shown' : GROUP[g].label) + ' ' + counts[g]);
        if (g === 'all') {
          c.title = 'Everything this grouped view holds — not every finding ' +
                    'the agent has. The real totals are on the line below.';
        }
        c.type = 'button';
        c.addEventListener('click', function () {
          doctorFilter = g; lsSet('vitulus_agent_zdravi_filter', g); drawDoctor(VA);
        });
        chips.appendChild(c);
      });
      if (resolvedCount) {
        var rc = el('button', 'vagent-fchip vz-resolved-toggle' + (showResolved ? ' on' : ''),
          (showResolved ? 'hide resolved' : 'show resolved') + ' ' + resolvedCount);
        rc.type = 'button';
        rc.addEventListener('click', function () {
          showResolved = !showResolved; lsSet('vitulus_agent_incidents_resolved', showResolved ? '1' : '0');
          drawDoctor(VA);
        });
        chips.appendChild(rc);
      }
      doctorBox.appendChild(chips);

      /* U33: „all 12" was the number of ROWS this endpoint grouped, and the
         panel had no other number, so it read as „twelve findings exist".
         At that moment the agent's own ledger held 113 open — and the chat,
         a tab away, was saying „0 otevřených nálezů".  One word, three
         numbers.  The core now states the authoritative figure in `counts`
         (`source: v2:work.kind=finding`); every number the panel prints
         ABOUT HOW MANY findings there are comes from there, and the list
         below stays what it honestly is: a grouped view of some of them.
         When the core cannot reach v2 it sends `open: null` — and a number
         that could not be read is printed as unreadable, never as 0.  „Not
         available" and „none" are opposite facts and must not look alike. */
      var cnt = data.counts;
      if (cnt) {
        var cl = el('div', 'vz-counts');
        var gb = el('span');
        gb.appendChild(VA.num(base.length,
          'derived: /api/doctor#findings, grouped and filtered by this panel'));
        gb.appendChild(document.createTextNode(' grouped below'));
        cl.appendChild(gb);
        if (cnt.open === null || cnt.open === undefined) {
          cl.appendChild(el('span', 'vz-unknown',
            'open: could not be read — this is not a zero'));
        } else {
          var ob = el('span');
          ob.appendChild(VA.num(cnt.open, '/api/doctor#counts.open'));
          ob.appendChild(document.createTextNode(' open'));
          if (cnt.total) {
            ob.appendChild(document.createTextNode(' · '));
            ob.appendChild(VA.num(cnt.total, '/api/doctor#counts.total'));
            ob.appendChild(document.createTextNode(' ever'));
          }
          cl.appendChild(ob);
        }
        cl.title = 'Counted by the agent itself' +
          (cnt.source ? ' (' + cnt.source + ')' : '') +
          '. The list below groups repeats, so it is shorter than the count.';
        doctorBox.appendChild(cl);
      }

      // list: severity first (critical on top), then most recent; Today / Earlier
      var shown = base.filter(function (f) {
        return doctorFilter === 'all' || groupOf(f) === doctorFilter;
      });
      if (!shown.length) {
        doctorBox.appendChild(el('div', 'vagent-empty',
          findings.length ? (base.length ? 'Nothing in this filter.' : 'All incidents resolved.')
            : 'No findings — robot and agent are fine.'));
        return;
      }
      function seen(f) { return f.last_seen || f.ts || 0; }
      shown.sort(function (a, b) {
        var ra = SEV_RANK[String(a.severity || '').toLowerCase()] || 0;
        var rb = SEV_RANK[String(b.severity || '').toLowerCase()] || 0;
        if (rb !== ra) return rb - ra;
        return seen(b) - seen(a);
      });
      var t0 = todayStart();
      var groups = [{label: 'Today', items: []}, {label: 'Earlier', items: []}];
      shown.forEach(function (f) { groups[seen(f) >= t0 ? 0 : 1].items.push(f); });
      groups.forEach(function (gp) {
        if (!gp.items.length) return;
        var h = el('div', 'vz-group');
        h.appendChild(el('span', null, gp.label));
        h.appendChild(el('span', 'vagent-cnt', String(gp.items.length)));
        doctorBox.appendChild(h);
        gp.items.forEach(function (f) {
          doctorBox.appendChild(findingCard(VA, f));
          docRendered[incidentId(f)] = cardFp(f);
        });
      });
    }

    /* Incident card.  Everything beyond {id, ts, kind, title, text, source,
       actions} is optional — the backend is growing the shape (summary,
       problem, evidence[], first_seen, last_seen, count, state, resolution,
       severity, suggested, related_job_id); what is missing is skipped. */
    var SEV_RANK = {critical: 4, high: 3, medium: 2, low: 1};
    var STATE_LABEL = {open: 'open', acknowledged: 'acknowledged',
                       investigated: 'investigated',
                       resolved: 'resolved', auto_repaired: 'auto-repaired'};
    var localState = {};      // optimistic ack/resolve until the next poll agrees
    /* „Investigate" = a deeper look, not a repair: the core opens a job that
       reads the evidence and comes back with a verdict (fix now / fix later /
       monitor / ignore), the cause and the effort.  Until the poll carries
       that back, the button's own answer („investigating → #job") is kept
       here so a redraw does not lose it. */
    var localInvestigation = {};
    var VERDICT_LABEL = {fix_now: 'fix now', fix_later: 'fix later',
                         monitor: 'monitor', ignore: 'ignore'};
    var PLAN_STATE_LABEL = {waiting: 'waiting approval', approved: 'approved',
                            denied: 'denied', executed: 'executed'};
    var ACT_ICON = {assigned: '🛠', planned: '🗺', plan_approved: '✅',
                    plan_denied: '⛔', executed: '⚙', investigated: '🔎',
                    acknowledged: '👁', resolved: '✔', reopened: '↩',
                    comment: '💬', noted: '·'};

    function stateOf(f) {
      var id = incidentId(f);
      var s = localState[id] || f.state || 'open';
      // A finding that carries a verdict has been looked at, whatever the
      // older core still calls it.
      if (s === 'open' && investigationOf(f)) { return 'investigated'; }
      return s;
    }
    function investigationOf(f) {
      var loc = localInvestigation[incidentId(f)];
      if (f.investigation && typeof f.investigation === 'object') { return f.investigation; }
      return loc && loc.verdict ? loc : null;
    }
    function incidentId(f) {
      return f.id || (String(f.source || '') + ':' + String(f.ts || ''));
    }
    function isResolved(f) {
      var s = stateOf(f);
      return s === 'resolved' || s === 'auto_repaired';
    }

    function toggleSection(card, label, count, openByDefault, build) {
      var det = el('details', 'vz-sec');
      // open state lives in openSet (+ sessionStorage), never only in the DOM
      var key = (card.getAttribute('data-inc') || '') + ':' + label.toLowerCase();
      det.open = isOpen(key, openByDefault);
      det.addEventListener('toggle', function () { setOpen(key, det.open); });
      var sum = el('summary');
      sum.appendChild(el('span', null, label));
      if (count) sum.appendChild(el('span', 'vagent-cnt', String(count)));
      det.appendChild(sum);
      var body = el('div', 'vz-secbody');
      build(body);
      det.appendChild(body);
      card.appendChild(det);
      return det;
    }

    function postIncident(VA, id, verb) {
      return VA.api('/api/incidents/' + encodeURIComponent(id) + '/' + verb,
        { method: 'POST', body: { author: VA.authorId || 'ui' } });
    }

    function findingCard(VA, f) {
      var g = GROUP[groupOf(f)];
      var id = incidentId(f);
      var sev = String(f.severity || '').toLowerCase();
      var state = stateOf(f);
      var lastSeen = f.last_seen || f.ts;
      var card = el('div', 'vz-card ' + g.cls + (sev ? ' sev-' + sev : '') +
        (isResolved(f) ? ' resolved' : ''));
      card.setAttribute('data-inc', id);

      // ---- head: severity · icon · title · ×N · time
      var head = el('div', 'vz-head');
      if (sev) {
        var sp = el('span', 'vz-sev ' + sev, sev);
        sp.title = 'severity: ' + sev;
        head.appendChild(sp);
      }
      var ico = el('span', 'vz-ico', g.icon);
      ico.title = g.label + (f.kind ? ' · ' + f.kind : '');
      head.appendChild(ico);
      var title = el('span', 'vz-title', f.title || f.kind || '?');
      title.title = (f.title || '') + (f.kind ? ' [' + f.kind + ']' : '');
      head.appendChild(title);
      if (f.count && f.count > 1) {
        var cnt = el('span', 'vz-count', '×' + f.count);
        cnt.title = f.count + ' occurrences merged';
        head.appendChild(cnt);
      }
      var when = el('span', 'vz-when', lastSeen ? fmtAgo(lastSeen) + ' ago' : '');
      when.title = (f.first_seen ? 'first: ' + fmtAbs(f.first_seen) + '\n' : '') +
        'last: ' + fmtAbs(lastSeen);
      head.appendChild(when);
      card.appendChild(head);

      // ---- always visible: summary + problem (fallback: text)
      var summary = f.summary || '';
      var problem = f.problem || '';
      if (summary) card.appendChild(el('div', 'vz-summary', summary));
      if (problem) {
        var pr = el('div', 'vz-problem');
        pr.appendChild(el('span', 'vz-plabel', 'Problem'));
        pr.appendChild(el('span', null, problem));
        card.appendChild(pr);
      }
      var text = String(f.text || '');
      if (text && !summary && !problem) {
        var long = text.length > 140 || text.split('\n').length > 2;
        var tkey = id + ':text';
        var body = el('div', 'vz-body' + (long && !isOpen(tkey, false) ? ' clip' : ''));
        body.textContent = text;
        card.appendChild(body);
        if (long) {
          var more = el('button', 'vz-more', isOpen(tkey, false) ? 'less' : 'more');
          more.type = 'button';
          more.addEventListener('click', function (e) {
            e.stopPropagation();
            var nowOpen = !isOpen(tkey, false);
            setOpen(tkey, nowOpen);
            body.classList.toggle('clip', !nowOpen);
            more.textContent = nowOpen ? 'less' : 'more';
          });
          card.appendChild(more);
        }
      } else if (text && (summary || problem) && text !== summary && text !== problem) {
        toggleSection(card, 'Details', 0, false, function (box) {
          var b = el('div', 'vz-body'); b.textContent = text; box.appendChild(b);
        });
      }

      // ---- evidence (collapsed)
      var ev = Array.isArray(f.evidence) ? f.evidence : [];
      if (ev.length) {
        toggleSection(card, 'Evidence', ev.length, false, function (box) {
          ev.forEach(function (e) {
            if (!e) return;
            var line = el('div', 'vz-ev');
            if (e.source) {
              var src = el('code', 'vz-evsrc', String(e.source));
              src.title = String(e.source);
              line.appendChild(src);
            }
            var t = String(e.text || '');
            var isLog = /\[(ERROR|WARN|INFO|rosout)\]|Traceback|\.log\b/.test(t) || /log/.test(String(e.source || ''));
            var tx = el(isLog ? 'code' : 'span', 'vz-evtext' + (isLog ? ' log' : ''), t);
            tx.title = t;
            tx.addEventListener('click', function () { toggleEv(); });
            line.appendChild(tx);
            /* U31: the click-to-expand already existed but nothing said so —
               no marker, no cursor hint a finger can see — so on a phone the
               evidence simply ended in „…".  A visible button, and only when
               there is something behind the fold: three lines are roughly
               3×45 characters in this column, so anything shorter is already
               whole and an extra control would be noise. */
            var more = null;
            function toggleEv() {
              var open = tx.classList.toggle('full');
              if (more) { more.textContent = open ? 'less' : 'more'; }
            }
            if (t.length > 120) {
              more = el('button', 'vz-evmore', 'more');
              more.type = 'button';
              more.title = 'Show the whole line';
              more.addEventListener('click', function (ev) {
                ev.stopPropagation(); toggleEv();
              });
              line.appendChild(more);
            }
            if (e.ts) {
              var w = el('span', 'vz-evts', fmtClock(e.ts));
              w.title = fmtAbs(e.ts);
              line.appendChild(w);
            }
            box.appendChild(line);
          });
        });
      }

      // ---- suggested
      if (f.suggested) {
        var sg = el('div', 'vz-suggest');
        sg.appendChild(el('span', 'vz-plabel', 'Suggested'));
        sg.appendChild(el('span', null, String(f.suggested)));
        card.appendChild(sg);
      }

      // ---- investigation: verdict · cause · effort (when the core has one)
      var inv = investigationOf(f);
      var pend = localInvestigation[id];
      if (inv) {
        var ib = el('div', 'vz-inv verdict-' + String(inv.verdict || '').toLowerCase());
        var ih = el('div', 'vz-invhead');
        ih.appendChild(el('span', 'vz-plabel', 'Investigation'));
        ih.appendChild(el('span', 'vz-verdict ' + String(inv.verdict || '').toLowerCase(),
          VERDICT_LABEL[inv.verdict] || inv.verdict || '?'));
        if (inv.effort) {
          var ef = el('span', 'vz-effort', 'effort: ' + inv.effort);
          ef.title = 'estimated effort';
          ih.appendChild(ef);
        }
        if (inv.job_id) {
          var jb = el('button', 'vagent-ref', '→ #' + inv.job_id);
          jb.type = 'button';
          jb.title = 'Show the investigating job';
          jb.addEventListener('click', function () { if (VA.highlightJob) VA.highlightJob(inv.job_id); });
          ih.appendChild(jb);
        }
        if (inv.ts) {
          var iw = el('span', 'vz-when', fmtAgo(inv.ts) + ' ago');
          iw.title = fmtAbs(inv.ts);
          ih.appendChild(iw);
        }
        ib.appendChild(ih);
        if (inv.cause) {
          var ic = el('div', 'vz-cause', String(inv.cause));
          ic.title = String(inv.cause);
          ib.appendChild(ic);
        }
        card.appendChild(ib);
      } else if (pend && pend.pending) {
        var pb = el('div', 'vz-inv pending');
        pb.appendChild(el('span', 'vz-plabel', 'Investigation'));
        var pt = el('span', null, 'investigating');
        pb.appendChild(pt);
        if (pend.job_ref) {
          var pj = el('button', 'vagent-ref', '→ #' + String(pend.job_ref).replace(/^[js]:/, ''));
          pj.type = 'button';
          pj.addEventListener('click', function () { if (VA.highlightJob) VA.highlightJob(pend.job_ref); });
          pb.appendChild(pj);
        }
        card.appendChild(pb);
      }

      // ---- plan: visible at the incident, waiting for the owner
      var plan = (f.plan && typeof f.plan === 'object') ? f.plan : null;
      if (plan && plan.text) {
        var pstate = String(plan.state || 'waiting');
        var pl = el('div', 'vz-plan plan-' + pstate);
        var ph = el('div', 'vz-invhead');
        ph.appendChild(el('span', 'vz-plabel', 'Plan'));
        ph.appendChild(el('span', 'vz-planstate ' + pstate,
          PLAN_STATE_LABEL[pstate] || pstate));
        if (plan.job_id) {
          var pj = el('button', 'vagent-ref', '→ #' + plan.job_id);
          pj.type = 'button';
          pj.title = 'Show the planning job';
          pj.addEventListener('click', function () { if (VA.highlightJob) VA.highlightJob(plan.job_id); });
          ph.appendChild(pj);
        }
        if (plan.ts) {
          var pw = el('span', 'vz-when', fmtAgo(plan.ts) + ' ago');
          pw.title = fmtAbs(plan.ts);
          ph.appendChild(pw);
        }
        pl.appendChild(ph);
        var ptxt = String(plan.text || '');
        var pkey = id + ':plan';
        var pbody = el('pre', 'vz-plantext' + (isOpen(pkey, false) ? '' : ' clip'));
        pbody.textContent = ptxt;
        pl.appendChild(pbody);
        if (ptxt.length > 160 || ptxt.split('\n').length > 3) {
          var pmore = el('button', 'vz-more', isOpen(pkey, false) ? 'less' : 'more');
          pmore.type = 'button';
          pmore.addEventListener('click', function (e) {
            e.stopPropagation();
            var nowOpen = !isOpen(pkey, false);
            setOpen(pkey, nowOpen);
            pbody.classList.toggle('clip', !nowOpen);
            pmore.textContent = nowOpen ? 'less' : 'more';
          });
          pl.appendChild(pmore);
        }
        if (pstate === 'waiting' && plan.approval_id) {
          var prow = el('div', 'vz-planbtns');
          var okb = el('button', 'vagent-actbtn approve', 'Approve plan');
          okb.type = 'button';
          okb.title = 'Approving runs the plan (approval #' + plan.approval_id + ')';
          var nob = el('button', 'vagent-actbtn deny', 'Deny');
          nob.type = 'button';
          var decidePlan = function (decision, btn) {
            btn.disabled = true;
            /* keep_error_body: a refused decision is a 403 whose body holds
               the only explanation. Until 2026-09-02 this catch swallowed it
               and re-enabled the button, so pressing Approve looked like
               pressing nothing at all — the failure the owner reported. */
            VA.api('/api/approvals/decide',
              { method: 'POST', keep_error_body: true,
                body: { id: plan.approval_id, decision: decision,
                        by: VA.authorId || 'ui' } })
              .then(function (r) {
                if (r && (r.ok || r.state)) {
                  prow.textContent = decision === 'allow'
                    ? 'approved — executing' : 'denied';
                } else {
                  btn.disabled = false;
                  prow.appendChild(el('span', 'vz-err',
                    (r && r.error) || 'failed'));
                }
              })
              .catch(function (err) {
                btn.disabled = false;
                var msg = (err && err.body && err.body.error)
                  || (err && err.status ? 'refused (HTTP ' + err.status + ')' : '')
                  || 'agent unreachable';
                var e = el('span', 'vz-err', String(msg));
                e.style.whiteSpace = 'pre-wrap';
                prow.appendChild(e);
              });
          };
          okb.addEventListener('click', function () { decidePlan('allow', okb); });
          nob.addEventListener('click', function () { decidePlan('deny', nob); });
          prow.appendChild(okb);
          prow.appendChild(nob);
          pl.appendChild(prow);
        }
        card.appendChild(pl);
      }

      // ---- activity: everything that happened around this incident
      var acts = Array.isArray(f.activity) ? f.activity : [];
      if (acts.length) {
        toggleSection(card, 'Activity', acts.length, true, function (box) {
          acts.forEach(function (a) {
            if (!a) return;
            var line = el('div', 'vz-act');
            var ic = el('span', 'vz-actic', ACT_ICON[a.kind] || '·');
            ic.title = a.kind || '';
            line.appendChild(ic);
            var tsEl = el('span', 'vz-evts', a.ts ? fmtClock(a.ts) : '');
            tsEl.title = a.ts ? fmtAbs(a.ts) : '';
            line.appendChild(tsEl);
            line.appendChild(el('span', 'vz-actsum', String(a.summary || a.kind || '')));
            if (a.job_id) {
              var ab = el('button', 'vagent-ref', '#' + a.job_id);
              ab.type = 'button';
              ab.title = 'Show job #' + a.job_id;
              ab.addEventListener('click', function () { if (VA.highlightJob) VA.highlightJob(a.job_id); });
              line.appendChild(ab);
            }
            if (a.state) {
              line.appendChild(el('span', 'vz-actstate ' + a.state, a.state));
            }
            box.appendChild(line);
            if (a.result) {
              var rkey = id + ':act:' + (a.job_id || a.ts);
              var res = el('div', 'vz-actres' + (isOpen(rkey, false) ? '' : ' clip'));
              res.textContent = String(a.result);
              res.title = 'click to expand';
              res.addEventListener('click', function () {
                var nowOpen = !isOpen(rkey, false);
                setOpen(rkey, nowOpen);
                res.classList.toggle('clip', !nowOpen);
              });
              box.appendChild(res);
            }
          });
        });
      }

      // ---- footer: state pill · related job · resolution
      var foot = el('div', 'vz-foot');
      var stp = el('span', 'vz-state ' + state, STATE_LABEL[state] || state);
      if (f.resolution) stp.title = String(f.resolution);
      foot.appendChild(stp);
      if (f.related_job_id) {
        foot.appendChild(el('span', 'vm-lbl', 'related job'));
        var rb = el('button', 'vagent-ref', '#' + f.related_job_id);
        rb.type = 'button';
        rb.title = 'Show job #' + f.related_job_id;
        rb.addEventListener('click', function () { if (VA.highlightJob) VA.highlightJob(f.related_job_id); });
        foot.appendChild(rb);
      }
      if (f.resolution) {
        var rs = el('span', 'vz-resolution', String(f.resolution));
        rs.title = String(f.resolution);
        foot.appendChild(rs);
      }
      card.appendChild(foot);

      // ---- actions: Assign / Plan / Execute + Acknowledge / Resolve
      var acts = (f.actions && f.actions.length) ? f.actions
        : (VA.incidentActions ? VA.incidentActions(id, f.title, summary || f.text) : []);
      var bar;
      if (acts.length && VA.actionButtons) {
        bar = VA.actionButtons(card, id, acts);
      } else {
        bar = el('div', 'vagent-actions');
        acts.forEach(function (a) {
          var b = el('button', 'vagent-actbtn', a.label);
          b.type = 'button';
          b.addEventListener('click', function () {
            VA.submitText(a.text, {incident_id: id, action: a.action || a.label});
            if (VA.activateTab) VA.activateTab('chat');
          });
          bar.appendChild(b);
        });
        card.appendChild(bar);
      }
      if (!isResolved(f)) {
        // Investigate — a deeper look before anyone decides what to do.
        var pending = localInvestigation[id];
        var invBtn = el('button', 'vagent-actbtn', inv ? 'Investigate again' : 'Investigate');
        invBtn.type = 'button';
        invBtn.title = 'Open a job that digs into this incident and comes back with a verdict';
        if (pending && pending.pending) {
          invBtn.disabled = true;
          invBtn.textContent = 'investigating…';
        }
        invBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          invBtn.disabled = true;
          invBtn.textContent = 'investigating…';
          localInvestigation[id] = {pending: true};
          VA.api('/api/incidents/' + encodeURIComponent(id) + '/investigate',
                 {method: 'POST', body: {author: VA.authorId || 'ui'}})
            .then(function (r) {
              if (!r || r.ok === false) {
                delete localInvestigation[id];
                invBtn.disabled = false;
                invBtn.textContent = 'Investigate';
                invBtn.title = 'investigate failed: ' + ((r && r.error) || '?');
                drawDoctor(VA, true);
                return;
              }
              localInvestigation[id] = {pending: true, job_ref: r.job_ref || r.job_id || null};
              VA.notify && VA.notify('ok', 'investigating');
              drawDoctor(VA, true);
            })
            .catch(function (err) {
              delete localInvestigation[id];
              invBtn.disabled = false;
              invBtn.textContent = 'Investigate';
              if (/HTTP 404/.test(String(err))) {
                // Contract not live yet — ask for the same thing in chat.
                invBtn.title = 'API not available yet — sent to chat';
                VA.submitText('prozkoumej hlouběji incident #' + id + ': ' +
                  String(f.title || summary || f.text || '').slice(0, 160) +
                  ' — vrať verdikt (fix now / fix later / monitor / ignore), příčinu a odhad práce',
                  {incident_id: id, action: 'investigate'});
                if (VA.activateTab) VA.activateTab('chat');
              } else {
                invBtn.title = 'investigate failed: ' + err;
              }
              drawDoctor(VA, true);
            });
        });
        bar.appendChild(invBtn);
        if (state !== 'acknowledged') {
          var ack = el('button', 'vagent-actbtn', 'Acknowledge');
          ack.type = 'button';
          ack.title = 'Mark as seen — stays open';
          ack.addEventListener('click', function (e) {
            e.stopPropagation();
            ack.disabled = true;
            localState[id] = 'acknowledged';
            postIncident(VA, id, 'ack').then(function (r) {
              if (r && r.ok === false) { delete localState[id]; ack.disabled = false; ack.title = 'ack failed: ' + (r.error || '?'); }
              drawDoctor(VA);
            }).catch(function (err) {
              delete localState[id]; ack.disabled = false;
              VA.notify && VA.notify('error', 'Acknowledge: ' + err);
              drawDoctor(VA);
            });
          });
          bar.appendChild(ack);
        }
        var res = el('button', 'vagent-actbtn danger', 'Resolve');
        res.type = 'button';
        res.title = 'Close the incident';
        res.addEventListener('click', function (e) {
          e.stopPropagation();
          var run = function () {
            res.disabled = true;
            localState[id] = 'resolved';
            postIncident(VA, id, 'resolve').then(function (r) {
              if (r && r.ok === false) { delete localState[id]; res.title = 'resolve failed: ' + (r.error || '?'); }
              drawDoctor(VA);
            }).catch(function (err) {
              delete localState[id];
              VA.notify && VA.notify('error', 'Resolve: ' + err);
              drawDoctor(VA);
            });
          };
          if (VA.inlineConfirm) VA.inlineConfirm(res, run); else run();
        });
        bar.appendChild(res);
      }
      return card;
    }

    // ---- blok: Nástroje a skills -----------------------------------------
    /* Přepínač Nástroje | Skills s hledáním, skills podle kategorie, pod tím
       timeline „co si Hermes přidal". */
    var growthBox, growthBadge = badge(), growthFp = null;
    var growthData = null;
    var toolsView = lsGet('vitulus_agent_tools_view') || 'tools';
    var toolsQuery = '';
    VA.registerBlock({
      id: 'nastroje', title: 'Tools & skills', order: 60, summaryExtra: growthBadge,
      render: function (root) { growthBox = el('div', 'vt'); root.appendChild(growthBox); },
      poll: { every_ms: 30000, fn: function () { pollGrowth(VA); } },
      onOpen: function () { pollGrowth(VA); }
    });

    function pollGrowth(VA) {
      if (!growthBox) return;
      VA.api('/api/growth').then(function (data) {
        if (!data || data.ok === false) {
          errLine(growthBox, 'tools: ' + ((data && data.error) || 'unavailable')); return;
        }
        var gsig = fp(data);
        if (gsig === growthFp) return;              // same data → keep search box, focus, scroll
        if (interacting(growthBox)) { whenIdle('growth', growthBox, function () { pollGrowth(VA); }); return; }
        growthFp = gsig;
        growthData = data;
        drawGrowth(VA);
      }).catch(function (e) { apiUnavailable(growthBox, 'tools', e); });
    }

    /* U27: „97 tools & skills" was a raw directory listing.  Among the 37
       „tools" were `__pycache__`, `INDEX.md` and `doctor_round_bak_setu_
       20260830.sh` — a BACKUP of the tool sitting next to it; among the 60
       „skills" five internal files of the skill hub (`.hub/lock.json` &c).
       The owner was being offered a lock file as something the agent knows
       how to do.  Rules, not a list of names — a new backup or cache must
       fall in the same hole:
         · any path segment starting with `.`   → store internals (.hub/*)
         · any path segment starting with `__`  → language caches (__pycache__)
         · `_bak_` / `.bak` / trailing `~`      → a backup of a real tool
         · `.md` / `.txt` among the TOOLS       → documentation, not a tool
           (a skill may legitimately be prose, a tool is something you run)
       What is filtered is SAID, not swallowed: the count line below the
       switch names how many were hidden and why, and shows them on click.
       One kind of junk survives this and cannot be fixed from here: a plain
       DIRECTORY with no extension (`tools/tasks`) is byte-for-byte the same
       as an extensionless tool script in what /api/growth sends.  The fix
       for that one belongs to the endpoint (see the report: `kind` and
       `exec` per entry) — guessing it from the name would be a lie that
       happens to be right today. */
    function junkReason(e, view) {
      var name = String((e && e.name) || '');
      var segs = name.split('/');
      for (var i = 0; i < segs.length; i++) {
        if (segs[i].indexOf('__') === 0) return 'cache';
        if (segs[i].indexOf('.') === 0 && segs[i] !== '.') return 'internal';
      }
      if (/_bak_|\.bak$|~$/.test(name)) return 'backup';
      if (view === 'tools' && /\.(md|txt|rst)$/i.test(name)) return 'doc';
      return null;
    }
    function siftGrowth(list, view) {
      var keep = [], drop = [];
      (list || []).forEach(function (e) {
        var why = junkReason(e, view);
        if (why) { e = e || {}; drop.push({e: e, why: why}); } else { keep.push(e); }
      });
      return {keep: keep, drop: drop};
    }

    function itemRow(e) {
      var r = el('div', 'vt-item');
      var n = el('span', 'vt-name', e.name || '?');
      n.title = e.path || e.name || '';
      r.appendChild(n);
      var a = el('span', 'vt-age', e.mtime ? fmtAgo(e.mtime) : '');
      a.title = fmtAbs(e.mtime);
      r.appendChild(a);
      return r;
    }

    function drawGrowth(VA) {
      var data = growthData;
      if (!growthBox || !data) return;
      growthBox.textContent = '';
      var siftedTools = siftGrowth(data.tools, 'tools');
      var siftedSkills = siftGrowth(data.skills, 'skills');
      var tools = siftedTools.keep, skills = siftedSkills.keep;
      var hidden = siftedTools.drop.concat(siftedSkills.drop);
      var growth = data.growth || [];
      growthBadge.textContent = String(tools.length + skills.length);

      // přepínač + hledání
      var bar = el('div', 'vt-bar');
      [['tools', 'Tools', tools.length], ['skills', 'Skills', skills.length]].forEach(function (v) {
        var b = el('button', 'vagent-fchip' + (toolsView === v[0] ? ' on' : ''), v[1] + ' ' + v[2]);
        b.type = 'button';
        b.addEventListener('click', function () {
          toolsView = v[0]; lsSet('vitulus_agent_tools_view', v[0]); drawGrowth(VA);
        });
        bar.appendChild(b);
      });
      var q = el('input', 'vt-q');
      q.type = 'search'; q.placeholder = 'search…'; q.value = toolsQuery;
      q.addEventListener('input', function () {
        toolsQuery = q.value.trim().toLowerCase();
        drawList();
      });
      bar.appendChild(q);
      growthBox.appendChild(bar);

      var listBox = el('div', 'vt-list');
      growthBox.appendChild(listBox);
      function matches(e) {
        if (!toolsQuery) return true;
        return (String(e.name || '') + ' ' + String(e.path || '')).toLowerCase().indexOf(toolsQuery) >= 0;
      }
      function drawList() {
        listBox.textContent = '';
        if (toolsView === 'tools') {
          var ts = tools.filter(matches);
          if (!ts.length) listBox.appendChild(el('div', 'vagent-empty', 'nothing found'));
          ts.forEach(function (e) { listBox.appendChild(itemRow(e)); });
          return;
        }
        // skills podle kategorie (adresář)
        var cats = {};
        skills.filter(matches).forEach(function (e) {
          var parts = String(e.name || '').split('/');
          var cat = parts.length > 1 ? parts[0] : 'other';
          (cats[cat] = cats[cat] || []).push({name: parts.length > 1 ? parts.slice(1).join('/') : e.name,
                                                path: e.path, mtime: e.mtime});
        });
        var keys = Object.keys(cats).sort();
        if (!keys.length) listBox.appendChild(el('div', 'vagent-empty', 'nothing found'));
        keys.forEach(function (cat) {
          var h = el('div', 'vz-group');
          h.appendChild(el('span', null, cat));
          h.appendChild(el('span', 'vagent-cnt', String(cats[cat].length)));
          listBox.appendChild(h);
          cats[cat].sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); })
            .forEach(function (e) { listBox.appendChild(itemRow(e)); });
        });
      }
      drawList();

      // What the two counts above do NOT include, and why — said out loud,
      // because a backup quietly appearing in the tools directory is itself
      // worth seeing (registry finding S4).
      if (hidden.length) {
        var WHY = {backup: 'backup copies', cache: 'language caches',
                   internal: 'store internals', doc: 'documentation'};
        var order = ['backup', 'cache', 'internal', 'doc'];
        var counts = {};
        hidden.forEach(function (h) { counts[h.why] = (counts[h.why] || 0) + 1; });
        var parts = order.filter(function (k) { return counts[k]; })
          .map(function (k) { return counts[k] + ' ' + WHY[k]; });
        var det = el('details', 'vt-hidden');
        var sm = el('summary', null,
                    hidden.length + ' not counted — ' + parts.join(', '));
        det.appendChild(sm);
        hidden.slice().sort(function (a, b) {
          return (b.e.mtime || 0) - (a.e.mtime || 0);
        }).forEach(function (h) {
          var row = itemRow(h.e);
          row.insertBefore(el('span', 'vagent-pill queued', WHY[h.why] || h.why),
                           row.firstChild);
          det.appendChild(row);
        });
        growthBox.appendChild(det);
      }

      // timeline růstu
      var gh = el('div', 'vz-group');
      gh.appendChild(el('span', null, 'What Hermes added'));
      gh.appendChild(el('span', 'vagent-cnt', growth.length ? String(growth.length) : ''));
      growthBox.appendChild(gh);
      if (!growth.length) growthBox.appendChild(el('div', 'vagent-empty', 'nothing yet'));
      growth.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).forEach(function (entry) {
        var line = el('div', 'vt-g');
        line.appendChild(el('span', 'vagent-pill ' + (
          entry.kind === 'built' ? 'done' : entry.kind === 'refused' ? 'failed' : 'queued'),
          entry.kind || '?'));
        var s = el('span', 'vt-gs', entry.summary || '');
        s.title = entry.summary || '';
        line.appendChild(s);
        if (entry.job_id && VA.highlightJob) {
          var rb = el('button', 'vagent-ref', '#' + entry.job_id);
          rb.type = 'button';
          rb.addEventListener('click', function () { VA.highlightJob(entry.job_id); });
          line.appendChild(rb);
        }
        var w = el('span', 'vt-age', fmtAgo(entry.ts));
        w.title = fmtAbs(entry.ts);
        line.appendChild(w);
        growthBox.appendChild(line);
      });
    }

    // ---- blok: Nástroje robota (karty z manifestu) ------------------------
    /* Majitel: „Vsechny tyhle nastroje jsou v tabu Robot a jsou tam
       prezentovany jejich vysledky, nebo tam jsou ovladat.  Jsou to custom
       panely pro kazdy tool dle toho jak je udelan."
       Custom panel per tool — but NOT a panel written per tool.  The card is
       DERIVED from the manifest the core serves at /api/v2/tools: the form
       comes from `vstupy` (five input types -> five widgets), the result
       from `vystup` (five output kinds -> five renderers).  A tool that
       lands tomorrow gets its card without anyone opening this file; a tool
       that needs something genuinely its own may bring its own renderer, but
       that is the exception, not the rule.  Data shape: reports/kachna/
       oprava_videni.md §4.

       Two things this card must not do:
       · It must not become a way around the dock lock.  `druh: pohled` and
         `cidlo` are reading and are free; anything that touches the machine
         (`touches != read`) gets NO Run button here at all, and the core
         refuses it with 403 even if one appeared.  Movement is unlocked by
         the owner clicking in the dock card, and nowhere else.
       · It must not hide how old a picture is.  Tonight the agent called a
         five-hour-old view „about ten minutes old".  The age is printed next
         to the image as a chip, from `age_s`, and the core's own sentence
         („POŘÍZENO před 42 s", which also separates EMPTY from UNREADABLE)
         is printed under it verbatim.
       And no polling: these run on a click.  U2 was born of a panel that
       re-rendered the map every 15 s for 4.9 s of the robot's CPU. */
    var toolsBox = null, toolsData = null, toolsState = null,
        toolsArgs = {}, toolsResult = {}, toolsBusy = {};

    var TOOL_KIND_EN = {pohled: 'view', cidlo: 'sensor', ovladani: 'control'};
    var TOOL_TOUCH_EN = {read: 'reads only', code: 'writes code',
                         robot: 'touches the machine'};
    var TOOL_AUTHOR_EN = {dodano: 'shipped', agent: 'built by the agent',
                          majitel: 'asked for by the owner'};

    VA.registerBlock({
      id: 'tools', title: 'Robot tools', order: 55,
      render: function (root) { toolsBox = root; drawTools(VA); loadTools(VA); },
      onOpen: function () { if (toolsState !== 'ok') { loadTools(VA); } }
    });

    function loadTools(VA) {
      VA.api('/api/v2/tools', {timeout_ms: 12000}).then(function (d) {
        if (!d || d.agent_down) { return; }
        if (d.ok === false || !d.tools) { toolsState = 'unsupported'; }
        else { toolsState = 'ok'; toolsData = d; }
        drawTools(VA);
      }).catch(function (e) {
        toolsState = /HTTP 404/.test(String(e)) ? 'unsupported' : 'down';
        drawTools(VA);
      });
    }

    function toolArg(id, name, dflt) {
      var a = toolsArgs[id] || (toolsArgs[id] = {});
      if (!(name in a)) { a[name] = dflt; }
      return a[name];
    }

    /* U45: the form showed the owner VARIABLE NAMES — `LAYERS`, `SPAN_M`,
       `FRESH` — because the manifest carries only `jmeno`, `typ` and
       `vychozi` for an input, and the panel printed the key (in capitals, at
       that).  `SPAN_M` does not tell anyone it is a size in metres.
       The manifest is the right place for a human label and the core has
       been asked for one (`popis` on an input; see the report).  Until it
       arrives the panel derives a readable phrase by RULE, not per tool:
       underscores become spaces and a trailing unit becomes a real unit in
       brackets.  The key itself stays reachable in the tooltip, because the
       owner sometimes needs to know exactly which argument this is. */
    var INPUT_UNIT = {m: 'm', cm: 'cm', mm: 'mm', km: 'km', s: 's', ms: 'ms',
                      min: 'min', h: 'h', hz: 'Hz', px: 'px', deg: '°',
                      pct: '%', kb: 'kB', mb: 'MB'};
    function toolInputLabel(v) {
      // a label the core wrote always wins, in the core's own words
      if (v.popis) { return String(v.popis); }
      if (v.nazev) { return String(v.nazev); }
      if (v.label) { return String(v.label); }
      var parts = String(v.jmeno == null ? '' : v.jmeno).split('_');
      var unit = parts.length > 1
        ? INPUT_UNIT[parts[parts.length - 1].toLowerCase()] : null;
      if (unit) { parts.pop(); }
      var words = parts.join(' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
      return (words || String(v.jmeno || '?')) + (unit ? ' (' + unit + ')' : '');
    }

    /* vstupy -> widget.  Five types, five widgets, nothing per tool. */
    function toolInput(t, v) {
      var wrap = el('label', 'tl-in');
      var lab = el('span', 'tl-inl', toolInputLabel(v));
      lab.title = 'argument `' + String(v.jmeno) + '`' +
        (v.popis || v.nazev || v.label ? ' — named by the core'
                                       : ' — the manifest carries no label ' +
                                         'for it yet, so this name is derived ' +
                                         'from the key');
      wrap.appendChild(lab);
      var typ = String(v.typ || 'text');
      var node;
      if (typ === 'ano_ne') {
        node = el('input'); node.type = 'checkbox';
        node.checked = !!toolArg(t.id, v.jmeno, !!v.vychozi);
        node.addEventListener('change', function () {
          toolsArgs[t.id][v.jmeno] = node.checked;
        });
      } else if (typ === 'cislo') {
        node = el('input'); node.type = 'number';
        node.value = toolArg(t.id, v.jmeno, v.vychozi == null ? '' : v.vychozi);
        node.addEventListener('input', function () {
          toolsArgs[t.id][v.jmeno] = node.value === '' ? null : Number(node.value);
        });
      } else if (typ === 'vyber') {
        node = el('select');
        (v.z || []).forEach(function (o) {
          var op = el('option', null, String(o)); op.value = String(o);
          node.appendChild(op);
        });
        node.value = String(toolArg(t.id, v.jmeno, v.vychozi));
        node.addEventListener('change', function () {
          toolsArgs[t.id][v.jmeno] = node.value;
        });
      } else if (typ === 'vyber_vice') {
        // chips: a multi-select box on a phone is a trap, chips are not
        node = el('div', 'tl-chips');
        var chosen = toolArg(t.id, v.jmeno,
          Array.isArray(v.vychozi) ? v.vychozi.slice() : []);
        (v.z || []).forEach(function (o) {
          var on = chosen.indexOf(o) >= 0;
          var c = el('button', 'vagent-fchip' + (on ? ' on' : ''), String(o));
          c.type = 'button';
          c.addEventListener('click', function () {
            var cur = toolsArgs[t.id][v.jmeno];
            var i = cur.indexOf(o);
            if (i >= 0) { cur.splice(i, 1); c.classList.remove('on'); }
            else { cur.push(o); c.classList.add('on'); }
          });
          node.appendChild(c);
        });
      } else {
        node = el('input'); node.type = 'text';
        node.value = toolArg(t.id, v.jmeno, v.vychozi == null ? '' : v.vychozi);
        node.addEventListener('input', function () {
          toolsArgs[t.id][v.jmeno] = node.value;
        });
      }
      node.className = (node.className ? node.className + ' ' : '') + 'tl-inf';
      wrap.appendChild(node);
      return wrap;
    }

    /* vystup -> renderer.  Five kinds, five renderers. */
    function toolResult(t, res) {
      var box = el('div', 'tl-res');
      if (!res) { return box; }
      if (res.ok === false || res.error) {
        // the core writes its refusals as finished Czech sentences, for the
        // owner to read — printed word for word, never summarised
        var er = el('div', 'tl-err', String(res.error || 'the tool failed'));
        box.appendChild(er);
        return box;
      }
      var kind = String(res.kind || t.vystup || 'text');
      if (kind === 'obrazek') {
        if (res.data_uri) {
          var img = el('img', 'tl-img');
          img.src = res.data_uri;
          img.alt = t.nazev || t.id;
          img.addEventListener('click', function () {
            var w = window.open('', '_blank', 'noopener');
            if (w) { w.document.write('<img src="' + res.data_uri + '">'); }
          });
          box.appendChild(img);
        } else {
          box.appendChild(el('div', 'vagent-empty',
            'the picture is too big to send inline — the core kept it on disk'));
        }
        // HOW OLD IT IS, always, next to the picture — and it has to TICK.
        // U40: this chip used to rebuild the capture moment out of the length
        // the core sent, as if the answer had arrived this instant, so it
        // froze on „taken 0 s ago" over a picture two minutes old.  The
        // moment now comes from when the answer really landed (`__at`) and
        // the chip re-reads the clock every second.
        var age = el('div', 'tl-age');
        var ageS = (res.age_s == null) ? null : Number(res.age_s);
        var at = capturedAt(res, ageS);
        var chip = ageChip(at, {
          pre: 'taken ', post: ' ago', warnS: 120,
          title: 'Taken ' + (fmtAbs(at) || '?') + '. The core measured ' +
                 ageS + ' s between the capture and its answer; the rest of ' +
                 'this number is time that has passed since.'
        });
        chip.setAttribute('data-src', 'derived: /api/v2/tools/*/run#age_s + time since __at');
        age.appendChild(chip);
        if (res.cache) {
          var ch = el('span', 'tl-s', res.cache === 'hit'
            ? 'not redrawn — nothing had changed' : 'drawn now');
          ch.title = 'cache: ' + res.cache;
          age.appendChild(ch);
        }
        if (res.render_s) {
          age.appendChild(el('span', 'tl-s',
            'took ' + Number(res.render_s).toFixed(1) + ' s of the robot'));
        }
        box.appendChild(age);
      } else if (kind === 'tabulka') {
        var cols = res.sloupce || [], rows = res.radky || [];
        var scroll = el('div', 'tl-tablewrap');
        var tb = el('table', 'tl-table');
        if (cols.length) {
          var tr = el('tr');
          cols.forEach(function (c) { tr.appendChild(el('th', null, String(c))); });
          tb.appendChild(tr);
        }
        rows.forEach(function (r) {
          var tr2 = el('tr');
          (r || []).forEach(function (c) {
            tr2.appendChild(el('td', null, c == null ? '—' : String(c)));
          });
          tb.appendChild(tr2);
        });
        scroll.appendChild(tb);
        box.appendChild(scroll);
      } else if (kind === 'cislo') {
        var val = (res.value == null) ? res.cislo : res.value;
        box.appendChild(el('div', 'tl-num', val == null ? '—' : String(val)));
      } else if (kind === 'vrstva_do_mapy') {
        box.appendChild(el('div', 'vagent-empty',
          'this tool draws into the map, and the panel cannot put it there ' +
          'yet — the numbers it returned are below'));
        box.appendChild(el('pre', 'tl-pre', fp(res)));
      } else {
        box.appendChild(el('div', 'tl-text', String(res.text || res.value || '')));
      }
      // the core's own sentence about the result — carries the age and the
      // difference between EMPTY (read, nothing there) and UNREADABLE
      var caption = res.summary ||
        (kind !== 'text' && res.text ? res.text : '');
      if (caption) { box.appendChild(el('div', 'tl-sum', String(caption))); }
      return box;
    }

    function runTool(VA, t) {
      if (toolsBusy[t.id]) { return; }
      toolsBusy[t.id] = true;
      /* `force`, and it matters: drawTools() otherwise defers while the box
         is under the cursor (interacting() counts :hover), and after a click
         on Run the cursor IS on the card — so the answer to the owner's own
         click would never be drawn.  The deferral exists to protect what he
         is doing; this IS what he is doing. */
      drawTools(VA, true);
      VA.api('/api/v2/tools/' + encodeURIComponent(t.id) + '/run',
             {body: {args: toolsArgs[t.id] || {}}, timeout_ms: 60000,
              keep_error_body: true})
        .then(function (d) { toolsResult[t.id] = d || {ok: false, error: 'no answer'}; })
        .catch(function (e) {
          var body = e && e.body;
          toolsResult[t.id] = {ok: false,
            error: (body && (body.error || body.problems)) || String(e)};
        })
        .then(function () { toolsBusy[t.id] = false; drawTools(VA, true); });
    }

    function drawTools(VA, force) {
      if (!toolsBox) { return; }
      tickAges();
      if (!force && interacting(toolsBox)) {
        whenIdle('tools', toolsBox, function () { drawTools(VA); });
        return;
      }
      toolsBox.textContent = '';
      if (toolsState === 'unsupported') {
        toolsBox.appendChild(el('div', 'vagent-empty',
          'This robot’s agent does not serve the tool manifests yet ' +
          '(GET /api/v2/tools). The tools exist and the core knows how to ' +
          'run them; the process that is running was started before they ' +
          'landed, so there is nothing to draw here until it is restarted.'));
        return;
      }
      if (toolsState === 'down') {
        apiUnavailable(toolsBox, 'tools', 'down');
        return;
      }
      if (!toolsData) {
        toolsBox.appendChild(el('div', 'vagent-empty', 'Reading the tools…'));
        return;
      }
      // a broken manifest must not take the others down with it
      (toolsData.problems || []).forEach(function (p) {
        var w = el('div', 'tl-problem', String(p));
        toolsBox.appendChild(w);
      });
      var list = toolsData.tools || [];
      if (!list.length) {
        toolsBox.appendChild(el('div', 'vagent-empty', 'No tool has a manifest yet.'));
        return;
      }
      list.forEach(function (t) {
        var card = el('details', 'tl-card');
        card.open = lsGet('vitulus_agent_tool_' + t.id) === '1';
        card.addEventListener('toggle', function () {
          lsSet('vitulus_agent_tool_' + t.id, card.open ? '1' : '0');
        });
        var sum = el('summary');
        sum.appendChild(el('span', 'tl-name', t.nazev || t.id));
        sum.appendChild(el('span', 'vagent-pill queued',
          TOOL_KIND_EN[t.druh] || t.druh || '?'));
        var tp = el('span', 'vagent-pill ' + (t.touches === 'read' ? 'done' : 'failed'),
                    TOOL_TOUCH_EN[t.touches] || t.touches || '?');
        tp.title = t.touches === 'read'
          ? 'Reading only — it cannot move anything, so it needs no permission.'
          : 'This one touches the machine. It is not run from here: it goes ' +
            'through the gate and the dock lock, which only the owner opens.';
        sum.appendChild(tp);
        // the account is what tells a live tool from a dead one
        var acc = t.ucet || null;
        var ab = el('span', 'tl-acc');
        if (!acc || !acc.runs) {
          ab.textContent = 'never run';
          ab.title = 'No run recorded — nobody knows whether it still works.';
          ab.className += ' cold';
        } else {
          ab.textContent = acc.runs + ' run' + (acc.runs === 1 ? '' : 's') +
            (acc.failed ? ' · ' + acc.failed + ' failed' : '');
          if (acc.failed) { ab.className += ' bad'; }
          ab.title = 'last success ' + (acc.last_ok ? fmtAgo(acc.last_ok) + ' ago' : 'never') +
            (acc.last_fail ? ' · last failure ' + fmtAgo(acc.last_fail) + ' ago' : '');
        }
        sum.appendChild(ab);
        card.appendChild(sum);

        var body = el('div', 'tl-body');
        if (t.popis) { body.appendChild(el('div', 'tl-desc', String(t.popis))); }

        var meta = el('div', 'tl-meta');
        meta.appendChild(el('span', 'tl-s', TOOL_AUTHOR_EN[t.autor] || t.autor || ''));
        if (t.test) {
          var te = el('span', 'tl-s', 'has a test');
          te.title = t.test;
          meta.appendChild(te);
        } else {
          var nt = el('span', 'tl-s cold', 'no test');
          nt.title = 'The manifest names no test — nothing would notice if it broke.';
          meta.appendChild(nt);
        }
        body.appendChild(meta);

        if ((t.vstupy || []).length) {
          var form = el('div', 'tl-form');
          t.vstupy.forEach(function (v) { form.appendChild(toolInput(t, v)); });
          body.appendChild(form);
        }

        var bar = el('div', 'tl-bar');
        if (t.runnable) {
          var run = el('button', 'vagent-fchip tl-run',
                       toolsBusy[t.id] ? 'Running…' : 'Run');
          run.type = 'button';
          run.disabled = !!toolsBusy[t.id];
          run.addEventListener('click', function () { runTool(VA, t); });
          bar.appendChild(run);
          bar.appendChild(el('span', 'tl-s', 'runs on a click — never on its own'));
        } else {
          var no = el('span', 'tl-s cold',
            'not run from here — it touches the machine, so it goes through ' +
            'the gate and the dock lock');
          bar.appendChild(no);
        }
        body.appendChild(bar);
        if (toolsResult[t.id]) { body.appendChild(toolResult(t, toolsResult[t.id])); }
        card.appendChild(body);
        toolsBox.appendChild(card);
      });
    }

    /* ======================================================= parked work
       „Práce stojí na tobě" was a sentence with no next step in the panel.
       The core parks work in `waiting` with a reason (`awaiting.why`) and
       the ONLY ways out were `agent_v2 resume|cancel|budget` in a terminal —
       which the owner does not have on a phone. #14822 and #14826 sat
       BLOCKED overnight on 2026-09-01 and were cancelled wholesale in the
       morning; that is what a missing button looks like.

       The card does not decide anything itself. Which ways out make sense
       for a given row is computed by the core and shipped as `ways[]`
       (webapi._ways_for), so the rule lives in one place; this block draws
       the buttons it was handed and prints whatever the core answers. */
    var parkedBox = null, parkedData = null, parkedFp = '', parkedBusy = {};
    /* `summaryExtra` is a DOM node (see `badge()` and the mission/incidents
       blocks), NOT a function. A function here made `appendChild` throw at
       agent_chat.js:809 and took the WHOLE panel down — chat included
       (2026-09-02 13:25, „z panelu zmizelo skoro vše"). The count is written
       into the node after each poll. */
    var parkedBadgeEl = badge();

    function parkedBadge() {
      var n = (parkedData && parkedData.approvals || []).length;
      parkedBadgeEl.textContent = n ? String(n) : '';
    }

    VA.registerBlock({
      id: 'parked', title: 'Needs you', order: 15, summaryExtra: parkedBadgeEl,
      render: function (root) { parkedBox = el('div', 'vpk'); root.appendChild(parkedBox); },
      poll: { every_ms: 15000, fn: function () { pollParked(VA); } },
      onOpen: function () { pollParked(VA); }
    });

    function pollParked(VA) {
      if (!parkedBox) return;
      VA.api('/api/v2/approvals', {timeout_ms: 12000}).then(function (d) {
        if (!d || d.ok === false) {
          if (d && d.agent_down) return;
          errLine(parkedBox, 'parked work: ' + ((d && d.error) || 'unavailable'));
          return;
        }
        var sig = fp(d);
        if (sig === parkedFp) return;
        if (interacting(parkedBox)) { whenIdle('parked', parkedBox, function () { pollParked(VA); }); return; }
        parkedFp = sig; parkedData = d; parkedBadge();
        drawParked(VA);
      }).catch(function (e) { apiUnavailable(parkedBox, 'parked work', e); });
    }

    /* English in the UI (owner, 2026-08-24) — but `why` is the core's own
       Czech sentence and is QUOTED, never translated: it is evidence. */
    var PARKED_WHAT = {
      blocked: 'blocked — needs your decision',
      budget: 'out of budget',
      deadline: 'out of time',
      tests: 'acceptance tests failed',
      verdict: 'the judge could not decide',
      no_judge: 'no judge available',
      approval: 'waiting for your approval'
    };

    function parkedAct(VA, item, way, card) {
      var key = item.id + ':' + way.action;
      if (parkedBusy[key]) return;
      parkedBusy[key] = 1;
      var body = {author: 'panel'};
      if (way.action === 'budget') { body.usd = way.suggest_usd; }
      if (way.action === 'touches') { body.touches = way.touches || 'code'; }
      var out = el('div', 'vpk-out', '…');
      card.appendChild(out);
      VA.api('/api/v2/jobs/' + item.id + '/' + way.action,
             {method: 'POST', body: body, keep_error_body: true, timeout_ms: 15000})
        .then(function (r) {
          delete parkedBusy[key];
          out.textContent = (r && r.message) || (r && r.error) || 'done';
          parkedFp = '';                       // force a redraw from the core
          pollParked(VA);
        })
        .catch(function (err) {
          delete parkedBusy[key];
          out.className = 'vpk-out bad';
          out.textContent = (err && err.body && err.body.error)
            || (err && err.status ? 'refused (HTTP ' + err.status + ')' : 'agent unreachable');
        });
    }

    function drawParked(VA) {
      if (!parkedBox) return;
      parkedBox.textContent = '';
      var list = (parkedData && parkedData.approvals) || [];
      if (!list.length) {
        parkedBox.appendChild(el('div', 'vpk-none', 'Nothing is waiting on you.'));
        return;
      }
      list.forEach(function (item) {
        var card = el('div', 'vpk-card w-' + (item.what || 'other'));
        var head = el('div', 'vpk-head');
        head.appendChild(el('span', 'vpk-id', '#' + item.id));
        head.appendChild(el('span', 'vpk-what',
          PARKED_WHAT[item.what] || String(item.what || 'parked')));
        if (item.since) {
          var since = el('span', 'vpk-age', fmtAgo(item.since));
          since.title = fmtAbs(item.since);
          head.appendChild(since);
        }
        card.appendChild(head);
        card.appendChild(el('div', 'vpk-title', String(item.title || '')));
        /* The reason is the whole point of the card: without it the owner is
           asked to decide something they cannot see. */
        if (item.why) {
          var why = el('div', 'vpk-why');
          why.textContent = String(item.why);
          why.style.whiteSpace = 'pre-wrap';
          card.appendChild(why);
        }
        if (item.cost_usd) {
          card.appendChild(el('div', 'vpk-cost',
            'spent ' + Number(item.cost_usd).toFixed(2) + ' USD'
            + (item.budget_usd ? ' of ' + Number(item.budget_usd).toFixed(2) : '')
            + ' — cancelling does not get it back'));
        }
        var bar = el('div', 'vpk-btns');
        (item.ways || []).forEach(function (way) {
          var b = el('button', 'vagent-actbtn ' + (way.action === 'cancel' ? 'deny' : 'approve'),
                     way.label || way.action);
          b.type = 'button';
          b.title = way.hint || '';
          b.addEventListener('click', function () { parkedAct(VA, item, way, card); });
          bar.appendChild(b);
        });
        card.appendChild(bar);
        parkedBox.appendChild(card);
      });
    }
  }
})();
