/* right_dock.js — JEDEN pravý panel mapového pohledu (2026-08-23).
 *
 * Levý drawer patří agentnímu panelu, takže všechno, co bylo vpravo (a vlevo)
 * roztroušené jako plovoucí panýlky, žije tady v jednom panelu ukotveném
 * k pravému hornímu rohu:
 *
 *   0. Horní řádek — follow + název aktivní mapy (telefon: + tečky, baterie)
 *   1. Controls    — rychlost (Slow/Mid/Fast), klávesnicový teleop,
 *                    baterie + Dock/Undock/Stop
 *   2. Mower       — jen když je sekačka zapnutá, jen hlavička: stav, nůž, výška
 *   3. Navi        — hlavička: kdo drží polohu + kurz; řádek VO/Li/Wh/FIX/PROB/ANC
 *   4. GNSS        — jen hlavička: fix Poloha · Kurz · SV · stáří korekcí · ›
 *   5. Kamera      — tečka stavu streamu, malý živý náhled
 *
 * Hlavičky sekcí nesou stav barevnými značkami (slova v tooltipu); dlouhé
 * texty (karta GNSS, řádky trackeru, RtabMap) jsou v levém panelu › Mapa ›
 * Loc (buildLocCard), › v řádku GNSS je otevře.
 *
 * Prvky se REPARENTUJÍ i s id, takže je map_view.js dál obsluhuje beze změny
 * (nastavuje jim text i display). Výjimka je kamera: #div_camera_view vlastní
 * CameraView (position:fixed, průběžný přepis inline stylů, reload streamu),
 * takže se nepřesouvá — panel má jen slot a element se na něj přisadí přes
 * CSS proměnné (pravidlo s !important, viz right_dock.css).
 *
 * Skrývání: úchyt se šipkou na levé hraně panelu, stav v localStorage
 * (`vitulus_rightpanel_open`). Skrytý panel = jen tenký úchyt, mapa má celou
 * plochu; kamera se přitom zastaví, ať nežere pásmo.
 *
 * Malý displej (<576 px): shora ikonky (#status_div) → log (#div_log_view,
 * celá šířka) → panel. Pozice se počítají z reálných boundingRectů.
 */
(function () {
    'use strict';

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function t(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
    function tag(e, k, attr) { if (window.VTI18n) { VTI18n.tag(e, k, attr); } }
    var relang = [];                      // re-paint after a language switch
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    var LS_OPEN = 'vitulus_rightpanel_open';
    var LS_COMPACT = 'vitulus_rightpanel_compact';   // U1: telefon, 1 řádek
    var FRAME_GAP = 14;                  // C frame: the open front between top and bottom protrusions
    function setCls(e, c, on) {
        if (e && e.classList.contains(c) !== !!on) { e.classList.toggle(c, !!on); }
    }
    var DOCK_W = 216, DOCK_H = 162;      // náhled kamery (4:3 jako zdroj 160×120)
    var PANEL_W = 196;

    /* Názvy sekcí anglicky (přání majitele) a KAŽDÁ sekce je sbalitelná —
       stav si drží každá zvlášť v localStorage, takže přežije reload. */
    /* 2026-10-18 (majitel: „GNSS je tam dvakrát, sekačka je na špatném
       místě"): shora Controls (tlačítka se nikdy neposouvají) → Mower (jen
       když je sekačka zapnutá, hned pod ovládáním, ne schovaná v Navi) →
       Navi (kdo drží polohu, odometrie, tracker, RtabMap) → GNSS (JEDEN zdroj
       pravdy = karta přijímačů; sbaleno = souhrnný řádek v hlavičce, staré
       řádky GNSS z Navi jsou pryč) → Camera. */
    /* 2026-10-18 later (owner: "the right panel is not for essays … the
       colour alone should carry it; the camera no longer fits"; and "the
       Navi sub-panel can carry info in its HEADER"): every section head is
       a row of coloured tokens (right-aligned, words in tooltips), the body
       holds only what does not fit there. Long texts live in the LEFT
       panel › Map › Loc (GNSS card, tracker lines, RtabMap — buildLocCard).
         Controls: head ⚡ battery % · motors; body speed + Dock/Undock/Stop
         Mower:    head — state chip · blade dot + rpm · temp if hot · blade Start / Stop
         Navi:     head pose owner + heading source + odometry dot; expand VO Li Wh FIX PROB ANC
         GNSS:     head only — Position · Heading fix · satellites · correction
                   age dot · › (opens the left panel's GNSS card)
         Camera:   head stream dot + Off / S / L; body the picture */
    /* 2026-10-18 evening (owner: "the right panel is a dashboard — colour
       at a glance, the current numbers at hand when I look, the detail and
       the explanations in the left panel"): THREE LEVELS for Mower, Navi and
       GNSS —
         1. head = colour + a few tokens (always visible; hover = what it is
            and the one important number),
         2. in-place expand (caret, folded by default, remembered per
            section in localStorage `vitulus_rightpanel_x_<id>`) = the quick
            current numbers,
         3. a small detail icon in the head, right before the "?" = the
            left panel › Map › Loc "Localization detail" (Navi, GNSS).
         Mower:  head blade Start / Stop; expand = Blade · Height · Temp cells +
                 the running program
         Navi:   expand = the VO Li Wh FIX PROB ANC row + tracker one-liner
         GNSS:   expand = Position | Heading, first rows only */
    var SECTIONS = [
        {id: 'drive', title: 'rdock.sec.drive',
         line: ['div_status_speed', 'div_status_speed-1'],
         movees: ['div_status_speed-2'], collapsible: true, drive: true},
        {id: 'mower', title: 'rdock.sec.mower', mower: true, collapsible: true, folded: true,
         lsKey: 'vitulus_rightpanel_x_mower'},
        /* 2026-10-18 late: the VO Li Wh FIX PROB ANC row lives in the expand,
           the head keeps owner · heading · one odometry dot */
        {id: 'state', title: 'rdock.sec.state', movees: ['div_odom'], detail: 'loc_nav_box',
         collapsible: true, folded: true, lsKey: 'vitulus_rightpanel_x_navi', navi: true},
        /* the old /gnss/fix rows (#div_gnss) stay hidden here: map_view.js
           still writes into them */
        {id: 'gnss', title: 'rdock.sec.gnss', movees: ['div_gnss'], gsum: true, detail: 'loc_gnss_rx_box',
         collapsible: true, folded: true, lsKey: 'vitulus_rightpanel_x_gnss'},
        {id: 'camera', title: 'rdock.sec.camera', movees: [], camera: true, collapsible: true}
    ];

    var panel, handle, camState;

    function el(tag, cls, parent) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (parent) { parent.appendChild(e); }
        return e;
    }

    /* Řádek se stavovým textem (#span_status_info): samotný span je při
       prázdné zprávě display:none, ale jeho ŘÁDEK místo zabírá dál — panel
       proto měří řádek, ne span, jinak by text překrýval. */
    function infoRowRect() {
        var s = document.getElementById('span_status_info');
        if (!s) { return null; }
        var row = s.closest ? s.closest('.row') : s.parentElement;
        var r = (row || s).getBoundingClientRect();
        return r.height ? r : null;
    }

    /* C frame 3 (vt_frame.js): the panel is a protrusion of the frame — it
       hangs from the top band, the log and the joystick live at the bottom */
    function inFrame() { return document.body.classList.contains('vt-frame'); }
    function frameVar(k) {
        var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(k));
        return isNaN(v) ? null : v;
    }
    function camLarge() { return document.body.classList.contains('vt-cam-large'); }
    function setCamLarge(on) { if (window.VtFrame && window.VtFrame.camSet) { window.VtFrame.camSet(on); } }

    function rectOf(id) {
        var e = document.getElementById(id);
        if (!e) { return null; }
        if (e.style && e.style.display === 'none') { return null; }
        var r = e.getBoundingClientRect();
        return (r.width || r.height) ? r : null;
    }

    function neutralize(e) {
        /* jen polohové inline vlastnosti; padding/border nechat — map_view.js
           je parsuje (parseInt) při dopočtu velikosti kamery */
        e.style.position = 'static';
        e.style.marginTop = '0px';
        e.style.marginLeft = '0px';
        e.style.marginBottom = '0px';
        e.style.float = 'none';
        e.style.zIndex = '';
    }

    // ------------------------------------------------------------ stavba
    function build() {
        panel = el('div', null);
        panel.id = 'right_panel';

        /* Úchyt je SOUROZENEC panelu, ne jeho dítě: skrytí je display:none
           (v téhle stránce se `right` ani `transform` na panelu neprojeví —
           ověřeno v Chromu), takže úchyt uvnitř by zmizel s ním. */
        handle = el('button', 'rp-handle');
        handle.type = 'button';
        handle.id = 'rp_handle';
        handle.title = t('rdock.handle');
        handle.setAttribute('aria-label', t('rdock.handle'));
        tag(handle, 'rdock.handle', 'title');
        tag(handle, 'rdock.handle', 'aria-label');
        document.body.appendChild(handle);

        var body = el('div', 'rp-body', panel);
        body.id = 'rp_body';

        /* Nahoře: ikonka follow (klik = přepnutí Map/robot přes #btn_follow)
           a hned za ní název aktivní mapy. Dřív to byl celý řádek „Map" plus
           druhý řádek s názvem — dva řádky za jednu informaci. */
        var topRow = el('div', 'rp-top', body);
        ['div_status_follow_ico', 'div_status_map_ico', 'div_status_map_name',
         'div_status_follow_txt'].forEach(function (id) {
            var e = document.getElementById(id);
            if (!e) { return; }
            neutralize(e);
            topRow.appendChild(e);
        });
        /* U1 kolo 2: na telefonu jde panel sbalit do JEDNOHO řádku (mapa +
           baterie + ▾), ať nezakrývá půl mapy. Baterie je zrcadlo
           #span_batt_pct (ten zůstává v sekci Controls), tlačítko přepíná
           sbaleno/rozbaleno; stav v localStorage, výchozí = sbaleno. */
        /* U1 kolo 3: stav polohy ve sbaleném řádku — dvě tečky, Pose (kdo
           drží polohu) a GNSS (fix), barva i text převzaté z čipů v sekci
           Navi (#span_odom_drive) a z karty GNSS (buildGnssSum), ať je jeden
           zdroj pravdy; třetí tečka = sekačka, jen když je zapnutá. */
        var loc = el('span', 'rp-sum-loc', topRow);
        loc.id = 'rp_sum_loc';
        [['span_odom_drive', 'Pose', 'rdock.dot.pose']].forEach(function (pair) {
            var src = document.getElementById(pair[0]);
            var dot = el('span', 'vt-dot rp-sum-dot', loc);
            dot.id = 'rp_sum_dot_' + pair[1].toLowerCase();
            if (!src) { return; }
            var copy = function () {
                // U1 kolo 4: the chip carries its state in data-state (vtChip)
                dot.dataset.state = src.dataset.state || 'off';
                dot.title = (pair[2] ? t(pair[2]) : pair[1]) + ': ' + ((src.textContent || '').trim() || '—');
                dot.setAttribute('aria-label', dot.title);
            };
            copy();
            relang.push(copy);
            new MutationObserver(copy).observe(src, {childList: true, characterData: true,
                subtree: true, attributes: true, attributeFilter: ['data-state']});
        });
        /* GNSS dot = the receivers card (one source of truth, see gnssSummary);
           the mower dot shows only while the mower is on */
        var gdot = el('span', 'vt-dot rp-sum-dot', loc);
        gdot.id = 'rp_sum_dot_gnss';
        gdot.dataset.state = 'off';
        var mdot = el('span', 'vt-dot rp-sum-dot rp-sum-mower', loc);
        mdot.id = 'rp_sum_dot_mower';
        mdot.dataset.state = 'off';
        mdot.style.display = 'none';
        var sum = el('span', 'rp-sum', topRow);
        sum.id = 'rp_sum_batt';
        /* C frame 3: on a phone the collapsed row carries the camera switch —
           the large camera is a band across the top of the map there */
        var qcam = el('button', 'rp-sum-cam', topRow);
        qcam.type = 'button';
        qcam.id = 'rp_sum_cam';
        qcam.innerHTML = '<i class="la la-video-camera"></i>';
        qcam.title = t('rdock.cam.toggle');
        qcam.setAttribute('aria-label', qcam.title);
        tag(qcam, 'rdock.cam.toggle', 'title');
        tag(qcam, 'rdock.cam.toggle', 'aria-label');
        qcam.addEventListener('click', function (ev) { ev.stopPropagation(); setCamLarge(!camLarge()); });
        var cbtn = el('button', 'rp-compact-btn', topRow);
        cbtn.type = 'button';
        cbtn.id = 'rp_compact_btn';
        cbtn.addEventListener('click', function () {
            lsSet(LS_COMPACT, isCompact() ? '0' : '1');
            applyCompact();
            place();
            paintCam();
        });
        var bp = document.getElementById('span_batt_pct');
        if (bp) {
            var mirror = function () {
                sum.textContent = '⚡' + (bp.textContent || '').trim();
                sum.style.color = bp.style.color || '';
            };
            mirror();
            new MutationObserver(mirror).observe(bp, {childList: true, characterData: true,
                subtree: true, attributes: true, attributeFilter: ['style']});
        }
        var fico = document.getElementById('div_status_follow_ico');
        if (fico) {
            fico.classList.add('rp-click');
            fico.title = t('rdock.follow');
            tag(fico, 'rdock.follow', 'title');
            fico.addEventListener('click', function () {
                var b = document.getElementById('btn_follow');
                if (b) { b.click(); }
            });
        }

        SECTIONS.forEach(function (def) {
            var sec = el('section', 'rp-sec', body);
            sec.setAttribute('data-sec', def.id);
            if (def.headOnly) { sec.classList.add('rp-head-only'); }
            var h = el('h5', null, sec);
            /* the title in its own span: the h5 also holds the caret and the
               camera switch, a tag on the h5 would wipe them */
            var ht = el('span', 'rp-sec-title', h);
            ht.textContent = t(def.title);
            tag(ht, def.title);
            if (def.collapsible) {
                var lsKey = def.lsKey || ('vitulus_rightpanel_sec_' + def.id);
                h.classList.add('rp-click');
                var caret = el('span', 'rp-caret', h);
                var openSec = def.folded ? lsGet(lsKey) === '1' : lsGet(lsKey) !== '0';
                sec.classList.toggle('folded', !openSec);
                caret.textContent = openSec ? '▾' : '▸';
                h.setAttribute('aria-expanded', openSec ? 'true' : 'false');
                h.addEventListener('click', function () {
                    var now = !sec.classList.contains('folded');
                    sec.classList.toggle('folded', now);     // now = bude sbaleno
                    caret.textContent = now ? '▸' : '▾';
                    h.setAttribute('aria-expanded', now ? 'false' : 'true');
                    lsSet(lsKey, now ? '0' : '1');
                    if (!now && sec.onUnfold) { sec.onUnfold(); }
                    place();
                    paintCam();
                });
            }
            var moved = 0;
            if (def.sub) {                   // always visible under the head
                var subBox = el('div', 'rp-sec-sub', sec);
                def.sub.forEach(function (id) {
                    var e = document.getElementById(id);
                    if (!e) { return; }
                    neutralize(e);
                    subBox.appendChild(e);
                    moved++;
                });
            }
            var box = el('div', 'rp-sec-body', sec);
            if (def.line) {                  // víc prvků na jednom řádku
                var line = el('div', 'rp-line', box);
                def.line.forEach(function (id) {
                    var e = document.getElementById(id);
                    if (!e) { return; }
                    neutralize(e);
                    line.appendChild(e);
                    moved++;
                });
            }
            (def.movees || []).forEach(function (id) {
                var e = document.getElementById(id);
                if (!e) { return; }
                neutralize(e);
                box.appendChild(e);
                moved++;
            });
            if (def.row) {
                var row = el('div', 'rp-row', box);
                def.row.forEach(function (id) {
                    var e = document.getElementById(id);
                    if (!e) { return; }
                    neutralize(e);
                    row.appendChild(e);
                    moved++;
                });
            }
            if (def.drive) { buildDriveHead(h); }
            if (def.navi) { buildNaviHead(h, ht); buildNaviBody(sec, box); }
            if (def.mower) { moved = buildMower(sec, h, box); }
            if (def.gsum) { buildGnssSum(sec, h, box); }
            var lastCaret = h.querySelector('.rp-caret');
            if (lastCaret) { h.appendChild(lastCaret); }   // the caret stays last
            if (def.detail) { headDetail(h, def.detail); } // … right before "?" + caret
            else if (def.drive || def.mower) {
                /* no left-panel detail here: keep its place, so every head's
                   tokens end in the same column (owner: a tidy right edge) */
                var ph = el('span', 'rp-dq rp-dq-ph');
                ph.setAttribute('aria-hidden', 'true');
                h.insertBefore(ph, h.querySelector('.vth-q') || h.querySelector('.rp-caret') || null);
            }
            if (def.camera) {
                /* stream state = one dot (green live, amber starting /
                   waiting, grey off / paused); the word is its tooltip */
                camState = el('span', 'rp-tdot rp-cam-dot', h);
                camState.dataset.state = 'off';
                /* C frame 3: one clear switch — Off (= folded, no stream) /
                   Small (preview here) / Large (the camera takes the map's
                   place, the map comes here). Alt+C toggles small/large. */
                var seg = el('span', 'rp-cam-seg', h);
                seg.setAttribute('role', 'group');
                seg.setAttribute('aria-label', t('rdock.cam.size'));
                tag(seg, 'rdock.cam.size', 'aria-label');
                [['off', 'rdock.cam.off', 'rdock.cam.off.tip'],
                 ['small', 'rdock.cam.small', 'rdock.cam.small.tip'],
                 ['large', 'rdock.cam.large', 'rdock.cam.large.tip']].forEach(function (d) {
                    var b = el('button', 'rp-cam-opt', seg);
                    b.type = 'button';
                    b.setAttribute('data-cam', d[0]);
                    b.textContent = t(d[1]);
                    b.title = t(d[2]);
                    b.setAttribute('aria-label', t(d[2]));
                    tag(b, d[1]);
                    tag(b, d[2], 'title');
                    tag(b, d[2], 'aria-label');
                    b.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        var folded = sec.classList.contains('folded');
                        if (d[0] === 'off') {
                            if (camLarge()) { setCamLarge(false); }
                            if (!folded) { h.click(); }
                        } else {
                            if (folded) { h.click(); }
                            setCamLarge(d[0] === 'large');
                        }
                        paintSeg();
                    });
                });
                var slot = el('div', 'rp-cam-slot', box);
                slot.id = 'rp_cam_slot';
                /* Žádné ruční zapínání: stream se rozjede rozbalením sekce a
                   zhasne jejím sbalením (viz paintCam). Prázdný stav proto jen
                   konstatuje, nic nenabízí — a místo pro náhled zůstává
                   rezervované, ať výška neposkakuje. */
                var off = el('div', 'rp-cam-off', box);
                off.id = 'rp_cam_off';
                off.textContent = t('rdock.cam.nosignal');
                tag(off, 'rdock.cam.nosignal');
                moved = 1;
            }
            if (!moved) { sec.remove(); }
        });

        document.body.appendChild(panel);
        handle.addEventListener('click', function () { setOpen(!isOpen()); });
    }

    // ------------------------------------------------------ hlavičky sekcí
    /* Head tokens: a right-aligned row in the section head; the caret (and
       the "?" vt_help.js puts before it) stay last. */
    function headTokens(h) {
        var w = el('span', 'rp-htok', h);
        var caret = h.querySelector('.rp-caret');
        if (caret) { h.appendChild(caret); }
        return w;
    }
    function tdot(parent, cls) {
        var d = el('span', 'rp-tdot' + (cls ? ' ' + cls : ''), parent);
        d.dataset.state = 'off';
        return d;
    }
    /* while the panel is being built it is not in the document yet */
    function byId(id) {
        return document.getElementById(id) || (panel && panel.querySelector('#' + id));
    }
    function setTip(e, tip) {
        if (e.title !== tip) { e.title = tip; e.setAttribute('aria-label', tip); }
    }

    /* Controls head: ⚡ (green in the dock / charging, dock.js) · battery %
       (its own colour, map_view.js) · motors chip (mirrors the joystick's) */
    function buildDriveHead(h) {
        var w = headTokens(h);
        ['dock_icon_in_dock', 'span_batt_pct'].forEach(function (id) {
            var e = byId(id);
            if (e) { w.appendChild(e); }
        });
        var mot = el('span', 'vt-chip vt-chip-sm rp-mot', w);
        mot.id = 'rp_motors';
        /* the drive motors: the same gear-and-bolt glyph as the drive deck's
           motor key, coloured by the robot's state (word in the tooltip) */
        mot.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3.2 9 1.5h-2l1 1.7Zm0 9.6-1 1.7h2l-1-1.7ZM3.2 8l-1.7-1v2l1.7-1Zm9.6 0 1.7 1v-2l-1.7 1ZM4.6 4.6 3.1 3.8l-.7.7.8 1.5 1.4-1.4Zm6.8 6.8 1.5.8.7-.7-.8-1.5-1.4 1.4Zm0-6.8 1.4 1.4.8-1.5-.7-.7-1.5.8ZM4.6 11.4l-1.4-1.4-.8 1.5.7.7 1.5-.8Z" fill="currentColor"/><circle cx="8" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.4 5.6 6.9 8.3h1.3l-.6 2.1 1.6-2.8H7.9l.5-2Z" fill="currentColor"/></svg>';
        mot.dataset.state = 'off';
        var paint = function () {
            var src = document.querySelector('#joy_view .vt-joy-motors');
            var st = (src && src.getAttribute('data-state')) || 'off';
            if (mot.dataset.state !== st) { mot.dataset.state = st; }
            var key = st === 'ok' ? 'rdock.mot.on' : (st === 'warn' ? 'rdock.mot.off' : 'rdock.mot.unknown');
            setTip(mot, t(key));
        };
        paint();
        relang.push(paint);
        setInterval(paint, 1500);
    }

    /* Navi head: who owns the pose (chip) + heading source SAT / IMU; the
       body keeps one row of odometry chips VO Li Wh FIX PROB ANC */
    var ODO_RANK = {off: 0, ok: 1, warn: 2, err: 3};
    function buildNaviHead(h, ht) {
        var w = headTokens(h);
        ['span_odom_drive', 'span_odom_hdg'].forEach(function (id) {
            var e = byId(id);
            if (e) { e.classList.add('vt-chip-sm'); w.appendChild(e); }
        });
        /* one dot for the odometry sources VO / Li / Wh (the chips moved
           into the expand): red if one is lost, amber if one is degraded,
           green if they run; grey = no data / paused in the dock */
        var odo = tdot(w, 'rp-odo');
        odo.id = 'rp_odo_dot';
        var paint = function () {
            var worst = 'off', tips = [];
            [['span_odom_vo', 'VO'], ['span_odom_licp', 'Li'], ['span_odom_wheel', 'Wh']].forEach(function (d) {
                var e = byId(d[0]);
                if (!e) { return; }
                var st = e.dataset.state || 'off';
                if ((ODO_RANK[st] || 0) > (ODO_RANK[worst] || 0)) { worst = st; }
                tips.push(e.title || d[1]);
            });
            if (odo.dataset.state !== worst) { odo.dataset.state = worst; }
            setTip(odo, t('rdock.odo.tip', {s: t('rdock.odo.' + worst)}) + (tips.length ? '\n' + tips.join('\n') : ''));
            var o = byId('span_odom_drive'), hd = byId('span_odom_hdg');
            setTip(ht, t('rdock.navi.tip', {
                o: o ? ((o.textContent || '').trim() || '—') : '—',
                h: hd ? ((hd.textContent || '').trim() || '—') : '—'}));
        };
        paint();
        relang.push(paint);
        setInterval(paint, 1000);
    }

    /* level 3 = the left panel: a small icon in the section head, right
       before the "?" vt_help.js puts before the caret (owner 2026-10-18:
       "less conspicuous — a small icon up in the header next to the help").
       Not .vth-q: vt_help.js looks for that class to place its "?". */
    var DETAIL_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
        '<path d="M14 2a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM2 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2z"/>' +
        '<path d="M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>';
    function headDetail(h, target) {
        var b = el('button', 'rp-dq');
        b.type = 'button';
        b.innerHTML = DETAIL_SVG;
        var paint = function () { setTip(b, t('rdock.detail.tip')); };
        paint();
        relang.push(paint);
        b.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); openLocTab(target); });
        h.insertBefore(b, h.querySelector('.vth-q') || h.querySelector('.rp-caret') || null);
        return b;
    }

    /* Navi expand: ONE tracker line — standby / active (the chip of the
       left-panel tracker row, mirrored) + the last correction; the full
       tracker lines, sources and anchor live in the left panel */
    function buildNaviBody(sec, box) {
        var line = el('div', 'rp-trk1', box);
        var lab = el('span', 'rp-trk1-k', line);
        lab.textContent = 'Trk';
        var chip = el('span', 'vt-chip vt-chip-sm', line);
        chip.dataset.state = 'off';
        var txt = el('span', 'rp-trk1-t', line);
        var paint = function () {
            if (sec.classList.contains('folded')) { return; }
            var st = document.getElementById('span_trk_state');
            var note = document.getElementById('span_trk_note');
            var last = document.getElementById('span_trk_last');
            var ct = st ? (st.textContent || '').trim() : '—';
            if (chip.textContent !== ct) { chip.textContent = ct || '—'; }
            var cs = (st && st.dataset.state) || 'off';
            if (chip.dataset.state !== cs) { chip.dataset.state = cs; }
            var lt = last ? (last.textContent || '').trim() : '';
            var nt = note ? (note.textContent || '').trim() : '';
            if (txt.textContent !== lt) { txt.textContent = lt; }
            setTip(chip, t('loc.trk.tip') + (nt ? ': ' + nt : ''));
            setTip(line, (nt ? nt + ' · ' : '') + lt);
        };
        /* quick number "Map vs GPS" (vt_georef.js, #32): the deviation in cm
           coloured ≤ 5 / ≤ 15 / above, or why it cannot be measured; click =
           left panel › Map › Loc › UTM frame */
        var gl = el('div', 'rp-trk1 rp-geo1', box);
        gl.setAttribute('role', 'button');
        gl.tabIndex = 0;
        var gk = el('span', 'rp-trk1-k', gl);
        var gv = el('span', 'vt-chip vt-chip-sm', gl);
        gv.dataset.state = 'off';
        var gw = el('span', 'rp-trk1-t', gl);
        var openGeo = function (ev) { ev.stopPropagation(); ev.preventDefault(); openLocTab('loc_utm_card'); };
        gl.addEventListener('click', openGeo);
        gl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { openGeo(ev); } });
        var paintGeo = function () {
            if (sec.classList.contains('folded')) { return; }
            var k = t('rdock.geo.k');
            if (gk.textContent !== k) { gk.textContent = k; }
            var q = window.VtGeoref ? window.VtGeoref.quick() : null;
            var txt = q ? q.text : '—', st = q ? q.state : 'off';
            if (gv.textContent !== txt) { gv.textContent = txt; }
            if (gv.dataset.state !== st) { gv.dataset.state = st; }
            var why = q ? q.why : '';
            if (gw.textContent !== why) { gw.textContent = why; }
            setTip(gl, (q ? q.tip : t('rdock.geo.k')) + '\n' + t('rdock.geo.tip'));
        };
        var paintAll = function () { paint(); paintGeo(); };
        sec.onUnfold = paintAll;
        paintAll();
        relang.push(paintAll);
        setInterval(paintAll, 1000);
    }

    // ------------------------------------------------------------ sekačka
    /* The mower block (#div_mower_info_panel) is driven by map_view.js
       (Mower.process): display none while OFF/UNK, its spans get text and
       colour. Here everything is the section HEAD: state chip · blade dot +
       rpm · cut height · temperature only when hot; the section (and the
       phone's dot) follows the block's display. */
    var MOWER_HOT = 50, MOWER_TOO_HOT = 60;     // °C: amber / red token
    function moverState(st) {
        var c = (st && st.style && st.style.color) || '';
        return c.indexOf('success') >= 0 ? 'ok' : (c.indexOf('danger') >= 0 ? 'err' : 'warn');
    }
    function num(e) {
        var n = parseFloat(((e && e.textContent) || '').replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
    }
    function buildMower(sec, h, box) {
        var src = document.getElementById('div_mower_info_panel');
        if (!src) { return 0; }
        var w = headTokens(h);
        /* level 2: three cells + the running program (expand) */
        var cells = el('div', 'rp-cells', box);
        var mk = function (key) {
            var c = el('div', 'rp-cell', cells);
            var k = el('span', 'rp-cell-k', c);
            k.textContent = t(key);
            tag(k, key);
            return el('span', 'rp-cell-v', c);
        };
        var cB = mk('rdock.mower.blade'), cH = mk('rdock.mower.height'), cT = mk('rdock.mower.temp');
        var prog = el('div', 'rp-mprog', box);
        var chip = el('span', 'vt-chip vt-chip-sm', w);
        chip.id = 'rp_mower_chip';
        chip.dataset.state = 'off';
        /* the blade key below carries the blade state (and its rpm in the
           tooltip); these two stay detached for the code that paints them */
        var blade = el('span', 'rp-tdot rp-blade');
        blade.id = 'rp_mower_blade';
        var rpm = el('span', 'rp-tv');
        rpm.id = 'rp_mower_rpm';
        var tmp = el('span', 'rp-tv', w);
        tmp.id = 'rp_mower_temp';
        var ctl = buildMowerCtl(w);            // Start / Stop (the height is in the expand)
        neutralize(src);
        box.appendChild(src);                 // hidden (CSS), the source + visibility signal
        /* the panel is not in the document yet while it is being built:
           look up inside it, not via document.getElementById */
        var st = src.querySelector('#span_mower_panel_status');
        var vR = src.querySelector('#span_mower_panel_rpm');
        var vH = src.querySelector('#span_mower_panel_height');
        var vT = src.querySelector('#span_mower_panel_temp');
        var mdot = panel.querySelector('#rp_sum_dot_mower');
        var paint = function () {
            var on = src.style.display !== 'none';
            var txt = st ? (st.textContent || '').trim() : '';
            var state = on ? moverState(st) : 'off';
            if (chip.textContent !== txt) { chip.textContent = txt; }
            if (chip.dataset.state !== state) { chip.dataset.state = state; }
            setTip(chip, t('rdock.sec.mower') + ': ' + (txt || '—'));
            if (sec.dataset.tone !== state) { sec.dataset.tone = state; }
            var r = num(vR), hh = num(vH), tc = num(vT);
            blade.dataset.state = r ? 'ok' : 'off';
            setTip(blade, t(r ? 'rdock.mower.blade_on' : 'rdock.mower.blade_off'));
            rpm.textContent = r ? (r >= 1000 ? (r / 1000).toFixed(1) + 'k' : String(Math.round(r))) : '';
            setTip(rpm, t('rdock.mower.blade') + ': ' + (r != null ? Math.round(r) + ' rpm' : '—'));
            var hot = tc != null && tc >= MOWER_HOT;
            tmp.textContent = hot ? Math.round(tc) + '°' : '';
            tmp.style.display = hot ? '' : 'none';
            tmp.dataset.state = hot ? (tc >= MOWER_TOO_HOT ? 'err' : 'warn') : 'off';
            setTip(tmp, t('rdock.mower.temp') + ': ' + (tc != null ? Math.round(tc) + ' °C' : '—'));
            /* the expand */
            var bt = r ? t('rdock.mower.on') + ' · ' + Math.round(r) : t('rdock.mower.off');
            if (cB.textContent !== bt) { cB.textContent = bt; }
            cB.dataset.state = r ? 'ok' : 'off';
            setTip(cB.parentNode, t('rdock.mower.blade') + ': ' + (r ? Math.round(r) + ' rpm' : t('rdock.mower.blade_off')));
            var ht2 = hh != null ? Math.round(hh) + ' mm' : '—';
            if (cH.textContent !== ht2) { cH.textContent = ht2; }
            setTip(cH.parentNode, t('rdock.mower.height.tip'));
            var tt = tc != null ? Math.round(tc) + ' °C' : '—';
            if (cT.textContent !== tt) { cT.textContent = tt; }
            cT.dataset.state = tc == null ? 'off' : (tc >= MOWER_TOO_HOT ? 'err' : (tc >= MOWER_HOT ? 'warn' : 'ok'));
            setTip(cT.parentNode, t('rdock.mower.temp.tip', {a: MOWER_HOT, b: MOWER_TOO_HOT}));
            ctl({on: on, status: on ? txt.toUpperCase() : '', rpm: r || 0});
            var pg = window.programs, pn = '', ps = '';
            try {
                if (pg && pg.mission_program && pg._isRunning && pg._isRunning(pg.mission_program)) {
                    pn = pg.mission_program; ps = String(pg.mission_status || '').trim();
                }
            } catch (e) { pn = ''; }
            var ptxt = pn ? t('rdock.mower.prog', {n: pn}) + (ps ? ' · ' + ps : '') : '';
            if (prog.textContent !== ptxt) { prog.textContent = ptxt; }
            prog.style.display = pn ? '' : 'none';
            setTip(prog, ptxt);
            var disp = on ? '' : 'none';
            if (sec.style.display !== disp) { sec.style.display = disp; placeSoon(); }
            if (mdot) {
                mdot.style.display = disp;
                mdot.dataset.state = state;
                mdot.title = t('rdock.sec.mower') + ': ' + (txt || '—');
                mdot.setAttribute('aria-label', mdot.title);
            }
        };
        paint();
        relang.push(paint);
        new MutationObserver(paint).observe(src, {attributes: true, attributeFilter: ['style'],
            childList: true, characterData: true, subtree: true});
        setInterval(paint, 2000);              // the running program
        return 1;
    }

    /* Start / Stop in the Mower head = the BLADE (owner 2026-10-18: "start
       / stop buttons" in the head, the blade, not the program) — exactly
       what Settings › Mower START MOTOR / STOP MOTOR do (map_view.js
       Mower): mower.pub_mower_set_motor_on(true / false) → /mower/set_motor_on.
       Start only while the mower reports READY (powered, idle, blade
       stopped); the head is clickable and the button small, so Start arms on
       the first tap (3 s) and switches the blade on with the second. Stop
       acts at once whenever the blade turns (rpm > 0 or RUN). The section —
       and so the buttons — only shows while the mower is on (not OFF/UNK). */
    function buildMowerCtl(w) {
        /* ONE blade key (owner 2026-10-19: tidy head): ▶ green = may start
           (first tap arms for 3 s, the second switches the blade on — the
           key is small in a clickable head), ■ red = the blade turns, one tap
           stops it at once, grey = not ready. Same calls as Settings › Mower
           START / STOP MOTOR: mower.pub_mower_set_motor_on(true / false). */
        var bk = el('button', 'rp-mbtn rp-mblade', w);
        bk.type = 'button';
        bk.id = 'rp_mower_blade_key';
        var armed = 0, armTimer = null, cur = {on: false, status: '', rpm: 0};
        var api = function () {
            var m = window.mower;
            return m && typeof m.pub_mower_set_motor_on === 'function' ? m : null;
        };
        var spinning = function () { return !!(cur.on && (cur.rpm > 0 || cur.status === 'RUN')); };
        var canStart = function () { return !!(api() && cur.on && cur.status === 'READY' && !spinning()); };
        var disarm = function () { armed = 0; if (armTimer) { clearTimeout(armTimer); armTimer = null; } };
        var paint = function (st) {
            if (st) { cur = st; }
            var ok = canStart(), run = spinning();
            if (!ok && armed) { disarm(); }
            var glyph = run ? '■' : '▶';
            if (bk.textContent !== glyph) { bk.textContent = glyph; }
            bk.disabled = !(run ? api() : ok);
            bk.dataset.state = run ? 'err' : (ok ? (armed ? 'arm' : 'ok') : 'off');
            var tip;
            if (run) { tip = t('rdock.mower.stop.tip') + (cur.rpm ? ' · ' + Math.round(cur.rpm) + ' rpm' : ''); }
            else if (ok) { tip = t(armed ? 'rdock.mower.start.arm' : 'rdock.mower.start.tip'); }
            else { tip = t('rdock.mower.start.notready', {s: cur.status || '—'}); }
            setTip(bk, tip);
        };
        bk.addEventListener('click', function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            var m = api();
            if (!m) { paint(); return; }
            if (spinning()) {
                try { m.pub_mower_set_motor_on(false); } catch (e) { console.warn('[right_dock] blade off failed:', e); }
                paint(); return;
            }
            if (!canStart()) { paint(); return; }
            if (!armed) {
                armed = 1;
                armTimer = setTimeout(function () { disarm(); paint(); }, 3000);
                paint(); return;
            }
            disarm();
            try { m.pub_mower_set_motor_on(true); } catch (e) { console.warn('[right_dock] blade on failed:', e); }
            paint();
        });
        relang.push(function () { paint(); });
        return paint;
    }

    // ------------------------------------------------------- GNSS souhrn
    /* The GNSS head, computed from the same /gnss_status the card shows
       (window.gnss_rx, map_view.js): Position fix · Heading fix · satellites
       used · correction-age dot (green < 2 s, amber < 10 s, red older or
       none) · › = the full card in the left panel › Map › Loc. */
    var RANK = {off: 0, ok: 1, warn: 2, err: 3};
    var SHORT = {FLOAT: 'FLT', DGNSS: 'DGN', 'NO FIX': 'NO', NONE: 'NO'};
    function gnssSummary() {
        var g = window.gnss_rx;
        var d = g && g.last, fresh = d && (Date.now() - (g.last_at || 0)) < 5000;
        if (!fresh || typeof GnssRx === 'undefined') { return null; }
        var pos = d.rx && d.rx.gnss, hdg = d.rx && d.rx.gnss_heading;
        var sp = GnssRx.fixState(pos), sh = GnssRx.fixState(hdg);
        var sv = '—', corr = '', svUsed = null, age = null, cs = 'off';
        if (pos && pos.alive) {
            var s = pos.sat, p = pos.pvt || {};
            sv = s ? s.used + '/' + s.visible : (p.num_sv != null ? String(p.num_sv) : '—');
            svUsed = s ? s.used : p.num_sv;
            var a = pos.rtcm && pos.rtcm.last_age_s;
            age = a == null ? null : a;
            corr = a == null ? t('rdock.gnss.nocorr') : (a < 10 ? a.toFixed(1) : Math.round(a)) + 's';
            cs = a == null ? 'err' : (a < 2 ? 'ok' : (a < 10 ? 'warn' : 'err'));
        }
        var worst = RANK[sp] >= RANK[sh] ? sp : sh;
        if (sp === 'off' && sh !== 'off') { worst = sh; }
        return {pos: [GnssRx.fixText(pos), sp], hdg: [GnssRx.fixText(hdg), sh],
                sv: sv, svUsed: svUsed, corr: corr, age: age, corrState: cs,
                worst: worst, posState: sp};
    }
    function shortFix(s) { s = String(s || '—'); return SHORT[s.toUpperCase()] || s; }
    function buildGnssSum(sec, h, box) {
        var wrap = el('span', 'rp-htok rp-gsum', h);
        wrap.id = 'rp_gnss_sum';
        var cp = el('span', 'vt-chip vt-chip-sm', wrap);
        var ch = el('span', 'vt-chip vt-chip-sm', wrap);
        var tx = el('span', 'rp-tv rp-gsum-t', wrap);
        var cd = tdot(wrap, 'rp-corr');
        /* level 2: Position | Heading, the quick rows only (GnssRx.quick) */
        var quick = el('div', 'rp-gq', box);
        var lastQ = '';
        var paintQ = function () {
            if (sec.classList.contains('folded') || !window.gnss_rx || !window.gnss_rx.quick) { return; }
            var q = window.gnss_rx.quick();
            if (q !== lastQ) { lastQ = q; quick.innerHTML = q; }
        };
        sec.onUnfold = paintQ;
        var gdot = panel.querySelector('#rp_sum_dot_gnss');
        var last = '';
        var paint = function () {
            var m = gnssSummary();
            var key = m ? [m.pos, m.hdg, m.sv, m.corr].join('|') : 'none';
            if (key !== last) {
                last = key;
                cp.textContent = m ? shortFix(m.pos[0]) : '—';
                cp.dataset.state = m ? m.pos[1] : 'off';
                setTip(cp, t('gnssrx.pos') + ': ' + (m ? m.pos[0] : '—'));
                ch.textContent = m ? shortFix(m.hdg[0]) : '—';
                ch.dataset.state = m ? m.hdg[1] : 'off';
                setTip(ch, t('gnssrx.hdg') + ': ' + (m ? m.hdg[0] : '—'));
                tx.textContent = m && m.svUsed != null ? String(m.svUsed) : '—';
                tx.dataset.state = m && m.svUsed != null ? (m.svUsed >= 12 ? 'ok' : 'warn') : 'off';
                setTip(tx, t('rdock.gnss.sv', {sv: m ? m.sv : '—'}));
                cd.dataset.state = m ? m.corrState : 'off';
                setTip(cd, t('gnssrx.r.corr') + ': ' + (m && m.corr ? m.corr : '—') + ' · ' + t('rdock.gnss.corr_code'));
                sec.dataset.tone = m ? m.worst : 'off';
            }
            paintQ();
            var tip = m ? t('gnssrx.pos') + ' ' + m.pos[0] + ' · ' + t('gnssrx.hdg') + ' ' + m.hdg[0] +
                ' · SV ' + m.sv + (m.corr ? ' · ' + t('gnssrx.r.corr') + ' ' + m.corr : '') : t('rdock.gnss.nodata');
            if (gdot) {
                var gs = m ? m.posState : 'off';
                if (gdot.dataset.state !== gs) { gdot.dataset.state = gs; }
                setTip(gdot, 'GNSS: ' + tip);
            }
        };
        paint();
        relang.push(function () { last = ''; lastQ = ''; paint(); });
        var card = document.getElementById('div_gnss_rx');
        if (card) { new MutationObserver(paint).observe(card, {childList: true}); }
        setInterval(paint, 2000);              // stale data → '—'
    }

    // ------------------------------------------ levý panel › Map › Loc
    /* Level 3 lives in the LEFT panel (plenty of room there): one card
       "Localization detail" at the top of Map › Loc —
         Pose & odometry  who holds the pose (+ its last changes), heading,
                          VO / Li / Wh with state + covariance, FIX / PROB,
                          anchor and the drift budget (#loc_nav_box, painted
                          here from window.odom — the same numbers the right
                          panel's chips show in their tooltips)
         Lidar tracker    map_view.js Odom builds the rows inside #div_odom,
                          they are moved here as soon as they exist
         RtabMap          the row, only while rtabmap runs
         GNSS receivers   the card of both receivers (#div_gnss_rx, GnssRx)
       Elements move with their ids, so map_view.js keeps writing into them. */
    function locHead(card, key, id) {
        var hd = el('div', 'vt-locg-h', card);
        if (id) { hd.id = id; }
        hd.textContent = t(key);
        tag(hd, key);
        return hd;
    }
    function buildLocCard() {
        var tab = document.getElementById('tab-gloc');
        if (!tab) { return; }
        var card = document.getElementById('loc_gnss_card');
        if (!card) {
            card = el('div', 'vt-card vt-mb2 vt-locg-card');
            card.id = 'loc_gnss_card';
            var head = el('div', 'vt-card-head', card);
            var ti = el('span', 'vt-card-title', head);
            ti.textContent = t('locg.title');
            tag(ti, 'locg.title');
            var sub = el('span', 'vt-end', head);
            sub.textContent = t('locg.sub');
            tag(sub, 'locg.sub');
            tab.insertBefore(card, tab.firstChild);
            locHead(card, 'locg.h.pose', 'loc_nav_box');
            var nav = el('div', 'vt-locg-nav', card);
            nav.id = 'loc_nav_rows';
            locHead(card, 'locg.h.trk', 'loc_trk_head');
            var trk = el('div', 'vt-locg-trk', card);
            trk.id = 'loc_trk_box';
            var rt = document.getElementById('div_rtabmap');
            if (rt) { neutralize(rt); card.appendChild(rt); }
            locHead(card, 'locg.h.gnss', 'loc_gnss_rx_box');
            var rx = document.getElementById('div_gnss_rx');
            if (rx) { neutralize(rx); card.appendChild(rx); }
        }
        var trkBox = document.getElementById('loc_trk_box');
        var tries = 0;
        (function moveTrk() {
            var rows = document.querySelectorAll('#right_panel .vt-trk-row');
            Array.prototype.forEach.call(rows, function (r) { trkBox.appendChild(r); });
            if (!trkBox.children.length && ++tries < 120) { setTimeout(moveTrk, 1000); }
        })();
        paintLocNav();
        relang.push(paintLocNav);
        setInterval(paintLocNav, 1000);
    }

    /* who held the pose, the last few changes (this page's lifetime) */
    var ownerHist = [], ownerLast = null;
    function trackOwner() {
        var o = window.odom && window.odom.loc;
        var fresh = o && window.odom.loc_t && Date.now() - window.odom.loc_t < 5000;
        var cur = fresh ? String(o.owner || '—') : null;
        if (cur && cur !== ownerLast) {
            if (ownerLast) {
                ownerHist.unshift({t: new Date(), from: ownerLast, to: cur});
                if (ownerHist.length > 5) { ownerHist.length = 5; }
            }
            ownerLast = cur;
        }
    }
    var TONE = {ok: 'ok', warn: 'warn', err: 'err'};
    function afterColon(s) {
        s = String(s || '');
        var i = s.indexOf(': ');
        return i >= 0 ? s.slice(i + 2) : s;
    }
    function hhmmss(d) {
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    var navLast = '';
    function paintLocNav() {
        trackOwner();
        var box = document.getElementById('loc_nav_rows');
        if (!box) { return; }
        var od = window.odom, L = od && od.loc;
        var fresh = L && od.loc_t && Date.now() - od.loc_t < 5000;
        var rows = [];
        var chipRow = function (k, id, v) {
            var e = document.getElementById(id);
            if (!e) { return; }
            rows.push([k, v != null ? v : afterColon(e.title), TONE[e.dataset.state] || 'muted', e.title]);
        };
        chipRow(t('bar.pose'), 'span_odom_drive');
        var hd = document.getElementById('span_odom_hdg');
        if (hd) {
            var ht = (hd.textContent || '').trim();
            rows.push([t('locg.r.hdg'), ht + (fresh ? ' · ' + t(L.heading_ok ? 'loc.hdg_ok' : 'loc.hdg_not_ok') : ''),
                       TONE[hd.dataset.state] || 'muted', hd.title]);
        }
        var si = (od && od.srcInfo) || {};
        [['vo', 'VO', 'span_odom_vo'], ['licp', 'Li', 'span_odom_licp'], ['wheel', 'Wh', 'span_odom_wheel']].forEach(function (d) {
            var i = si[d[0]];
            var e = document.getElementById(d[2]);
            rows.push([d[1], i ? i.txt + (i.cov ? ' · ' + t('loc.src.cov', {c: i.cov}) : '') : t('loc.src.none'),
                       i ? (TONE[i.st] || 'muted') : 'muted', e ? e.title : '']);
        });
        chipRow('FIX', 'span_odom_fix');
        chipRow('PROB', 'span_odom_prob');
        chipRow('ANC', 'span_odom_anc');
        if (fresh && (L.budget_used_m != null || L.budget_used_deg != null)) {
            rows.push([t('locg.r.budget'), (L.budget_used_m != null ? Number(L.budget_used_m).toFixed(2) + ' m' : '—') +
                       ' · ' + (L.budget_used_deg != null ? Number(L.budget_used_deg).toFixed(1) + '°' : '—'),
                       'muted', t('locg.r.budget_tip')]);
        }
        var hist = ownerHist.map(function (x) { return hhmmss(x.t) + ' ' + x.from + ' → ' + x.to; });
        var key = JSON.stringify([rows, hist]);
        if (key === navLast) { return; }
        navLast = key;
        box.innerHTML = '';
        rows.forEach(function (r) {
            var row = el('div', 'vt-gx-r', box);
            if (r[3]) { row.title = r[3]; }
            el('span', null, row).textContent = r[0];
            var b = el('b', r[2] ? 'vt-tone-' + r[2] : null, row);
            b.textContent = r[1] || '—';
        });
        var hh = el('div', 'vt-locg-hist', box);
        hh.textContent = t('locg.r.hist') + ': ' + (hist.length ? hist.join(' · ') : t('locg.r.hist_none'));
    }

    /* "Detail ›": the left panel › Map › Loc, scrolled to the block */
    function openLocTab(target) {
        var mm = window.map_menu;
        try { if (mm && mm.show_map_panel) { mm.show_map_panel(); } } catch (e) {}
        setTimeout(function () {
            var a = document.querySelector('a[href="#tab-gloc"]');
            if (a) {
                try {
                    if (window.bootstrap && bootstrap.Tab) { bootstrap.Tab.getOrCreateInstance(a).show(); }
                    else { a.click(); }
                } catch (e) { a.click(); }
            }
            var c = document.getElementById(target || 'loc_gnss_card') || document.getElementById('loc_gnss_card');
            if (c && c.scrollIntoView) { try { c.scrollIntoView({block: 'start'}); } catch (e) {} }
        }, 80);
    }

    // ------------------------------------------------------- skrýt/zobrazit
    function isOpen() { return lsGet(LS_OPEN) !== '0'; }

    /* jeden řádek jen na telefonu; na desktopu je panel vždy celý */
    // U1 kolo 6: also a landscape phone (low window), where the full panel
    // would cover most of the map
    function isCompact() {
        return (window.innerWidth < 576 || window.innerHeight < 500) && lsGet(LS_COMPACT) !== '0';
    }
    function applyCompact() {
        if (!panel) { return; }
        var c = isCompact();
        panel.classList.toggle('compact', c);
        var b = document.getElementById('rp_compact_btn');
        if (b) {
            b.textContent = c ? '▾' : '▴';
            b.title = c ? t('rdock.compact.expand') : t('rdock.compact.collapse');
            b.setAttribute('aria-label', b.title);
            b.setAttribute('aria-expanded', c ? 'false' : 'true');
        }
    }

    function setOpen(open) {
        if (!open && camLarge()) { setCamLarge(false); }   // closing the panel = camera off
        lsSet(LS_OPEN, open ? '1' : '0');
        panel.classList.toggle('closed', !open);
        handle.textContent = open ? '▸' : '◂';   // ▸ zavřít / ◂ otevřít
        panel.style.display = open ? '' : 'none';
        var btn = document.getElementById('btn_camera_show');
        var cam = document.getElementById('div_camera_view');
        if (btn && cam) {                      // zavřený panel nemá co streamovat
            if (!open && cam.style.display !== 'none' && !isBigCam()) { btn.click(); }
            else if (open && cam.style.display === 'none'
                     && lsGet('vitulus_rightpanel_cam') === '1') { btn.click(); }
        }
        if (open && cam) { lsSet('vitulus_rightpanel_cam', cam.style.display !== 'none' ? '1' : '0'); }
        place();
        paintCam();
    }

    // ------------------------------------------------------------ pozice
    function place() {
        if (!panel) { return; }
        applyCompact();
        var frame = inFrame();
        if (window.innerWidth < 576 && !frame) { placeLog(); }   // log under icons + notices
        var vw = window.innerWidth, vh = window.innerHeight;
        var joy = rectOf('joy_view');
        /* the big STOP at the foot of the right column (vt_frame.js): the
           panel ends above it like above the stick (the topmost of the two) */
        var stp = rectOf('vt_stop_big');
        if (stp && stp.top > 0 && !(joy && joy.top > 0 && joy.top < stp.top)) { joy = stp; }
        var bar = rectOf('div_bottom_menu');
        var bottomLimit = vh - 8;
        if (bar && bar.top > 0) { bottomLimit = bar.top - 6; }
        if (frame) {
            /* C frame 3: the panel hangs from the top band and ends ABOVE the
               bottom ledge (bar + small log) and the joystick, with a gap —
               the C keeps its open front */
            var lg = document.getElementById('div_log_view');
            var lr = (lg && !lg.classList.contains('log-expanded')) ? rectOf('div_log_view') : null;
            if (lr && lr.height > 0 && lr.right > vw - PANEL_W) { bottomLimit = Math.min(bottomLimit, lr.top - FRAME_GAP + 6); }
            var beside = document.body.classList.contains('vt-joy-beside-rp');
            if (beside) {
                /* the stick stands beside the column: run down to the ledge */
                bottomLimit = (lr && lr.height > 0) ? lr.top : (bar && bar.top > 0 ? bar.top : vh);
            } else if (joy && joy.top > 0) { bottomLimit = Math.min(bottomLimit, joy.top - FRAME_GAP + 6); }
            if (!beside) { bottomLimit = Math.min(bottomLimit, (bar && bar.top > 0 ? bar.top : vh) - FRAME_GAP + 6); }
        }
        /* Joystick: dokud je panel zavřený, drží si svůj roh a panel se mu
           vyhne. S otevřeným panelem se joystick posune VEDLE něj (viz
           `rp-joy-side` níž) — jinak by panelu ukrojil polovinu výšky. */
        var panelOpen = isOpen();
        if (!frame && joy && joy.top > 0 && !panelOpen) {
            bottomLimit = Math.min(bottomLimit, joy.top - 8);
        }

        /* levý drawer (agentní panel a spol.) ukrajuje šířku */
        var drawer = document.getElementById('ui_drawer');
        var drawerRight = 0;
        if (drawer && drawer.classList.contains('open')) {
            var dr = drawer.getBoundingClientRect();
            if (dr.width > 0 && dr.right > 0) { drawerRight = dr.right; }
        }
        var free = vw - drawerRight - 12;
        if (drawerRight > 0 && free < 150) {         // full / nezbývá na obsah
            panel.style.display = 'none';
            /* Úchyt zmizí JEN když drawer opravdu zabírá celou šířku (pod
               576 px je 100vw). Jinak by panel nešlo vytáhnout — přesně to se
               dělo, když drawer uvázl v půlce a `free` spadlo pod 150 px. */
            if (handle) {
                handle.style.display = (vw < 576) ? 'none' : '';
                handle.style.right = '0px';
                handle.style.top = Math.round(Math.max(46, 56)) + 'px';
            }
            return;
        }
        panel.style.display = isOpen() ? '' : 'none';
        /* Otevřený drawer ukrojí šířku: panel se zúží PŘESNĚ na to, co zbylo
           (ne na pevnou hodnotu), ať se obsah neořezává a nic nemizí pod
           panelem. Pod 150 px se schová celý (viz výše) a zbyde jen úchyt. */
        var narrow = drawerRight > 0 && free < PANEL_W + 24;
        panel.classList.toggle('narrow', narrow);
        panel.style.width = narrow ? Math.floor(free) + 'px' : '';

        var top;
        if (frame) {
            /* straight from the top band — no gap, it is the same surface. The
               notice band is centred between the left and the right panel (on a
               phone it is part of the band above), so nothing slides under. */
            var ft = frameVar('--vt-frame-top');
            top = (ft !== null) ? ft : 42;
        } else if (vw < 576) {
            /* shora: ikonky → log → panel */
            var icons = rectOf('status_div');
            var log = rectOf('div_log_view');
            top = 46;
            if (icons && icons.bottom > 0) { top = icons.bottom + 6; }
            var info2 = infoRowRect();
            if (info2) { top = Math.max(top, info2.bottom + 6); }
            if (log && log.height > 0) { top = Math.max(top, log.bottom + 6); }
        } else {
            var nav = rectOf('row_menu') || rectOf('div_menu');
            top = Math.round((nav ? nav.bottom : 42) + 8);
            /* Ikonková lišta: v širokém okně sedí v hlavičce stránky, v užším
               zůstává nad mapou — tam pod ni panel ustoupí, ať ji nepřekrývá. */
            var ic = rectOf('status_div');
            if (ic && ic.bottom > top && ic.right > window.innerWidth - PANEL_W - 24) {
                top = Math.round(ic.bottom + 6);
            }
            /* Textový řádek pod ikonkami (#span_status_info — „…for dock cmd")
               musí zůstat celý čitelný: panel začíná až pod ním. Bere se
               reálná spodní hrana, takže víc řádků textu panel posune níž. */
            var info = infoRowRect();
            if (info && info.bottom > top) { top = Math.round(info.bottom + 6); }
        }
        top = Math.max(frame ? 0 : 46, Math.min(top, bottomLimit - 60));
        panel.style.top = Math.round(top) + 'px';
        panel.style.maxHeight = Math.max(60, Math.round(bottomLimit - top)) + 'px';
        panel.style.minHeight = '';
        /* joystick vedle panelu, ať zůstane celý dosažitelný */
        var pw = (panel.offsetWidth || PANEL_W);
        /* log nesmí zabíhat pod panel — zkrátí se přesně o jeho šířku */
        setCls(document.body, 'rp-panel-open', isOpen());
        document.documentElement.style.setProperty('--rp-log-right', (pw + 14) + 'px');
        // U1 kolo 6: a collapsed one-row panel does not push the stick aside
        setCls(document.body, 'rp-joy-side', !frame && !!joy && isOpen() && !isCompact());
        document.documentElement.style.setProperty('--rp-joy-right', (pw + 14) + 'px');
        if (handle) {                       // úchyt drží hranu vedle panelu
            handle.style.display = '';
            handle.style.top = Math.round(top + (frame ? 24 : 10)) + 'px';   // C frame: below the concave corner
            handle.style.right = isOpen() ? (panel.offsetWidth || PANEL_W) + 'px' : '0px';
            /* P9: the collapsed one-row panel (phone) is shorter than the
               handle — the handle used to hang ~30 px below the row. Fit it
               into the row, under the concave corner. */
            var ph = isOpen() ? panel.offsetHeight : 0;
            if (ph && ph < 100) {
                var hh = Math.max(24, ph - (frame ? 20 : 12));
                handle.style.top = Math.round(top + (frame ? 16 : 6)) + 'px';
                handle.style.height = hh + 'px';
                handle.style.lineHeight = hh + 'px';
            } else {
                handle.style.height = '';
                handle.style.lineHeight = '';
            }
        }
        paintCam();
    }

    var placeTimer = null;
    // U1 kolo 6: THROTTLE, not debounce — the status text is rewritten on
    // every robot status message; a debounce that restarts on each one never
    // fires while messages keep coming, and the panel stayed over the notice.
    function placeSoon() {
        if (placeTimer) { return; }
        placeTimer = setTimeout(function () { placeTimer = null; place(); }, 60);
    }

    /* Malý displej: log patří pod ikonky a přes CELOU šířku (jinak by ho
       panel ořízl). map_view.js mu drží inline margin-top: calc(100vh - …),
       proto se přepisuje pravidlem s !important a offset se počítá tady. */
    var logWatched = false;   // U1 kolo 6: observers once (placeLog runs on every resize/place)
    function placeLog() {
        var info = document.getElementById('span_status_info');
        if (info && !logWatched) {
            logWatched = true;
            new MutationObserver(placeSoon).observe(info, {
                childList: true, characterData: true, subtree: true,
                attributes: true, attributeFilter: ['style']
            });
            if (window.ResizeObserver) {
                new ResizeObserver(placeSoon).observe(info);
                /* U1 kolo 6: the span is INLINE (a ResizeObserver never fires
                   for it) — watch its notice row, which grows when the text
                   wraps or when the row's side columns are moved out. */
                var nrow = info.closest ? info.closest('.row') : null;
                if (nrow) { new ResizeObserver(placeSoon).observe(nrow); }
            }
        }
        var log = document.getElementById('div_log_view');
        if (!log) { return; }
        var mobile = window.innerWidth < 576 && !inFrame();   // C frame 3: the log rises from the bottom bar
        setCls(document.body, 'rp-log-top', mobile);
        if (!mobile) { return; }
        var icons = rectOf('status_div');
        var top = icons && icons.bottom > 0 ? icons.bottom + 4 : 76;
        // U1 kolo 6: and below the notice band — the log must never cover it
        var nr = infoRowRect();
        if (nr && nr.bottom + 4 > top) { top = nr.bottom + 4; }
        document.documentElement.style.setProperty('--rp-log-top', Math.round(top) + 'px');
    }

    // ------------------------------------------------------------ kamera
    function isBigCam() {
        var cv = window.camera_view;
        return !!(cv && cv._big);
    }

    function frames() {
        /* One shared liveness test — CameraView.framesOk (map_view.js).
           naturalWidth alone stays 0 for an MJPEG stream on iOS/iPadOS
           WebKit, so the state read "waiting for signal" forever there. */
        var cv = window.camera_view;
        var img = cv && cv.camViewer && cv.camViewer.image;
        return !!(img && typeof CameraView !== 'undefined' &&
                  CameraView.framesOk(img));
    }

    function applyCamSize(w, h) {
        var cv = window.camera_view;
        if (!cv || !cv.camViewer || cv._big) { return; }
        if (Math.abs((cv.camViewer.width || 0) - w) < 8) { return; }
        cv.camViewer.width = w;
        cv.camViewer.height = h;
        try { cv.changeViewerSize_cam_view(); } catch (e) {}
        try { cv.reloadStream('rightpanel', true); } catch (e) {}
    }

    var autoPaused = false;          // stream vypnutý kvůli odrolování z dohledu
    var camAsked = 0;                // kdy jsme naposledy požádali o zapnutí

    function camButton() { return document.getElementById('btn_camera_show'); }

    /* Telefon/tablet vs. počítač — POUZE podle prstu, ne podle šířky.
       Zúžené okno na počítači je pořád počítač (majitel má okno 500 px a chce
       v něm náhled přes celou šířku), kdežto tablet na šířku má klidně 1024 px
       a výšku šetřit chce. Šířka by obojí spletla. */
    function touchLike() {
        try {
            return !!(window.matchMedia &&
                      window.matchMedia('(pointer: coarse)').matches);
        } catch (e) { return false; }
    }

    /* the Off / S / L switch and the phone's camera button show the state */
    function paintSeg(open, folded) {
        var st = (!open || folded) ? 'off' : (camLarge() ? 'large' : 'small');
        if (!panel) { return; }
        Array.prototype.forEach.call(panel.querySelectorAll('.rp-cam-opt'), function (b) {
            var on = b.getAttribute('data-cam') === st;
            setCls(b, 'on', on);
            var ap = on ? 'true' : 'false';
            if (b.getAttribute('aria-pressed') !== ap) { b.setAttribute('aria-pressed', ap); }
        });
        var q = document.getElementById('rp_sum_cam');
        if (q) {
            setCls(q, 'on', camLarge());
            var qp = camLarge() ? 'true' : 'false';
            if (q.getAttribute('aria-pressed') !== qp) { q.setAttribute('aria-pressed', qp); }
        }
    }

    /* C frame 3 — LARGE camera: the camera takes the C's hollow (vt_frame.js
       places it); the slot here shows the MAP instead (the swap). The panel
       closed or the section folded by the user = camera off. On a phone (the
       collapsed one-row panel) there is no slot: the camera is a band across
       the top of the hollow and the map stays below it. */
    function paintCamLarge(cam, slot, off, on, open, narrow, folded) {
        var compact = panel.classList.contains('compact');
        var closedByUser = panel.classList.contains('closed');
        if (closedByUser || (open && folded && !compact)) {
            setCamLarge(false);
            return;
        }
        /* the panel only stepped aside (a phone's sheet / a full drawer took
           the width): the large camera pauses and comes back with it */
        setCls(document.body, 'vt-cam-paused', !open);
        if (!open) {
            setCls(document.body, 'vt-map-mini', false);
            var b0 = camButton();
            if (b0 && on) { autoPaused = true; camAsked = 0; b0.click(); }
            return;
        }
        setCls(document.body, 'rp-cam-dock', false);
        setCls(document.body, 'rp-cam-clip', false);
        if (off) { off.style.display = 'none'; }
        var btn = camButton();
        if (!on) {                                   // (re)start the stream
            if (btn && (!camAsked || Date.now() - camAsked > 6000)) {
                camAsked = Date.now();
                autoPaused = false;
                btn.click();
            }
        } else {
            camAsked = camAsked || Date.now();
        }
        if (!on) { setCamSt('rdock.cam.st.starting', 'warn'); }
        else if (frames()) { setCamSt('rdock.cam.st.large', 'ok'); }
        else { setCamSt('rdock.cam.st.waiting', 'warn'); }
        var slotOk = !narrow && !compact && !folded;
        slot.style.display = slotOk ? 'block' : 'none';
        setCls(slot, 'idle', false);
        var mini = false;
        if (slotOk) {
            var pr = panel.getBoundingClientRect();
            var inner = slot.parentNode && slot.parentNode.clientWidth
                ? slot.parentNode.clientWidth : Math.floor(pr.width - 16);
            var w = Math.max(0, Math.floor(inner)), h = Math.round(w * 3 / 4);
            if (slot.style.width !== w + 'px') { slot.style.width = w + 'px'; }
            if (slot.style.height !== h + 'px') { slot.style.height = h + 'px'; }
            var r = slot.getBoundingClientRect();
            var root = document.documentElement.style;
            root.setProperty('--rp-cam-w', w + 'px');
            root.setProperty('--rp-cam-h', h + 'px');
            root.setProperty('--rp-cam-left', Math.round(r.left) + 'px');
            root.setProperty('--rp-cam-top', Math.round(r.top) + 'px');
            /* the map lies UNDER the panel (it lives in the page's own layer):
               the panel gets a window cut out at the slot (CSS mask) */
            root.setProperty('--rp-hole-x', Math.round(r.left - pr.left) + 'px');
            root.setProperty('--rp-hole-y', Math.round(r.top - pr.top) + 'px');
            mini = r.width > 0 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 2;
        }
        setCls(document.body, 'vt-map-mini', mini);
    }

    function setCamSt(key, state) {
        if (!camState) { return; }
        if (camState.dataset.state !== state) { camState.dataset.state = state; }
        var tip = t('rdock.sec.camera') + ': ' + t(key);
        if (camState.title !== tip) { camState.title = tip; camState.setAttribute('aria-label', tip); }
    }

    function paintCam() {
        var cam = document.getElementById('div_camera_view');
        var slot = document.getElementById('rp_cam_slot');
        var off = document.getElementById('rp_cam_off');
        if (!cam || !slot || !panel) { return; }
        var on = cam.style.display !== 'none';
        var big = isBigCam();
        var open = !panel.classList.contains('closed') && panel.style.display !== 'none';
        var narrow = panel.classList.contains('narrow');
        /* Místo pro náhled se rezervuje, i když stream zrovna neběží — jinak
           by se sekce po vypnutí „složila" a nešlo by k ní doscrollovat. */
        var camSec = panel.querySelector('.rp-sec[data-sec="camera"]');
        var folded = !!(camSec && camSec.classList.contains('folded')) || panel.classList.contains('compact');
        var eligible = !big && open && !narrow && !folded;
        var docked = on && eligible;
        paintSeg(open, folded && !panel.classList.contains('compact'));
        if (camLarge() && inFrame()) { paintCamLarge(cam, slot, off, on, open, narrow, folded); return; }
        setCls(document.body, 'vt-map-mini', false);
        setCls(document.body, 'vt-cam-paused', false);

        if (!on) { setCamSt(autoPaused ? 'rdock.cam.st.paused' : 'rdock.cam.st.off', 'off'); }
        else if (big) { setCamSt('rdock.cam.st.large', 'ok'); }
        else if (frames()) { setCamSt('rdock.cam.st.live', 'ok'); }
        else { setCamSt('rdock.cam.st.waiting', 'warn'); }
        slot.style.display = eligible ? 'block' : 'none';
        slot.classList.toggle('idle', !on);
        /* „no signal" až po chvíli marného čekání — jinak by problikávalo při
           každém rozbalení, než stream naskočí. */
        if (off) {
            var waited = camAsked && (Date.now() - camAsked > 4000);
            off.style.display = (eligible && !on && waited) ? 'flex' : 'none';
        }
        document.body.classList.toggle('rp-cam-dock', docked);
        if (!eligible) {
            document.body.classList.remove('rp-cam-clip');
            /* Sbalená (nebo jinak nezpůsobilá) sekce = stream zhasne. */
            var btn0 = camButton();
            if (btn0 && on && !big) { autoPaused = true; camAsked = 0; btn0.click(); }
            return;
        }
        if (on) { camAsked = camAsked || Date.now(); }

        /* Na počítači náhled vyplní CELOU vnitřní šířku sekce (i za cenu vyššího
           panelu — tělo pak scrolluje). Na dotykovém zařízení zůstává menší:
           tam je výška vzácná. Poměr 4:3 platí vždy a šířka se překládá i do
           streamu (applyCamSize), takže obraz je ostrý, ne roztažený. */
        var pr = panel.getBoundingClientRect();
        var slotTop = slot.getBoundingClientRect().top;
        var availH = Math.floor(pr.bottom - slotTop - 8);
        var inner = slot.parentNode && slot.parentNode.clientWidth
            ? slot.parentNode.clientWidth : Math.floor(pr.width - 16);
        var maxW = Math.max(0, Math.floor(inner));
        var w, h;
        if (touchLike()) {
            w = Math.min(DOCK_W, maxW);
            h = Math.round(w * 3 / 4);
            if (availH < h) {            // na telefonu radši menší než scroll
                h = Math.max(96, availH);
                w = Math.min(maxW, Math.round(h * 4 / 3));
                h = Math.round(w * 3 / 4);
            }
        } else {
            w = maxW;                    // plná šířka sekce
            h = Math.round(w * 3 / 4);
        }
        slot.style.width = w + 'px';
        slot.style.height = h + 'px';
        var root = document.documentElement.style;
        root.setProperty('--rp-cam-w', w + 'px');
        root.setProperty('--rp-cam-h', h + 'px');
        var r = slot.getBoundingClientRect();
        root.setProperty('--rp-cam-left', Math.round(r.left) + 'px');
        root.setProperty('--rp-cam-top', Math.round(r.top) + 'px');
        var clipped = r.bottom > pr.bottom + 2 || r.top < pr.top - 1;
        document.body.classList.toggle('rp-cam-clip', clipped && docked);
        /* Mimo viditelnou část scrollu se stream ZASTAVÍ (nejen schová), po
           doscrollování se sám vrátí — jinak by běžel naslepo a kreslil se
           přes mapu. */
        /* Jediné místo, kde se o stavu streamu rozhoduje ve způsobilé sekci:
           ořezaný = zhasnout, viditelný = rozsvítit. Auto-zapnutí je tady (ne
           před výpočtem `clipped`), jinak by se zapnutí a vypnutí přebíjely
           dokola. Žádné ruční tlačítko v panelu není. */
        var btn = camButton();
        if (btn && clipped && on && !big) {
            autoPaused = true;
            camAsked = 0;
            btn.click();
        } else if (btn && !clipped && !on && !big &&
                   (!camAsked || Date.now() - camAsked > 6000)) {
            autoPaused = false;
            camAsked = Date.now();
            btn.click();
        }
        if (docked && !clipped) { applyCamSize(w, h); }
    }

    // ------------------------------------------------------------- ostatní
    /* Název mapy: jeden řádek s ellipsis (CSS), plný text do tooltipu —
       renderActiveMapName() dává do title jen starý „legacy" název. */
    function wireMapName() {
        var span = document.getElementById('span_status_map_name');
        if (!span) { return; }
        var host = document.getElementById('div_status_map_name');
        var busy = false;
        function paint() {
            if (busy) { return; }
            busy = true;
            try {
                var full = (span.textContent || '').trim();
                var legacy = (span.getAttribute('data-legacy') || '').trim();
                var t = full + (legacy && legacy !== full ? ' (' + legacy + ')' : '');
                if (span.title !== t) { span.title = t; }
                if (host && host.title !== t) { host.title = t; }
            } finally { busy = false; }
        }
        new MutationObserver(paint).observe(span, {
            childList: true, characterData: true, subtree: true,
            attributes: true, attributeFilter: ['data-legacy']
        });
        paint();
    }

    /* ------------------------------------------------------------------
       Zaseknutý přechod draweru — celostránková pojistka.

       Chrome tu občas nechá CSSTransition na `transform` ve stavu `running`,
       která se nikdy neposune (currentTime 0, throttlovaný kompozitor). Drawer
       pak visí půlkou mimo obrazovku (naměřeno: třída `open`, ale
       translateX(-131,9)), přes okno zůstane backdrop a `place()` spočítá, že
       na panel nezbývá místo, takže ho i s úchytem schová.

       Agentní panel má vlastní `settleDrawer()`, ale ten běží jen když drawer
       otevře agent. Tady se hlídá bez ohledu na to, kdo ho otevřel — proto to
       sedí v right_dock.js, který se načítá vždy.

       rAF SÁM NESTAČÍ: při throttlovaném kompozitoru se nespustí. Proto rAF
       i časovače. */
    function settleDrawer() {
        var el = document.getElementById('ui_drawer');
        if (!el || !el.getAnimations) { return; }
        var runs = 0;
        function settle() {
            var stuck = 0;
            try {
                el.getAnimations().forEach(function (a) {
                    if (a.playState === 'running' &&
                        (!a.startTime || !a.currentTime || a.currentTime < 16)) {
                        try { a.finish(); stuck++; } catch (e) {}
                    }
                });
            } catch (e) {}
            /* Backdrop nesmí přežít zavřený drawer: ztmavil by celé okno nad
               mapou i panelem. */
            var back = document.getElementById('ui_drawer_backdrop');
            if (back && back.style.display !== 'none' && !isDrawerOpen()) {
                back.style.display = 'none';
            }
            if (stuck) { place(); }
            if (++runs === 1) { requestAnimationFrame(settle); }
        }
        requestAnimationFrame(function () { requestAnimationFrame(settle); });
        setTimeout(settle, 120);
        setTimeout(settle, 500);
    }

    function isDrawerOpen() {
        var el = document.getElementById('ui_drawer');
        if (!el || !el.classList.contains('open')) { return false; }
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.right > 0;
    }

    /* tiny API for the frame (vt_frame.js) */
    window.VtRightDock = {
        place: function () { placeSoon(); },
        openLoc: openLocTab,
        /* large camera asked for: open the panel and unfold the Camera section */
        reveal: function () {
            if (!panel) { return; }
            if (!isOpen()) { setOpen(true); }
            var sec = panel.querySelector('.rp-sec[data-sec="camera"]');
            var h = sec && sec.querySelector('h5');
            if (sec && sec.classList.contains('folded') && h) { h.click(); }
        }
    };

    function init() {
        if (document.getElementById('right_panel')) { return; }
        build();
        buildLocCard();
        setOpen(isOpen());
        placeLog();
        place();
        wireMapName();
        if (window.VTI18n) {
            VTI18n.onChange(function () {
                relang.forEach(function (fn) { fn(); });
                applyCompact();
                paintCam();
            });
        }

        window.addEventListener('resize', function () { placeLog(); placeSoon(); });
        // web fonts / late layout change line heights after the first place()
        window.addEventListener('load', placeSoon);
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(placeSoon); }
        var cam = document.getElementById('div_camera_view');
        if (cam) {
            new MutationObserver(paintCam)
                .observe(cam, {attributes: true, attributeFilter: ['style']});
        }
        var joy = document.getElementById('joy_view');
        if (joy) {
            new MutationObserver(place)
                .observe(joy, {attributes: true, attributeFilter: ['style']});
        }
        var drawer = document.getElementById('ui_drawer');
        if (drawer) {
            new MutationObserver(function () {
                settleDrawer();               // ať neuvázne v půlce
                place();
                setTimeout(place, 260);       // po animaci draweru
            }).observe(drawer, {attributes: true, attributeFilter: ['class', 'style']});
        }
        settleDrawer();                       // i stav zděděný po startu stránky
        setTimeout(settleDrawer, 900);        // drawer obnovený z localStorage
        var info = document.getElementById('span_status_info');
        if (info) {
            new MutationObserver(placeSoon).observe(info, {
                childList: true, characterData: true, subtree: true,
                attributes: true, attributeFilter: ['style']
            });
            if (window.ResizeObserver) {
                new ResizeObserver(placeSoon).observe(info);
                /* U1 kolo 6: the span is INLINE (a ResizeObserver never fires
                   for it) — watch its notice row, which grows when the text
                   wraps or when the row's side columns are moved out. */
                var nrow = info.closest ? info.closest('.row') : null;
                if (nrow) { new ResizeObserver(placeSoon).observe(nrow); }
            }
        }
        var log = document.getElementById('div_log_view');
        if (log) {
            new MutationObserver(function () { placeLog(); placeSoon(); })
                .observe(log, {attributes: true, attributeFilter: ['style']});
        }
        var rpBody = document.getElementById('rp_body');
        if (rpBody) {                        // scroll v panelu posouvá i náhled
            rpBody.addEventListener('scroll', paintCam, {passive: true});
        }
        setInterval(paintCam, 2000);          // 'čeká na signál' → 'živě'
        setTimeout(function () { placeLog(); place(); }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 300); });
    } else {
        setTimeout(init, 300);
    }
})();
