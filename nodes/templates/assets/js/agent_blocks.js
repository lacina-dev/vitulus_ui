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

  var AGENT_HTTP = 'http://' + location.hostname + ':8088';

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
    var v = el('span', null, value == null ? '—' : String(value));
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
      what + ': ' + (/HTTP 404/.test(String(err)) ? 'API not available yet' : 'agent (:8088) not responding'));
    box.textContent = '';
    box.appendChild(e);
  }

  function register(VA) {

    // ---- blok: Robot ------------------------------------------------------
    var robotBox, robotImg, robotImgStamp = 0, robotImgNote;
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
        wrap.appendChild(robotImg); wrap.appendChild(robotImgNote);
        root.appendChild(wrap);
      },
      poll: { every_ms: 5000, fn: function () { drawRobot(VA); pollMapview(VA); } },
      onOpen: function () { drawRobot(VA); robotImgStamp = 0; pollMapview(VA); }
    });

    function drawRobot(VA) {
      var st = (VA.state && (VA.state.robot || VA.state.state)) || null;
      if (!robotBox) return;
      if (!st) { errLine(robotBox, 'robot state unavailable'); return; }
      robotBox.textContent = '';
      var age = VA.state.age_s != null ? VA.state.age_s : null;
      robotBox.appendChild(row('Battery', st.battery_pct != null ? st.battery_pct + ' %' : null));
      robotBox.appendChild(row('In dock', st.in_dock === true ? 'yes' : st.in_dock === false ? 'no' : null));
      var rtk = st.rtk && typeof st.rtk === 'object'
        ? (st.rtk.fix || '?') + (st.rtk.sats != null ? ' (' + st.rtk.sats + ' sat)' : '')
        : st.rtk;
      robotBox.appendChild(row('RTK', rtk || null));
      robotBox.appendChild(row('Motors', st.motor_power === true ? 'on' : st.motor_power === false ? 'off' : null));
      if (st.mower && st.mower.moto_rpm != null) robotBox.appendChild(row('Mower (RPM)', st.mower.moto_rpm));
      if (st.battery_pct != null && st.charger) robotBox.appendChild(row('Charging', st.charger));
      if (st.map || st.active_map) robotBox.appendChild(row('Map', st.map || st.active_map));
      var rain = st.rain != null ? st.rain : (st.rain_alert ? st.rain_alert.alert : null);
      if (rain != null) robotBox.appendChild(row('Rain', rain ? 'reported' : 'no'));
      if (age != null) robotBox.appendChild(row('Measured', Math.round(age) + ' s ago'));
    }

    var mapviewBusy = false, mapviewLast = 0;
    function pollMapview(VA) {
      if (mapviewBusy || !robotImg) return;
      var now = Date.now();
      if (now - mapviewLast < 15000) return;   // 15 s, nezávisle na 5 s tiku
      mapviewLast = now; mapviewBusy = true;
      VA.api('/api/mapview').then(function (data) {
        mapviewBusy = false;
        if (!data || !data.ok || !data.url) {
          robotImg.style.display = 'none';
          robotImgNote.textContent = (data && data.error) ? 'map: ' + data.error : '';
          return;
        }
        robotImg.src = AGENT_HTTP + data.url;
        robotImg.style.display = '';
        robotImgNote.textContent = 'layers: ' + (data.layers || []).join(', ');
      }).catch(function () { mapviewBusy = false; });
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
    function incidentsTabActive() {
      var t = document.querySelector('.vagent-tab[data-tab="incidents"]');
      return !!(t && t.classList.contains('active') && VA.isVisible && VA.isVisible());
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
                        selfcare.last_repair, doctorFilter, showResolved]);
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
        var c = el('button', 'vagent-fchip' + (doctorFilter === g ? ' on' : ''),
          (g === 'all' ? 'all' : GROUP[g].label) + ' ' + counts[g]);
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
            tx.addEventListener('click', function () { tx.classList.toggle('full'); });
            line.appendChild(tx);
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
            VA.api('/api/approvals/decide',
              { method: 'POST', body: { id: plan.approval_id, decision: decision,
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
              .catch(function () { btn.disabled = false; });
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
      var tools = data.tools || [], skills = data.skills || [], growth = data.growth || [];
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
  }
})();
