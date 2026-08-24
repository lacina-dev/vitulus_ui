/* right_dock.js — JEDEN pravý panel mapového pohledu (2026-08-23).
 *
 * Levý drawer patří agentnímu panelu, takže všechno, co bylo vpravo (a vlevo)
 * roztroušené jako plovoucí panýlky, žije tady v jednom panelu ukotveném
 * k pravému hornímu rohu:
 *
 *   1. Pohyb a dok — rychlost (Slow/Mid/Fast), klávesnicový teleop,
 *      baterie + Dock/Undock/Stop
 *   2. Stav        — sekačka (když běží), Pose/VO/Li/Wh/FIX, GNSS, RtabMap
 *   3. Mapa        — follow (Map/robot) + název aktivní mapy
 *   4. Kamera      — malý živý náhled
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
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    var LS_OPEN = 'vitulus_rightpanel_open';
    var DOCK_W = 216, DOCK_H = 162;      // náhled kamery (4:3 jako zdroj 160×120)
    var PANEL_W = 196;

    /* Názvy sekcí anglicky (přání majitele) a KAŽDÁ sekce je sbalitelná —
       stav si drží každá zvlášť v localStorage, takže přežije reload. */
    var SECTIONS = [
        {id: 'drive', title: 'Controls',
         /* rychlost + klávesnicový teleop na JEDEN řádek (ušetřený řádek) */
         line: ['div_status_speed', 'div_status_speed-1'],
         movees: ['div_status_speed-2'], collapsible: true},
        {id: 'state', title: 'Navi',
         movees: ['div_mower_info_panel', 'div_odom', 'div_gnss', 'div_rtabmap'],
         collapsible: true},
        {id: 'camera', title: 'Camera', movees: [], camera: true, collapsible: true}
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
        handle.title = 'Skrýt / zobrazit pravý panel';
        handle.setAttribute('aria-label', 'Skrýt / zobrazit pravý panel');
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
        var fico = document.getElementById('div_status_follow_ico');
        if (fico) {
            fico.classList.add('rp-click');
            fico.title = 'Přepnout sledování (mapa / robot)';
            fico.addEventListener('click', function () {
                var b = document.getElementById('btn_follow');
                if (b) { b.click(); }
            });
        }

        SECTIONS.forEach(function (def) {
            var sec = el('section', 'rp-sec', body);
            sec.setAttribute('data-sec', def.id);
            var h = el('h5', null, sec);
            h.textContent = def.title;
            if (def.collapsible) {
                var lsKey = 'vitulus_rightpanel_sec_' + def.id;
                h.classList.add('rp-click');
                var caret = el('span', 'rp-caret', h);
                var openSec = lsGet(lsKey) !== '0';
                sec.classList.toggle('folded', !openSec);
                caret.textContent = openSec ? '▾' : '▸';
                h.addEventListener('click', function () {
                    var now = !sec.classList.contains('folded');
                    sec.classList.toggle('folded', now);     // now = bude sbaleno
                    caret.textContent = now ? '▸' : '▾';
                    lsSet(lsKey, now ? '0' : '1');
                    place();
                    paintCam();
                });
            }
            var box = el('div', 'rp-sec-body', sec);
            var moved = 0;
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
            def.movees.forEach(function (id) {
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
            if (def.camera) {
                camState = el('span', 'rp-state', h);
                var slot = el('div', 'rp-cam-slot', box);
                slot.id = 'rp_cam_slot';
                /* Žádné ruční zapínání: stream se rozjede rozbalením sekce a
                   zhasne jejím sbalením (viz paintCam). Prázdný stav proto jen
                   konstatuje, nic nenabízí — a místo pro náhled zůstává
                   rezervované, ať výška neposkakuje. */
                var off = el('div', 'rp-cam-off', box);
                off.id = 'rp_cam_off';
                off.textContent = 'no signal';
                moved = 1;
            }
            if (!moved) { sec.remove(); }
        });

        document.body.appendChild(panel);
        handle.addEventListener('click', function () { setOpen(!isOpen()); });
    }

    // ------------------------------------------------------- skrýt/zobrazit
    function isOpen() { return lsGet(LS_OPEN) !== '0'; }

    function setOpen(open) {
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
        var vw = window.innerWidth, vh = window.innerHeight;
        var joy = rectOf('joy_view');
        var bar = rectOf('div_bottom_menu');
        var bottomLimit = vh - 8;
        if (bar && bar.top > 0) { bottomLimit = bar.top - 6; }
        /* Joystick: dokud je panel zavřený, drží si svůj roh a panel se mu
           vyhne. S otevřeným panelem se joystick posune VEDLE něj (viz
           `rp-joy-side` níž) — jinak by panelu ukrojil polovinu výšky. */
        var panelOpen = isOpen();
        if (joy && joy.top > 0 && !panelOpen) {
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
        if (vw < 576) {
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
        top = Math.max(46, Math.min(top, bottomLimit - 60));
        panel.style.top = Math.round(top) + 'px';
        panel.style.maxHeight = Math.max(60, Math.round(bottomLimit - top)) + 'px';
        /* joystick vedle panelu, ať zůstane celý dosažitelný */
        var pw = (panel.offsetWidth || PANEL_W);
        /* log nesmí zabíhat pod panel — zkrátí se přesně o jeho šířku */
        document.body.classList.toggle('rp-panel-open', isOpen());
        document.documentElement.style.setProperty('--rp-log-right', (pw + 14) + 'px');
        document.body.classList.toggle('rp-joy-side', !!joy && isOpen());
        document.documentElement.style.setProperty('--rp-joy-right', (pw + 14) + 'px');
        if (handle) {                       // úchyt drží hranu vedle panelu
            handle.style.display = '';
            handle.style.top = Math.round(top + 10) + 'px';
            handle.style.right = isOpen() ? (panel.offsetWidth || PANEL_W) + 'px' : '0px';
        }
        paintCam();
    }

    var placeTimer = null;
    function placeSoon() {
        if (placeTimer) { clearTimeout(placeTimer); }
        placeTimer = setTimeout(place, 150);
    }

    /* Malý displej: log patří pod ikonky a přes CELOU šířku (jinak by ho
       panel ořízl). map_view.js mu drží inline margin-top: calc(100vh - …),
       proto se přepisuje pravidlem s !important a offset se počítá tady. */
    function placeLog() {
        var info = document.getElementById('span_status_info');
        if (info) {
            new MutationObserver(placeSoon).observe(info, {
                childList: true, characterData: true, subtree: true,
                attributes: true, attributeFilter: ['style']
            });
            if (window.ResizeObserver) {
                new ResizeObserver(placeSoon).observe(info);
            }
        }
        var log = document.getElementById('div_log_view');
        if (!log) { return; }
        var mobile = window.innerWidth < 576;
        document.body.classList.toggle('rp-log-top', mobile);
        if (!mobile) { return; }
        var icons = rectOf('status_div');
        var top = icons && icons.bottom > 0 ? icons.bottom + 4 : 76;
        document.documentElement.style.setProperty('--rp-log-top', Math.round(top) + 'px');
    }

    // ------------------------------------------------------------ kamera
    function isBigCam() {
        var cv = window.camera_view;
        return !!(cv && cv._big);
    }

    function frames() {
        var cv = window.camera_view;
        return !!(cv && cv.camViewer && cv.camViewer.image &&
                  cv.camViewer.image.naturalWidth > 0);
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
        var folded = !!(camSec && camSec.classList.contains('folded'));
        var eligible = !big && open && !narrow && !folded;
        var docked = on && eligible;

        if (camState) {
            camState.textContent = !on ? (autoPaused ? 'paused' : 'off')
                : big ? 'large' : (frames() ? 'live' : 'waiting for signal');
        }
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

    function init() {
        if (document.getElementById('right_panel')) { return; }
        build();
        setOpen(isOpen());
        placeLog();
        place();
        wireMapName();

        window.addEventListener('resize', function () { placeLog(); placeSoon(); });
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
