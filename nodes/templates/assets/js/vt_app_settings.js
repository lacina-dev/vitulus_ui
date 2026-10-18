/* vt_app_settings.js — Settings › App: settings of this application (the UI
 * itself), not of the robot. Language, the agent panel, the Support (field)
 * panel and the display — every item reads and writes the SAME key the
 * owning module already uses, so the UI and this tab never disagree.
 *
 * Nothing here talks to ROS or moves the robot. The language goes to the
 * robot's ui_settings (vt_i18n.js); everything else stays in this browser's
 * localStorage, exactly as before.
 *
 * Adding an item (any module, before or after this file loads):
 *
 *     VTAppSettings.add('agent', {
 *         id: 'agent_density',              // unique; used for the DOM id
 *         label: 'app.agent.density',       // i18n key (en.js + cs.js)
 *         hint: 'app.agent.scope.hint',     // optional i18n key
 *         type: 'seg',                      // seg | select | text | info | custom
 *         options: [['', 'app.agent.density.comfortable'], ['compact', '…']],
 *         get: function () { return value; },
 *         set: function (value) { ... }     // seg / select / text
 *         render: function (host) { ... }   // custom / info: fill host
 *     });
 *
 * Sections: VTAppSettings.section(id, titleKey, metaKey) adds one (the four
 * built-in ones: lang, agent, field, display). Texts are i18n keys and the
 * tab re-renders on every language switch.
 */
(function () {
    'use strict';
    var I = window.VTI18n;
    function t(k, v) { return I ? I.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined && text !== null) { e.textContent = text; }
        return e;
    }

    var sections = [], items = {}, host = null, langNote = null;

    function section(id, titleKey, metaKey) {
        if (!items[id]) { sections.push({ id: id, title: titleKey, meta: metaKey }); items[id] = []; }
        render();
    }
    function add(sec, item) {
        if (!items[sec]) { section(sec, 'app.' + sec + '.title'); }
        items[sec] = items[sec].filter(function (x) { return x.id !== item.id; });
        items[sec].push(item);
        render();
    }

    /* ------------------------------------------------------------ views */
    function segRow(it) {
        var g = el('div', 'btn-group btn-group-sm vt-seg');
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', t(it.label));
        var val = it.get();
        it.options.forEach(function (o) {
            var b = el('button', 'btn btn-primary', o[2] ? o[1] : t(o[1]));   // o[2]: literal (language names)
            b.type = 'button';
            b.id = 'btn_app_' + it.id + '_' + (o[0] || 'default');
            var on = String(val) === String(o[0]);
            b.classList.toggle('vt-sel', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.addEventListener('click', function () {
                if (String(it.get()) === String(o[0])) { return; }
                it.set(o[0]);
                render();
            });
            g.appendChild(b);
        });
        return g;
    }
    function selectRow(it) {
        var s = el('select', 'form-select form-select-sm vt-select');
        s.id = 'select_app_' + it.id;
        s.setAttribute('aria-label', t(it.label));
        var val = String(it.get());
        it.options.forEach(function (o) {
            var op = el('option', null, o[2] ? o[1] : t(o[1]));
            op.value = o[0];
            if (String(o[0]) === val) { op.selected = true; }
            s.appendChild(op);
        });
        s.addEventListener('change', function () { it.set(s.value); render(); });
        return s;
    }
    function textRow(it) {
        var g = el('div', 'input-group input-group-sm vt-field');
        var inp = el('input', 'form-control');
        inp.type = 'text'; inp.id = 'input_app_' + it.id;
        inp.maxLength = it.maxLength || 60;
        inp.value = it.get() || '';
        if (it.placeholder) { inp.placeholder = t(it.placeholder); }
        inp.setAttribute('aria-label', t(it.label));
        var b = el('button', 'btn btn-primary', t('app.save'));
        b.type = 'button';
        var msg = el('span', 'vt-msg vt-ok-text');
        function save() {
            it.set(inp.value.trim());
            msg.textContent = t('app.saved');
            setTimeout(function () { msg.textContent = ''; }, 2500);
        }
        b.addEventListener('click', save);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { save(); } });
        g.appendChild(inp); g.appendChild(b);
        var w = el('div'); w.appendChild(g); w.appendChild(msg);
        return w;
    }
    function itemEl(it) {
        var box = el('div', 'vt-app-item');
        box.setAttribute('data-item', it.id);
        if (it.label) { box.appendChild(el('span', 'vt-label', t(it.label))); }
        if (it.type === 'seg') { box.appendChild(segRow(it)); }
        else if (it.type === 'select') { box.appendChild(selectRow(it)); }
        else if (it.type === 'text') { box.appendChild(textRow(it)); }
        else if (it.render) { var h = el('div'); it.render(h); box.appendChild(h); }
        if (it.hint) { box.appendChild(el('div', 'vt-app-hint', t(it.hint))); }
        return box;
    }
    function render() {
        if (!host) { return; }
        host.textContent = '';
        var stack = el('div', 'vt-stack');
        sections.forEach(function (s) {
            var list = (items[s.id] || []).filter(function (it) { return !it.when || it.when(); });
            if (!list.length) { return; }
            var c = el('div', 'vt-card vt-app-sec');
            c.setAttribute('data-sec', s.id);
            var head = el('div', 'vt-card-head');
            head.appendChild(el('span', 'vt-card-title', t(s.title)));
            if (s.meta) { head.appendChild(el('span', 'vt-end', t(s.meta))); }
            c.appendChild(head);
            var body = el('div', 'vt-app-items');
            list.forEach(function (it) { body.appendChild(itemEl(it)); });
            c.appendChild(body);
            stack.appendChild(c);
        });
        host.appendChild(stack);
    }

    /* ------------------------------------------------- built-in items */
    section('lang', 'app.lang.title', 'app.lang.meta');
    section('agent', 'app.agent.title', 'app.local');
    section('field', 'app.field.title', 'app.local');
    section('display', 'app.display.title', 'app.display.meta');

    /* Language — on the robot (every device), copy in this browser */
    add('lang', {
        id: 'lang', label: 'app.lang.label', type: 'seg',
        options: (I ? I.langs() : [{ code: 'en', name: 'English' }]).map(function (l) { return [l.code, l.name, true]; }),
        get: function () { return I ? I.lang() : 'en'; },
        set: function (v) {
            if (!I) { return; }
            langNote = { state: 'saving' };
            I.setLang(v).then(function (r) {
                langNote = r.saved === 'robot' ? { state: 'robot' } : { state: 'device', error: r.error };
                render();
            });
        }
    });
    add('lang', {
        id: 'lang_state', type: 'info',
        render: function (h) {
            var n = langNote || { state: I && I.serverLang() ? 'robot' : 'default' };
            var key = { saving: 'app.lang.saving', robot: 'app.lang.saved_robot', device: 'app.lang.saved_device',
                        'default': 'app.lang.default' }[n.state];
            var p = el('div', 'vt-app-hint' + (n.state === 'device' ? ' vt-tone-warn' : ''), t(key));
            if (n.error) { p.title = n.error; }
            h.appendChild(p);
        },
        hint: 'app.lang.hint'
    });

    /* Agent panel — the keys agent_chat.js uses */
    function clickIf(id) { var b = document.getElementById(id); if (b) { b.click(); return true; } return false; }
    add('agent', {
        id: 'agent_density', label: 'app.agent.density', type: 'seg',
        options: [['', 'app.agent.density.comfortable'], ['compact', 'app.agent.density.compact']],
        get: function () { return lsGet('vitulus_agent_density') === 'compact' ? 'compact' : ''; },
        // the panel's own ▤ button toggles the class AND writes the key
        set: function (v) { if (!clickIf('vagent_density')) { lsSet('vitulus_agent_density', v); } }
    });
    add('agent', {
        id: 'agent_scope', label: 'app.agent.scope', hint: 'app.agent.scope.hint', type: 'seg',
        options: [['all', 'app.agent.scope.all'], ['mine', 'app.agent.scope.mine']],
        get: function () { return lsGet('vitulus_agent_scope') === 'mine' ? 'mine' : 'all'; },
        set: function (v) { if (!clickIf('vagent_scope')) { lsSet('vitulus_agent_scope', v); } }
    });
    add('agent', {
        id: 'agent_tab', label: 'app.agent.tab', hint: 'app.remembered', type: 'select',
        options: [['chat', 'app.agent.tab.chat'], ['work', 'app.agent.tab.work'], ['activity', 'app.agent.tab.activity'],
                  ['findings', 'app.agent.tab.findings'], ['robot', 'app.agent.tab.robot'], ['models', 'app.agent.tab.models']],
        get: function () { return lsGet('vitulus_agent_tab') || 'chat'; },
        set: function (v) {
            if (window.VAgent && VAgent.activateTab) { VAgent.activateTab(v); }   // writes the key itself
            lsSet('vitulus_agent_tab', v);
        }
    });

    /* Support (field kit) panel */
    function author() { return String(lsGet('vitulus_agent_author') || lsGet('vitulus_ui_author') || '').replace(/^"|"$/g, '').trim(); }
    add('field', {
        id: 'ui_author', label: 'app.field.name', hint: 'app.field.name.hint', type: 'text',
        placeholder: 'app.field.name.placeholder', maxLength: 60,
        get: author,
        set: function (v) {
            lsSet('vitulus_ui_author', v);
            // vt_needs.js prefers the agent's name when the browser has one: keep both the same
            if (lsGet('vitulus_agent_author') !== null) { lsSet('vitulus_agent_author', v); }
        }
    });
    add('field', {
        id: 'support_tab', label: 'app.field.tab', hint: 'app.remembered', type: 'select',
        options: [['issues', 'app.field.tab.issues'], ['releases', 'app.field.tab.releases'],
                  ['signal', 'app.field.tab.signal'], ['help', 'app.field.tab.help']],
        get: function () { return lsGet('vitulus_support_tab') || 'issues'; },
        set: function (v) { lsSet('vitulus_support_tab', v); }
    });
    add('field', {
        id: 'ui_writes', label: 'app.field.writes', type: 'info',
        render: function (h) {
            var e = window.VTHub && VTHub.get('ui.actions');
            var on = e && e.data ? !!e.data.writes : null;
            var row = el('div', 'vt-row');
            row.appendChild(el('span', 'vt-pill', on === null ? t('app.field.writes.unknown') : t(on ? 'app.field.writes.on' : 'app.field.writes.off')));
            if (on !== null) { row.lastChild.setAttribute('data-state', on ? 'ok' : 'off'); }
            var a = el('a', 'btn btn-sm btn-outline-info', t('app.field.dashboard'));
            a.href = 'https://' + location.hostname + ':8790/'; a.target = '_blank'; a.rel = 'noopener';
            row.appendChild(a);
            h.appendChild(row);
        },
        hint: 'app.field.writes.hint'
    });

    /* Display — what the UI remembers on this device and shows at the next start */
    add('display', {
        id: 'log_start', label: 'app.display.log', type: 'seg',
        options: [['hidden', 'app.display.log.hidden'], ['small', 'app.display.log.small'], ['full', 'app.display.log.full']],
        get: function () {
            if (lsGet('vitulus_hud_log') !== '1') { return 'hidden'; }
            return lsGet('vitulus_log_expanded') === '1' ? 'full' : 'small';
        },
        set: function (v) {
            lsSet('vitulus_hud_log', v === 'hidden' ? '0' : '1');
            lsSet('vitulus_log_expanded', v === 'full' ? '1' : '0');
        }
    });
    add('display', {
        id: 'log_mode', label: 'app.display.logmode', type: 'seg',
        options: [['status', 'app.display.logmode.status'], ['rosout', 'app.display.logmode.rosout']],
        get: function () { return lsGet('vitulus_log_mode') === 'rosout' ? 'rosout' : 'status'; },
        set: function (v) { lsSet('vitulus_log_mode', v); }
    });
    add('display', {
        id: 'cam_large', label: 'app.display.camera', type: 'seg',
        options: [['0', 'app.display.camera.small'], ['1', 'app.display.camera.large']],
        get: function () { return lsGet('vitulus_cam_large') === '1' ? '1' : '0'; },
        set: function (v) { lsSet('vitulus_cam_large', v); }
    });
    add('display', {
        id: 'joy', label: 'app.display.joy', type: 'seg',
        options: [['0', 'app.off'], ['1', 'app.on']],
        get: function () { return lsGet('vitulus_hud_joy') === '1' ? '1' : '0'; },
        set: function (v) { lsSet('vitulus_hud_joy', v); }
    });
    add('display', {
        id: 'follow', label: 'app.display.follow', type: 'seg',
        options: [['map', 'app.display.follow.map'], ['robot', 'app.display.follow.robot']],
        get: function () { return lsGet('vitulus_follow') === 'robot' ? 'robot' : 'map'; },
        set: function (v) { lsSet('vitulus_follow', v); }
    });
    add('display', {
        id: 'rp_compact', label: 'app.display.compact', hint: 'app.display.compact.hint', type: 'seg',
        options: [['1', 'app.display.compact.on'], ['0', 'app.display.compact.off']],
        get: function () { return lsGet('vitulus_rightpanel_compact') === '0' ? '0' : '1'; },
        set: function (v) { lsSet('vitulus_rightpanel_compact', v); }
    });

    /* ------------------------------------------------------------ boot */
    function init() {
        host = document.getElementById('div_app_settings');
        if (!host) { return; }
        render();
        // re-read on every open of the tab: the values follow what was done elsewhere
        var link = document.querySelector('a[href="#tab_app"]');
        if (link) { link.addEventListener('shown.bs.tab', render); }
        if (I) { I.onChange(render); }
        if (window.VTHub) { VTHub.on('ui.actions', function () { var a = document.getElementById('tab_app'); if (a && a.classList.contains('active')) { render(); } }); }
    }
    window.VTAppSettings = { add: add, section: section, render: render };
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})();
