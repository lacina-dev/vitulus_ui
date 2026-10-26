/* vt_camera_settings.js — Settings › Camera: everything about the D435.
 *
 *   Camera          model, serial, firmware, USB, stream rates
 *   Depth accuracy  depth - lidar at 1 / 2 / 3 m (Check), the calibration
 *                   wizard (Calibrate…), history, restore / factory
 *   Sensor          emitter, laser power, auto exposure, white balance —
 *                   remembered on the robot, applied whenever the camera starts
 *   Image layers    the camera overlays (same as the menu on the image)
 *
 * The robot does the work: node vitulus_ui/camera_calib.
 *   /camera_calib/status  std_msgs/String JSON (latched) — subscribed only
 *                         while this tab is on screen
 *   /camera_calib/cmd     std_msgs/String JSON {cmd: check | watch | calibrate |
 *                         cancel | restore | factory | set | reset_settings | refresh}
 *
 * Wizard (inside the Depth accuracy card, no modal): 1 prepare the scene
 * (instructions, live snapshot with the calibration area, live checklist from
 * status.scene) → 2 progress → 3 result. Step 1 keeps {cmd: watch} alive every
 * 20 s; leaving it sends watch off. Nothing here moves the robot.
 */
(function () {
    'use strict';
    var I = window.VTI18n;
    function t(k, v) { return I ? I.t(k, v) : k; }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }
    function btn(cls, key, fn) {
        var b = el('button', 'btn btn-sm ' + cls, t(key));
        b.type = 'button';
        b.addEventListener('click', fn);
        return b;
    }

    var CANCELLABLE = ['check', 'scene', 'before', 'pause', 'measure', 'onchip', 'tare'];
    var LAYERS = [['scan', 'cam.layer.scan'], ['obstacles', 'cam.layer.obstacles'],
        ['free', 'cam.layer.free'], ['rest', 'cam.layer.rest'], ['depth', 'cam.layer.depth']];

    var host = null, pane = null, st = null, rosRef = null, sub = null, pubT = null;
    var shown = false, wiz = null, snapTimer = 0, watchTimer = 0, armed = {};
    var parts = {};

    /* ------------------------------------------------------------ ROS */
    function rosOf() { return (window.ros && window.ros.ros) || null; }
    function ensure() {
        var r = rosOf();
        if (!r || !window.ROSLIB) { return false; }
        if (r !== rosRef) {
            unsub();
            rosRef = r;
            pubT = new ROSLIB.Topic({ ros: r, name: '/camera_calib/cmd', messageType: 'std_msgs/String' });
        }
        return true;
    }
    function send(obj) {
        if (!ensure()) { return; }
        pubT.publish(new ROSLIB.Message({ data: JSON.stringify(obj) }));
    }
    var lastRx = 0;
    function onStatus(m) {
        lastRx = Date.now();
        try { st = JSON.parse(m.data); } catch (e) { return; }
        update();
    }
    /* our listener only: unsubscribe() without it would drop every listener
       of the topic in this page */
    function unsub() {
        if (sub) { try { sub.unsubscribe(onStatus); } catch (e) {} }
        sub = null;
    }
    function subscribe(on) {
        if (on) {
            if (!ensure() || sub) { return; }
            sub = new ROSLIB.Topic({ ros: rosRef, name: '/camera_calib/status',
                messageType: 'std_msgs/String', throttle_rate: 250, queue_length: 1 });
            sub.subscribe(onStatus);
            lastRx = Date.now();
            send({ cmd: 'refresh' });
        } else {
            unsub();
        }
    }

    /* ------------------------------------------------------------ helpers */
    function cm(m) {
        if (m === null || m === undefined || !isFinite(m)) { return '—'; }
        var v = m * 100;
        return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0) + ' cm';
    }
    function when(ts) {
        if (!ts) { return '—'; }
        var d = new Date(ts * 1000);
        try { return d.toLocaleString(I ? I.lang() : undefined, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return d.toLocaleString(); }
    }
    function model(name) {
        if (!name) { return '—'; }
        return name.replace(/^intel_realsense_/i, 'Intel RealSense ').replace(/_/g, ' ').replace(/d(\d+)/i, 'D$1');
    }
    function running() { return !!(st && st.state && st.state !== 'idle'); }
    function verdictState(v) { return { ok: 'ok', limited: 'info', warn: 'warn', bad: 'err' }[v] || 'off'; }
    function reasonText(r, sc) {
        var a = { dist: sc && sc.dist !== undefined ? sc.dist.toFixed(2) : '?',
            angle: sc && sc.angle !== undefined ? Math.round(sc.angle) : '?',
            fill: sc && sc.fill !== undefined ? Math.round(sc.fill * 100) : '?' };
        return t('calib.reason.' + r, a);
    }
    function msgText(key, args) {
        if (!key) { return ''; }
        args = args || {};
        var a = {};
        Object.keys(args).forEach(function (k) { a[k] = args[k]; });
        if (Array.isArray(args.reasons)) { a.reasons = args.reasons.map(function (r) { return t('calib.reason_short.' + r); }).join(', '); }
        if (Array.isArray(args.problems)) { a.problems = args.problems.map(function (r) { return t('calib.pre_short.' + r); }).join(', '); }
        var out = t(key, a);
        // never a raw key (a page loaded before an update may lack a text)
        return out === key ? t('calib.msg.unknown_key', { key: key }) : out;
    }
    /* an error / result of a job: what happened, where the camera is, whether
       anything was written, the raw detail small (never the only text) */
    function errorBlock(key, args) {
        args = args || {};
        var box = el('div', 'vt-cam-err');
        box.appendChild(el('div', 'vt-warn-text', msgText(key, args)));
        if (args.cam) {
            box.appendChild(el('div', args.cam === 'back' ? 'vt-ok-text' : 'vt-err-text',
                t(args.cam === 'back' ? 'calib.cam.back' : 'calib.cam.off')));
        }
        if (args.written !== undefined) {
            box.appendChild(el('div', 'vt-app-hint', t(args.written ? 'calib.cam.written' : 'calib.cam.not_written')));
        }
        if (args.e) { box.appendChild(el('div', 'vt-cam-detail', t('calib.detail') + ': ' + args.e)); }
        if (args.v4l_cmd) {
            box.appendChild(el('div', 'vt-cam-detail', t('calib.v4l.cause.' + args.v4l_cause) + ' ' + t('calib.v4l.fix')));
            box.appendChild(el('code', 'vt-cam-cmd', args.v4l_cmd));
        }
        return box;
    }
    /* the verified steps of the running / last job (status.steps) */
    var STEP_ICON = { wait: 'la-circle', run: 'la-spinner la-spin', ok: 'la-check', err: 'la-close', skip: 'la-minus' };
    function stepsEl() {
        var list = el('ol', 'vt-cam-steps');
        ((st && st.steps) || []).forEach(function (s) {
            var li = el('li', 'vt-cam-st-' + s.s);
            li.appendChild(el('i', 'la ' + (STEP_ICON[s.s] || 'la-circle')));
            var tx = el('span', 'vt-grow', t('calib.step.' + s.id));
            li.appendChild(tx);
            var det = [];
            if (s.s === 'run' && s.id === 'sdk' && st.phase) { det.push(t('calib.ph.' + st.phase)); }
            if (s.nodes !== undefined && s.s === 'ok') { det.push(t('calib.stepd.nodes', { n: s.nodes })); }
            if (s.reset) { det.push(t('calib.stepd.reset')); }
            if (s.onchip && s.s !== 'run') {
                det.push(t(s.onchip === 'used' ? 'calib.stepd.onchip_used' : s.onchip === 'skip' ? 'calib.stepd.onchip_skip'
                    : 'calib.stepd.onchip_failed', { h: s.h !== undefined && s.h !== null ? s.h : '—' }));
            }
            if (s.tare && s.s !== 'run') {
                var tk = { here: 'calib.stepd.tare_done', done: 'calib.stepd.tare_done', skip: 'calib.stepd.tare_skip',
                    next: 'calib.stepd.tare_next', nochange: 'calib.stepd.tare_nochange', failed: 'calib.stepd.tare_failed' }[s.tare];
                if (tk) { det.push(t(tk, { e: s.e !== undefined ? s.e : '—' })); }
            }
            if (s.readback === 'ok') { det.push(t('calib.stepd.readback_ok')); }
            if (s.hz !== undefined && s.s === 'ok') { det.push(s.hz + ' Hz'); }
            if (s.s === 'err' && s.d) { det.push(msgText(s.d, s.a)); }
            if (det.length) { li.appendChild(el('span', 'vt-cam-stepd', det.join(' · '))); }
            if (s.dt !== undefined && s.s !== 'run') { li.appendChild(el('span', 'vt-cam-dt', s.dt.toFixed(1) + ' s')); }
            list.appendChild(li);
        });
        return list;
    }
    /* two clicks within 4 s confirm (Restore / Factory) */
    function confirmBtn(cls, key, id, fn) {
        var b = btn(cls, armed[id] ? 'calib.confirm' : key, function () {
            if (armed[id] && Date.now() - armed[id] < 4000) { delete armed[id]; fn(); }
            else { armed[id] = Date.now(); setTimeout(function () { delete armed[id]; update(); }, 4100); }
            update();
        });
        return b;
    }

    /* ------------------------------------------------------------ skeleton */
    function card(id, titleKey) {
        var c = el('div', 'vt-card vt-cam-card');
        c.setAttribute('data-card', id);
        var head = el('div', 'vt-card-head');
        head.appendChild(el('span', 'vt-card-title', t(titleKey)));
        var end = el('span', 'vt-end');
        head.appendChild(end);
        var body = el('div', 'vt-cam-body');
        c.appendChild(head);
        c.appendChild(body);
        return { card: c, end: end, body: body };
    }
    function build() {
        if (!host) { return; }
        host.textContent = '';
        var stack = el('div', 'vt-stack');
        parts.dev = card('device', 'camset.dev.title');
        parts.acc = card('accuracy', 'camset.acc.title');
        parts.sen = card('sensor', 'camset.sen.title');
        parts.lay = card('layers', 'camset.lay.title');
        [parts.dev, parts.acc, parts.sen, parts.lay].forEach(function (p) { stack.appendChild(p.card); });
        var rec = el('div', 'vt-app-hint vt-cam-rec');
        rec.appendChild(el('span', null, t('camset.rec.hint') + ' '));
        var a = el('a', 'vt-link', t('camset.rec.open'));
        a.href = '#tab_rosbag';
        a.addEventListener('click', function (e) {
            e.preventDefault();
            var l = document.querySelector('a[href="#tab_rosbag"]');
            if (l) { l.click(); }
        });
        rec.appendChild(a);
        stack.appendChild(rec);
        host.appendChild(stack);
        parts.senBuilt = false;
        parts.wizStep = null;
        update();
    }

    /* ------------------------------------------------------------ cards */
    function kv(dl, key, val, cls) {
        dl.appendChild(el('dt', null, t(key)));
        var dd = el('dd', cls || null, val);
        dl.appendChild(dd);
        return dd;
    }
    function renderDevice() {
        var p = parts.dev, d = (st && st.device) || {}, s = (st && st.streams) || {}, sdk = (st && st.sdk) || {};
        var live = s.depth_hz > 0 && s.color_hz > 0;
        var paused = st && st.state === 'calibrating' && ['pause', 'measure', 'onchip', 'tare', 'write', 'revert'].indexOf(st.phase) >= 0;
        p.card.setAttribute('data-state', !st ? 'off' : paused ? 'info' : live ? (sdk.ok === false ? 'warn' : 'ok') : 'err');
        p.end.textContent = !st ? t('camset.dev.no_node') : paused ? t('camset.dev.paused') : live ? t('camset.dev.live') : t('camset.dev.no_stream');
        p.body.textContent = '';
        if (!st) { p.body.appendChild(el('div', 'vt-app-hint', t('camset.dev.no_node_hint'))); return; }
        var dl = el('dl', 'vt-kv vt-kv-2');
        kv(dl, 'camset.dev.model', model(d.name));
        kv(dl, 'camset.dev.serial', d.serial || '—');
        kv(dl, 'camset.dev.fw', d.fw || '—');
        kv(dl, 'camset.dev.usb', d.usb || '—');
        kv(dl, 'camset.dev.depth', s.depth_hz ? s.depth_hz + ' Hz' : '—');
        kv(dl, 'camset.dev.color', s.color_hz ? s.color_hz + ' Hz' : '—');
        kv(dl, 'camset.dev.sdk', sdk.version ? sdk.version + (sdk.required && sdk.required !== sdk.version ? ' ≠ ' + sdk.required : '') : '—');
        p.body.appendChild(dl);
        if (sdk.installing) { p.body.appendChild(el('div', 'vt-app-hint', t('calib.sdk.installing'))); }
        else if (sdk.ok === false) { p.body.appendChild(el('div', 'vt-app-hint vt-warn-text', t('camset.dev.no_sdk'))); }
    }

    function renderAccuracy() {
        var p = parts.acc, c = st && st.check;
        if (wiz) { renderWizard(); return; }
        parts.wizStep = null;
        p.card.setAttribute('data-state', c ? verdictState(c.v) : 'off');
        p.end.textContent = c ? t('calib.verdict.' + c.v) : t('calib.verdict.none');
        p.body.textContent = '';
        var dl = el('dl', 'vt-kv vt-kv-2');
        kv(dl, 'calib.at1', c ? cm(c.b1) : '—');
        kv(dl, 'calib.at2', c ? cm(c.b2) : '—');
        kv(dl, 'calib.at3', c ? cm(c.b3) : '—');
        kv(dl, 'calib.checked', c ? when(c.t) : '—');
        p.body.appendChild(dl);
        if (c) {
            p.body.appendChild(el('div', 'vt-app-hint', t('calib.measured_on', { n: c.n, a: c.z_min.toFixed(1), b: c.z_max.toFixed(1) })));
            if (c.v === 'limited') { p.body.appendChild(el('div', 'vt-app-hint', t('calib.limited_hint'))); }
            if (c.v === 'warn' || c.v === 'bad') { p.body.appendChild(el('div', 'vt-app-hint', t('calib.advice'))); }
        } else {
            p.body.appendChild(el('div', 'vt-app-hint', t('calib.intro')));
        }
        if (st && st.state === 'checking') {
            p.body.appendChild(el('div', 'vt-app-hint vt-cam-busy', t('calib.msg.checking')));
        } else if (st && st.state === 'calibrating') {
            // restore / factory / handover test / camera restore (here or from the agent)
            p.body.appendChild(el('div', 'vt-cam-busy', t('calib.job.' + (st.job || 'calibrate'))));
            p.body.appendChild(stepsEl());
        } else if (st && st.msg && st.phase === 'done' && /^calib\.(err|msg\.no_pairs|msg\.cancelled)/.test(st.msg)) {
            p.body.appendChild(errorBlock(st.msg, st.msg_args));
            if (st.steps && st.steps.length) { p.body.appendChild(stepsEl()); }
        } else if (st && st.phase === 'done' && /^calib\.(res\.dry_ok|res\.already_ok|res\.write_test_ok|msg\.recovered|res\.factory|res\.restored)$/.test(st.msg)) {
            p.body.appendChild(el('div', 'vt-app-hint vt-ok-text', msgText(st.msg, st.msg_args)));
        }
        var row = el('div', 'vt-row vt-card-actions vt-cam-actions');
        var bc = btn('btn-primary', 'calib.btn.check', function () { send({ cmd: 'check' }); });
        var bk = btn('btn-outline-info', 'calib.btn.calibrate', function () { openWizard(); });
        bc.disabled = bk.disabled = !st || running();
        if (st && st.sdk && st.sdk.ok === false) { bk.disabled = true; }
        row.appendChild(bc); row.appendChild(bk);
        p.body.appendChild(row);

        var det = el('details', 'vt-cam-adv');
        if (parts.advOpen) { det.open = true; }
        det.addEventListener('toggle', function () { parts.advOpen = det.open; });
        det.appendChild(el('summary', 'vt-fs-sm vt-pointer', t('calib.adv')));
        var dl2 = el('dl', 'vt-kv');
        kv(dl2, 'calib.disp', c && c.disp_px !== undefined ? c.disp_px.toFixed(2) + ' px' : '—');
        kv(dl2, 'calib.k', c ? c.k.toFixed(4) + ' m⁻¹' : '—');
        det.appendChild(dl2);
        var hist = (st && st.history) || [];
        if (hist.length) {
            det.appendChild(el('span', 'vt-label', t('calib.history')));
            var ul = el('ul', 'vt-cam-hist');
            hist.slice(0, 5).forEach(function (h) {
                var li = el('li', h.saved ? 'vt-ok-text' : 'vt-muted');
                var tx = when(h.t) + ' · ' + t(h.result || 'calib.res.unknown');
                if (h.b2_before !== null && h.b2_before !== undefined && h.b2_after !== null && h.b2_after !== undefined) {
                    tx += ' · ' + t('calib.hist_2m', { a: cm(h.b2_before), b: cm(h.b2_after) });
                }
                li.textContent = tx;
                ul.appendChild(li);
            });
            det.appendChild(ul);
        }
        var row2 = el('div', 'vt-row vt-card-actions vt-cam-actions');
        var br = confirmBtn('btn-outline-warning', 'calib.btn.restore', 'restore', function () { send({ cmd: 'restore' }); });
        var bf = confirmBtn('btn-outline-danger', 'calib.btn.factory', 'factory', function () { send({ cmd: 'factory' }); });
        br.disabled = !st || running() || !st.can_restore;
        bf.disabled = !st || running() || (st.sdk && st.sdk.ok === false);
        row2.appendChild(br); row2.appendChild(bf);
        det.appendChild(row2);
        var row3 = el('div', 'vt-row vt-card-actions vt-cam-actions');
        var bd = btn('btn-outline-secondary', 'calib.btn.dry', function () { send({ cmd: 'dry' }); });
        var bv = btn('btn-outline-secondary', 'calib.btn.recover', function () { send({ cmd: 'recover' }); });
        bd.disabled = !st || running() || (st.sdk && st.sdk.ok === false);
        bv.disabled = !st || running();
        bd.title = t('calib.btn.dry_tip');
        bv.title = t('calib.btn.recover_tip');
        row3.appendChild(bd); row3.appendChild(bv);
        det.appendChild(row3);
        det.appendChild(el('div', 'vt-app-hint', t('calib.adv_hint')));
        p.body.appendChild(det);
    }

    /* ------------------------------------------------------------ wizard */
    function openWizard() {
        wiz = { step: 1, gt: '', started: 0, sawRunning: false };
        parts.wizStep = null;
        update();
    }
    function closeWizard() {
        wiz = null;
        stopStep1();
        parts.wizStep = null;
        update();
    }
    function startStep1() {
        send({ cmd: 'watch', on: true });
        if (!watchTimer) { watchTimer = setInterval(function () { send({ cmd: 'watch', on: true }); }, 20000); }
        if (!snapTimer) { snapTimer = setInterval(snap, 700); }
        snap();
    }
    function stopStep1() {
        if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; send({ cmd: 'watch', on: false }); }
        if (snapTimer) { clearInterval(snapTimer); snapTimer = 0; }
    }
    function snap() {
        var img = parts.snap;
        if (!img || !shown || img._loading) { return; }
        var cv = window.camera_view, hostn = (cv && cv.host) || location.hostname, port = (cv && cv.port) || 8080;
        img._loading = true;
        var n = new Image();
        n.onload = function () { img.src = n.src; img._loading = false; img.parentNode && img.parentNode.classList.remove('vt-cam-nosig'); };
        n.onerror = function () { img._loading = false; img.parentNode && img.parentNode.classList.add('vt-cam-nosig'); };
        n.src = 'http://' + hostn + ':' + port + '/snapshot?topic=/d435/color/image_raw&quality=50&width=320&height=240&t=' + Date.now();
    }
    function sceneUsable(sc) {
        if (!sc) { return false; }
        if (sc.ok) { return true; }
        if (!wiz || !wiz.gt) { return false; }
        var lidarOnly = ['no_wall', 'angle', 'too_far', 'too_close'];
        return sc.reasons.every(function (r) { return lidarOnly.indexOf(r) >= 0; });
    }
    function gtValue() {
        var v = parseFloat(String(wiz.gt).replace(',', '.'));
        return isFinite(v) && v >= 0.3 && v <= 3 ? v : null;
    }
    function stepHead(n, key) {
        var h = el('div', 'vt-cam-step');
        h.appendChild(el('span', 'vt-cam-stepn', String(n)));
        h.appendChild(el('span', null, t(key)));
        return h;
    }
    function renderWizard() {
        var p = parts.acc;
        // step transitions from the robot's state
        if (wiz.step === 2) {
            if (running()) { wiz.sawRunning = true; }
            else if (st && (wiz.sawRunning || Date.now() - wiz.started > 4000)) { wiz.step = 3; }
        }
        p.card.setAttribute('data-state', wiz.step === 3 ? resultState() : 'info');
        p.end.textContent = t('calib.wiz.title');
        if (parts.wizStep !== wiz.step) {
            if (wiz.step !== 1) { stopStep1(); }
            parts.wizStep = wiz.step;
            p.body.textContent = '';
            if (wiz.step === 1) { buildStep1(p.body); startStep1(); }
            else if (wiz.step === 2) { buildStep2(p.body); }
            else { buildStep3(p.body); }
        }
        if (wiz.step === 1) { updateStep1(); }
        else if (wiz.step === 2) { updateStep2(); }
    }

    function buildStep1(b) {
        b.appendChild(stepHead(1, 'calib.wiz.s1'));
        var ul = el('ol', 'vt-cam-howto');
        ['calib.wiz.how1', 'calib.wiz.how2', 'calib.wiz.how3', 'calib.wiz.how4'].forEach(function (k) { ul.appendChild(el('li', null, t(k))); });
        b.appendChild(ul);
        var pv = el('div', 'vt-cam-preview vt-cam-nosig');
        var img = el('img');
        img.alt = t('calib.wiz.preview_alt');
        pv.appendChild(img);
        pv.appendChild(el('div', 'vt-cam-roi'));
        pv.appendChild(el('div', 'vt-cam-nosig-text', t('calib.wiz.no_preview')));
        parts.snap = img;
        b.appendChild(pv);
        b.appendChild(el('div', 'vt-app-hint', t('calib.wiz.roi_hint')));
        parts.list = el('ul', 'vt-cam-checklist');
        b.appendChild(parts.list);
        // the camera handover (ROS driver <-> calibration) must be ready too
        b.appendChild(el('span', 'vt-label', t('calib.pre.title')));
        parts.pre = el('ul', 'vt-cam-checklist');
        b.appendChild(parts.pre);
        parts.recover = btn('btn-outline-warning', 'calib.btn.recover', function () { send({ cmd: 'recover' }); });
        parts.recover.title = t('calib.btn.recover_tip');
        parts.recoverRow = el('div', 'vt-row vt-card-actions vt-cam-actions');
        parts.recoverRow.appendChild(parts.recover);
        b.appendChild(parts.recoverRow);
        parts.recoverInfo = el('div');
        b.appendChild(parts.recoverInfo);
        var det = el('details', 'vt-cam-adv');
        det.appendChild(el('summary', 'vt-fs-sm vt-pointer', t('calib.wiz.tape')));
        var g = el('div', 'input-group input-group-sm vt-field');
        var inp = el('input', 'form-control');
        inp.type = 'number'; inp.min = '0.3'; inp.max = '3'; inp.step = '0.01';
        inp.inputMode = 'decimal';
        inp.placeholder = t('calib.wiz.tape_ph');
        inp.value = wiz.gt;
        inp.setAttribute('aria-label', t('calib.wiz.tape'));
        inp.addEventListener('input', function () { wiz.gt = inp.value; updateStep1(); });
        g.appendChild(inp);
        g.appendChild(el('span', 'input-group-text', 'm'));
        det.appendChild(g);
        det.appendChild(el('div', 'vt-app-hint', t('calib.wiz.tape_hint')));
        b.appendChild(det);
        b.appendChild(el('div', 'vt-app-hint vt-warn-text', t('calib.wiz.pause_warn')));
        var row = el('div', 'vt-row vt-card-actions vt-cam-actions');
        row.appendChild(btn('btn-outline-secondary', 'common.cancel', closeWizard));
        parts.start = btn('btn-success', 'calib.wiz.start', function () {
            var g2 = gtValue();
            var c = { cmd: 'calibrate' };
            if (g2) { c.gt_m = g2; }
            wiz.step = 2; wiz.started = Date.now(); wiz.sawRunning = false;
            send(c);
            update();
        });
        row.appendChild(parts.start);
        b.appendChild(row);
    }
    function updateStep1() {
        var sc = st && st.scene, ul = parts.list;
        if (!ul) { return; }
        ul.textContent = '';
        function item(ok, text) {
            var li = el('li', ok ? 'vt-cam-ok' : 'vt-cam-no');
            li.appendChild(el('i', 'la ' + (ok ? 'la-check' : 'la-close')));
            li.appendChild(el('span', null, text));
            ul.appendChild(li);
        }
        if (!sc) {
            ul.appendChild(el('li', 'vt-muted', st ? t('calib.wiz.scanning') : t('camset.dev.no_node')));
        } else {
            var R = sc.reasons || [];
            var has = function (r) { return R.indexOf(r) >= 0; };
            item(!has('moving'), has('moving') ? reasonText('moving', sc) : t('calib.ok.still'));
            if (has('busy')) { item(false, reasonText('busy', sc)); }
            if (has('no_camera')) { item(false, reasonText('no_camera', sc)); }
            else {
                item(!has('no_wall'), has('no_wall') ? reasonText('no_wall', sc) : t('calib.ok.wall'));
                if (!has('no_wall')) {
                    var far = has('too_far'), near = has('too_close');
                    item(!far && !near, far ? reasonText('too_far', sc) : near ? reasonText('too_close', sc) : t('calib.ok.dist', { dist: sc.dist.toFixed(2) }));
                    item(!has('angle'), has('angle') ? reasonText('angle', sc) : t('calib.ok.angle', { angle: Math.round(sc.angle) }));
                }
                item(!has('not_filled'), has('not_filled') ? reasonText('not_filled', sc) : t('calib.ok.fill', { fill: Math.round(sc.fill * 100) }));
                item(!has('not_flat'), has('not_flat') ? reasonText('not_flat', sc) : t('calib.ok.flat'));
                if (has('not_vertical')) { item(false, reasonText('not_vertical', sc)); }
            }
        }
        // handover preflight
        var pre = st && st.preflight, pu = parts.pre, preOk = false;
        if (pu) {
            pu.textContent = '';
            var item2 = function (ok, text) {
                var li = el('li', ok ? 'vt-cam-ok' : 'vt-cam-no');
                li.appendChild(el('i', 'la ' + (ok ? 'la-check' : 'la-close')));
                li.appendChild(el('span', null, text));
                pu.appendChild(li);
            };
            if (!pre) {
                pu.appendChild(el('li', 'vt-muted', running() ? t('calib.pre.busy') : t('calib.wiz.scanning')));
            } else {
                var P = pre.problems || [];
                var sdk = (st && st.sdk) || {};
                var va = { hz: pre.hz, who: (pre.foreign || []).join(', '), have: sdk.version || '—', need: sdk.required || '—' };
                ['no_depth', 'rebinding', 'foreign', 'flag'].forEach(function (k) {
                    var bad = P.indexOf(k) >= 0;
                    item2(!bad, t((bad ? 'calib.pre.' : 'calib.pre_ok.') + k, va));
                });
                // the kernel camera driver: without it no /dev/video ever comes (#57)
                var v4l = P.indexOf('no_v4l') >= 0;
                item2(!v4l, t(v4l ? 'calib.pre.no_v4l' : 'calib.pre_ok.no_v4l'));
                if (v4l && pre.v4l) {
                    var vl = el('li', 'vt-cam-li-btn');
                    vl.appendChild(el('div', 'vt-cam-detail', t('calib.v4l.cause.' + pre.v4l.cause)));
                    vl.appendChild(el('div', 'vt-cam-detail', t('calib.v4l.fix')));
                    var code = el('code', 'vt-cam-cmd', pre.v4l.cmd);
                    vl.appendChild(code);
                    vl.appendChild(el('div', 'vt-cam-detail', t('calib.v4l.after')));
                    pu.appendChild(vl);
                }
                // the calibration library, matched to the camera firmware
                var sk = P.indexOf('sdk_mismatch') >= 0 ? 'sdk_mismatch' : P.indexOf('no_sdk') >= 0 ? 'no_sdk' : null;
                item2(!sk, sk ? (sdk.installing ? t('calib.sdk.installing') : t('calib.pre.' + sk, va)) : t('calib.pre_ok.no_sdk', va));
                if (sk && !sdk.installing) {
                    var ib = btn('btn-outline-info btn-sm', 'calib.btn.install_sdk', function () { send({ cmd: 'install_sdk' }); ib.disabled = true; });
                    var li = el('li', 'vt-cam-li-btn');
                    li.appendChild(ib);
                    if (sdk.error) { li.appendChild(el('div', 'vt-cam-detail', t('calib.sdk.install_err', { e: sdk.error }))); }
                    pu.appendChild(li);
                }
                preOk = !P.length;
            }
            var fixable = pre && (pre.problems || []).some(function (k) { return ['no_depth', 'rebinding', 'flag'].indexOf(k) >= 0; });
            parts.recoverRow.style.display = fixable || (st && st.job === 'recover' && running()) ? '' : 'none';
            parts.recover.disabled = running();
            parts.recoverInfo.textContent = '';
            if (st && st.job === 'recover' && (running() || st.phase === 'done') && st.steps) {
                parts.recoverInfo.appendChild(stepsEl());
                if (!running() && /^calib\.err/.test(st.msg || '')) { parts.recoverInfo.appendChild(errorBlock(st.msg, st.msg_args)); }
            }
        }
        if (parts.start) {
            parts.start.disabled = !sceneUsable(sc) || !preOk || running();
            parts.start.title = parts.start.disabled ? t('calib.wiz.start_off') : '';
        }
    }

    function progressEl() {
        var w = el('div', 'vt-cam-prog');
        var bar = el('div', 'vt-cam-bar');
        var fill = el('div', 'vt-cam-fill');
        fill.style.width = Math.round(((st && st.progress) || 0) * 100) + '%';
        bar.appendChild(fill);
        w.appendChild(bar);
        w.appendChild(el('div', 'vt-app-hint', msgText(st && st.msg, st && st.msg_args)));
        return w;
    }
    function buildStep2(b) {
        b.appendChild(stepHead(2, 'calib.wiz.s2'));
        parts.phases = el('div');
        b.appendChild(parts.phases);
        parts.prog = el('div');
        b.appendChild(parts.prog);
        b.appendChild(el('div', 'vt-app-hint vt-warn-text', t('calib.wiz.pause_warn')));
        var row = el('div', 'vt-row vt-card-actions vt-cam-actions');
        parts.cancel = btn('btn-outline-danger', 'calib.wiz.cancel', function () { send({ cmd: 'cancel' }); parts.cancel.disabled = true; });
        row.appendChild(parts.cancel);
        b.appendChild(row);
    }
    function updateStep2() {
        parts.phases.textContent = '';
        if (st && st.job === 'calibrate' && st.steps) {
            parts.phases.appendChild(stepsEl());
        } else {
            parts.phases.appendChild(el('div', 'vt-muted', t('calib.wiz.starting')));
        }
        parts.prog.textContent = '';
        parts.prog.appendChild(progressEl());
        if (parts.cancel) { parts.cancel.disabled = !running() || CANCELLABLE.indexOf(st.phase) < 0; }
    }

    function lastRec() {
        var l = st && st.last;
        return l && wiz && l.t * 1000 >= wiz.started - 5000 ? l : null;
    }
    function resultState() {
        var l = lastRec();
        if (!l) { return 'err'; }
        return l.saved || l.result === 'calib.res.already_ok' ? 'ok' : 'warn';
    }
    function buildStep3(b) {
        b.appendChild(stepHead(3, 'calib.wiz.s3'));
        var l = lastRec();
        var failed = !l || /^calib\.(err|msg\.cancelled)/.test(l.result || '');
        if (failed) {
            // refused or stopped: what happened, where the camera is, was anything written
            var key = (l && l.result) || (st && st.msg) || 'calib.res.unknown';
            var args = (l && l.error_args) || (st && st.msg_args) || {};
            if (!l) { args = Object.assign({ written: false }, args); }
            b.appendChild(errorBlock(key, args));
        } else {
            if (l.result === 'calib.res.already_ok') {
                // nothing to change is a result, not an error
                b.appendChild(el('div', 'vt-cam-result vt-ok-text', t('calib.wiz.accurate')));
                b.appendChild(el('div', 'vt-app-hint', t('calib.wiz.accurate_detail', {
                    sdk: cm(l.err_sdk), ros: cm(l.ros_before - l.gt_ros), h: l.onchip_health !== undefined ? l.onchip_health : '—' })));
            } else {
                b.appendChild(el('div', 'vt-cam-result ' + (l.saved ? 'vt-ok-text' : 'vt-warn-text'),
                    t(l.saved ? 'calib.wiz.saved' : 'calib.wiz.reverted') + ' — ' + msgText(l.result || 'calib.res.unknown')));
            }
            var dl = el('dl', 'vt-kv vt-kv-2');
            var be = l.before || {}, af = l.after || {};
            kv(dl, 'calib.wiz.r_2m_before', cm(be.b2));
            kv(dl, 'calib.wiz.r_2m_after', cm(af.b2));
            if (l.gt) {
                // the camera as ROS sees it, before the pause and after the reset
                var gr = l.gt_ros !== undefined ? l.gt_ros : l.gt;
                kv(dl, 'calib.wiz.r_wall_before', cm((l.ros_before !== undefined ? l.ros_before : l.sdk_before) - gr));
                kv(dl, 'calib.wiz.r_wall_after', cm((l.ros_after !== undefined ? l.ros_after : l.sdk_after) - gr));
                kv(dl, 'calib.wiz.r_gt', l.gt.toFixed(3) + ' m (' + t(l.gt_src === 'tape' ? 'calib.wiz.gt_tape' : 'calib.wiz.gt_lidar') + ')');
            }
            if (l.onchip_health !== undefined) { kv(dl, 'calib.wiz.r_health', String(l.onchip_health)); }
            if (l.readback) { kv(dl, 'calib.wiz.r_readback', t(l.readback === 'ok' ? 'calib.wiz.readback_ok' : 'calib.wiz.readback_bad')); }
            b.appendChild(dl);
            if (l.onchip_error || l.tare_error) {
                b.appendChild(el('div', 'vt-app-hint vt-warn-text', t('calib.wiz.partial', { e: l.onchip_error || l.tare_error })));
            }
            var ce = l.camera || (st && st.camera_end);
            if (ce) { b.appendChild(el('div', ce.ok ? 'vt-ok-text' : 'vt-err-text', t(ce.ok ? 'calib.cam.back' : 'calib.cam.off'))); }
        }
        if (st && st.steps && st.steps.length) { b.appendChild(stepsEl()); }
        var row = el('div', 'vt-row vt-card-actions vt-cam-actions');
        if (l && l.result === 'calib.res.lidar_disagrees' && st && st.can_restore) {
            row.appendChild(confirmBtn('btn-outline-warning', 'calib.btn.restore', 'restore3', function () {
                send({ cmd: 'restore' }); closeWizard();
            }));
        }
        row.appendChild(btn('btn-outline-secondary', 'calib.wiz.again', function () { wiz.step = 1; parts.wizStep = null; update(); }));
        row.appendChild(btn('btn-primary', 'calib.wiz.done', closeWizard));
        b.appendChild(row);
    }

    /* ------------------------------------------------------------ sensor */
    function seg(id, opts, get, set) {
        var g = el('div', 'btn-group btn-group-sm vt-seg');
        g.setAttribute('role', 'group');
        g.id = 'camset_' + id;
        opts.forEach(function (o) {
            var b = el('button', 'btn btn-primary', t(o[1]));
            b.type = 'button';
            b.setAttribute('data-v', JSON.stringify(o[0]));
            b.addEventListener('click', function () { if (get() !== o[0]) { set(o[0]); } });
            g.appendChild(b);
        });
        g._sync = function () {
            var v = get();
            Array.prototype.forEach.call(g.children, function (b) {
                var on = b.getAttribute('data-v') === JSON.stringify(v);
                b.classList.toggle('vt-sel', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.disabled = !st || running();
            });
        };
        return g;
    }
    function setting(k) { return st && st.settings ? st.settings[k] : undefined; }
    function setVal(k, v) { send({ cmd: 'set', values: (function () { var o = {}; o[k] = v; return o; })() }); }
    function buildSensor() {
        var p = parts.sen;
        p.body.textContent = '';
        var box = el('div', 'vt-app-items');
        var ctl = parts.senCtl = [];
        function row(labelKey, node, key) {
            var it = el('div', 'vt-app-item');
            var lab = el('span', 'vt-label', t(labelKey));
            it.appendChild(lab);
            it.appendChild(node);
            box.appendChild(it);
            ctl.push({ node: node, key: key, lab: lab, labelKey: labelKey });
        }
        var onoff = [[true, 'common.on'], [false, 'common.off']];
        row('camset.sen.emitter', seg('emitter', [[1, 'common.on'], [0, 'common.off']],
            function () { return setting('depth_emitter'); }, function (v) { setVal('depth_emitter', v); }), 'depth_emitter');
        var lp = el('div', 'vt-row vt-cam-range');
        var r = el('input', 'form-range vt-grow');
        r.type = 'range'; r.min = '0'; r.max = '360'; r.step = '30';
        r.setAttribute('aria-label', t('camset.sen.laser'));
        var val = el('span', 'vt-cam-val');
        r.addEventListener('input', function () { val.textContent = r.value + ' mW'; });
        r.addEventListener('change', function () { setVal('depth_laser_power', parseFloat(r.value)); });
        lp.appendChild(r); lp.appendChild(val);
        lp._sync = function () {
            if (document.activeElement === r) { return; }
            var v = setting('depth_laser_power');
            if (v !== undefined) { r.value = v; val.textContent = Math.round(v) + ' mW'; }
            r.disabled = !st || running() || setting('depth_emitter') === 0;
        };
        row('camset.sen.laser', lp, 'depth_laser_power');
        row('camset.sen.depth_ae', seg('depth_ae', onoff,
            function () { return setting('depth_auto_exposure'); }, function (v) { setVal('depth_auto_exposure', v); }), 'depth_auto_exposure');
        row('camset.sen.color_ae', seg('color_ae', onoff,
            function () { return setting('color_auto_exposure'); }, function (v) { setVal('color_auto_exposure', v); }), 'color_auto_exposure');
        row('camset.sen.color_wb', seg('color_wb', onoff,
            function () { return setting('color_auto_wb'); }, function (v) { setVal('color_auto_wb', v); }), 'color_auto_wb');
        p.body.appendChild(box);
        parts.senHint = el('div', 'vt-app-hint');
        p.body.appendChild(parts.senHint);
        var act = el('div', 'vt-row vt-card-actions vt-cam-actions');
        parts.senReset = btn('btn-outline-secondary', 'camset.sen.defaults', function () { send({ cmd: 'reset_settings' }); });
        act.appendChild(parts.senReset);
        p.body.appendChild(act);
        parts.senBuilt = true;
    }
    function renderSensor() {
        if (!parts.senBuilt) { buildSensor(); }
        var p = parts.sen, ov = (st && st.overrides) || {};
        var n = Object.keys(ov).length;
        p.card.setAttribute('data-state', !st || !st.settings || !Object.keys(st.settings).length ? 'off' : '');
        if (p.card.getAttribute('data-state') === '') { p.card.removeAttribute('data-state'); }
        p.end.textContent = n ? t('camset.sen.changed', { n: n }) : t('camset.sen.default');
        parts.senCtl.forEach(function (c) {
            if (c.node._sync) { c.node._sync(); }
            c.lab.textContent = t(c.labelKey) + (ov.hasOwnProperty(c.key) ? ' •' : '');
        });
        parts.senHint.textContent = st && st.settings && Object.keys(st.settings).length ? t('camset.sen.hint') : t('camset.sen.no_settings');
        parts.senReset.disabled = !n || running();
    }

    /* ------------------------------------------------------------ layers */
    function renderLayers() {
        var p = parts.lay, O = window.VTCamOverlay;
        p.body.textContent = '';
        if (!O) { p.body.appendChild(el('div', 'vt-app-hint', t('camset.lay.none'))); return; }
        var s = O.state();
        var on = LAYERS.filter(function (l) { return s[l[0]]; }).length;
        p.end.textContent = on ? t('camset.lay.on', { n: on }) : t('camset.lay.off');
        var g = el('div', 'btn-group btn-group-sm vt-seg vt-cam-layers');
        g.setAttribute('role', 'group');
        LAYERS.forEach(function (l) {
            var b = el('button', 'btn btn-primary', t(l[1]));
            b.type = 'button';
            b.title = t(l[1] + '.tip');
            b.classList.toggle('vt-sel', !!s[l[0]]);
            b.setAttribute('aria-pressed', s[l[0]] ? 'true' : 'false');
            b.addEventListener('click', function () { O.set(l[0], !O.state()[l[0]]); renderLayers(); });
            g.appendChild(b);
        });
        p.body.appendChild(g);
        var it = el('div', 'vt-row vt-cam-range');
        it.appendChild(el('span', 'vt-label', t('camset.lay.opacity')));
        var r = el('input', 'form-range vt-grow');
        r.type = 'range'; r.min = '0.1'; r.max = '1'; r.step = '0.05'; r.value = s.opacity;
        r.setAttribute('aria-label', t('camset.lay.opacity'));
        r.addEventListener('input', function () { O.opacity(parseFloat(r.value)); });
        it.appendChild(r);
        p.body.appendChild(it);
        p.body.appendChild(el('div', 'vt-app-hint', t('camset.lay.hint')));
    }

    /* ------------------------------------------------------------ update */
    function update() {
        if (!host || !parts.dev) { return; }
        renderDevice();
        renderAccuracy();
        renderSensor();
        if (!parts.layDrawn) { renderLayers(); parts.layDrawn = true; }
    }

    /* on screen = the tab is active and the Settings panel is shown */
    function poll() {
        var vis = !!(pane && pane.classList.contains('active') && pane.offsetParent !== null && !document.hidden);
        if (vis !== shown) {
            shown = vis;
            subscribe(vis);
            if (vis) { parts.layDrawn = false; update(); if (wiz && wiz.step === 1) { startStep1(); } }
            else { stopStep1(); parts.wizStep = null; }
        } else if (vis && (!sub || Date.now() - lastRx > 8000)) {
            // rosbridge reconnected, or nothing for 8 s (the node publishes
            // at least every 5 s): subscribe again
            unsub();
            subscribe(true);
            if (wiz && wiz.step === 1) { send({ cmd: 'watch', on: true }); }
        }
    }

    function init() {
        host = document.getElementById('div_camera_settings');
        pane = document.getElementById('tab_camera');
        if (!host || !pane) { return; }
        build();
        var link = document.querySelector('a[href="#tab_camera"]');
        if (link) { link.addEventListener('shown.bs.tab', poll); }
        setInterval(poll, 1000);
        document.addEventListener('visibilitychange', poll);
        if (I && I.onChange) { I.onChange(function () { build(); }); }
    }
    window.VTCameraSettings = { status: function () { return st; }, send: send, _wiz: function () { return wiz; } };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 0); }); }
    else { setTimeout(init, 0); }
})();
