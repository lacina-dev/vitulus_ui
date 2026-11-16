#!/usr/bin/env node
/*
 * T8 dávka V: the robot's status lines (/nextion/log_info) in the UI's language.
 *
 *     node tools/test_robot_text.node.js [status_log.jsonl]
 *
 * The robot writes English (dock_smach, mower_smach, navi_man, exe_goal, safety_node,
 * weather_alert, the GPS watchdog, the agent). vt_autonomy.js robotLine() turns a line
 * of a known pattern into auto.line.<code> with its numbers / names; the notice line
 * (vt_notice.js) and the log strip (map_view.js StatusLog) show that.
 * 1) every pattern's key is in en + cs with the same {placeholders} as its captures;
 * 2) real lines of the robot (status_log.jsonl 2026-05…11) come out in Czech, names and
 *    numbers kept, wheels / speeds as words; an unknown line stays raw (null);
 * 3) the notice keeps the English original and re-translates on a language switch;
 *    the log strip translates only the robot's lines (numeric seq), never the agent's text;
 * 4) (with a status_log.jsonl argument or ~/.ros/vitulus_status_log) a coverage report;
 * 5) the other raw words: rain radar steps (UNAVAILABLE…), the mower's states (RUN, WAIT…) and the
 *    device state INVALID (silent board) in words; the blade start still decides by the code.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
let fails = 0;
function check(what, cond, info) { if (cond) { console.log('ok   ' + what); } else { fails++; console.log('FAIL ' + what + (info ? ' — ' + info : '')); } }

const D = {};
for (const lang of ['en', 'cs']) {
    const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(read('i18n/' + lang + '.js'), ctx);
    D[lang] = ctx.window.VT_I18N_DICT[lang];
}
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
const AU = read('vt_autonomy.js');
const a = AU.indexOf('    var LINES = ['), b = AU.indexOf('/* ------------------------------------------------- hard reset */');
check('robotLine section found in vt_autonomy.js', a > 0 && b > a);
let LANG = 'cs';
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m0, k) => (v && k in v ? v[k] : m0));
const ctx = { t: (k, v) => (k in D[LANG] ? fill(D[LANG][k], v) : (k in D.en ? fill(D.en[k], v) : k)) };
vm.createContext(ctx);
vm.runInContext(AU.slice(a, b) + '\nthis.robotLine = robotLine; this.ROBOT_TEXT = ROBOT_TEXT;', ctx);
const RT = ctx.ROBOT_TEXT;
check('ROBOT_TEXT has the known forms (>= 150 patterns)', RT.length >= 150, String(RT.length));

// 1) keys + placeholders
{
    const bad = [];
    RT.forEach(([re, code, names]) => {
        const k = 'auto.line.' + code, want = (names || []).map((n) => '{' + n + '}').sort().join(',');
        if (!(k in D.en) || !(k in D.cs)) { bad.push(k + ' missing'); return; }
        if (ph(D.en[k]) !== want && code !== 'map' && code !== 'map_ready') { bad.push(k + ' en ' + ph(D.en[k]) + ' != ' + want); }
        if (ph(D.cs[k]) !== ph(D.en[k])) { bad.push(k + ' cs placeholders'); }
        const groups = new RegExp(re.source + '|').exec('').length - 1;
        if (groups !== (names || []).length) { bad.push(code + ': ' + groups + ' groups, ' + (names || []).length + ' names'); }
    });
    check('every pattern: key in en + cs, placeholders = its captures', !bad.length, bad.slice(0, 5).join('; '));
}

// 2) real lines
const CASES = [
    ['Waiting for dock cmd', 'Čekám na příkaz doku'],
    ['Executing goal.', 'Jedu k cíli'],
    ['Goal canceled', 'Cíl zrušen'],
    ['Stopping docking', 'Zastavuji dokování'],
    ['3DFIX acquired', 'GPS: získán 3D fix'],
    ['RTK FIX acquired', 'RTK fix získán'],
    ['RTK fix acquired', 'RTK fix získán'],
    ['Rain now 22%.', 'Déšť teď: 22 %'],
    ['Navigating to DOCK', 'Jedu na bod DOCK'],
    ['Navigating to dock', 'Jedu k doku'],
    ['ZoneA: go to path 3/12', 'ZoneA: jedu na trasu 3/12'],
    ['Test_ prejizdeni: path 2/5 chunk done', 'Test_ prejizdeni: úsek trasy 2/5 hotový'],
    ['ZoneVinoPodelne: path 4/9 done', 'ZoneVinoPodelne: trasa 4/9 hotová'],
    ['Detouring around obstacle (35 cm ahead)', 'Objíždím překážku (35 cm před robotem)'],
    ['Waiting for RTK: main RTK, heading 3DFIX - 1:20 / 5:00, after a reboot usually ~3 min',
     'Čekám na RTK: hlavní RTK, kurz 3DFIX – 1:20 / 5:00, po restartu obvykle ~3 min'],
    ['[SAFETY] Motor failure: FRONT_LEFT (timeout), REAR_RIGHT (no data). Motors OFF.',
     '[BEZPEČNOST] Porucha motoru pohonu: přední levý (neodpovídá), zadní pravý (bez dat). Motory VYPNUTY.'],
    ['[SAFETY] Motor failure: FRONT_RIGHT (fault: MOTOR_DRV_FAULT). Motors OFF.', '[BEZPEČNOST] Porucha motoru pohonu: přední pravý (porucha budiče). Motory VYPNUTY.'],
    ['Set speed: SLOW', 'Rychlost: pomalu'],
    ['Agent: task done', 'Agent: úkol hotový'],
    ['Agent: driving path ZONA_A_Path', 'Agent: jedu po trase ZONA_A_Path'],
    ['TEST renamed to Zkouška bod', 'TEST přejmenováno na Zkouška bod'],
    ['Point wp_3 added', 'Bod wp_3 přidán'],
    ['Stopped. Resume via /mower_smach/reset.', 'Zastaveno. Pokračuj přes /mower_smach/reset.'],
    ['Heading nudge done: 1.48 m', 'Popojetí pro kurz hotové (1.48 m), čekám na kurz'],
    ['ZoneA done, next: Test', 'ZoneA hotovo, další: Test'],
    ['Mission stopped. Press Reset, then Run to continue.', 'Mise zastavena. Pokračuj tlačítkem Reset a potom Run.'],
];
LANG = 'cs';
const wrong = CASES.filter(([raw, want]) => ctx.robotLine(raw) !== want).map(([raw, want]) => raw + ' -> ' + ctx.robotLine(raw) + ' (want ' + want + ')');
check('cs: ' + CASES.length + ' real robot lines translated, names / numbers kept', !wrong.length, wrong.slice(0, 4).join(' | '));
LANG = 'en';
check('en: an English line stays English ("Executing goal." -> "Driving to the goal")', ctx.robotLine('Executing goal.') === 'Driving to the goal');
check('en: "Agent: task done" stays itself', ctx.robotLine('Agent: task done') === 'Agent: task done');
LANG = 'cs';
check('unknown line -> null (shown raw)', ctx.robotLine('Something the UI never heard of 42') === null && ctx.robotLine('') === null);
check('unknown speed / wheel word stays raw', ctx.robotLine('Set speed: TURBO') === 'Rychlost: TURBO'
      && ctx.robotLine('[SAFETY] Motor failure: MID_AXLE (smoke). Motors OFF.') === '[BEZPEČNOST] Porucha motoru pohonu: MID_AXLE (smoke). Motory VYPNUTY.');
// V-b: the master's diary, the reasons after a colon, the reset's second sentence
const MASTER = [
    ['[Master] Settings changed by owner: sleep_ignore_ui.', /^\[Plánovač\] Nastavení změnil majitel: /],
    ['[Master] Sleep not confirmed. Fail-safe shutdown.', /^\[Plánovač\] Spánek se nepotvrdil: pojistné vypnutí\.$/],
    ['[Master] Init. automation=True window=off', /automatika zapnutá, časové okno vypnuté$/],
    ['[Master] Staying awake: login:pts/0,pts/1.', /^\[Plánovač\] Zůstávám vzhůru: přihlášení \(pts\/0, pts\/1\)\.$/],
    ['[Master] Mowing decided by: calendar (owner).', /O sekání rozhoduje: kalendář \(majitel\)\.$/],
    ['[Master] Program rejected:recent_rain -> recovery \'weather\'.', /Program odmítnut \(nedávno pršelo\): zotavení „weather“\.$/],
    ['[Master] Next VinoKolem (12_3) in 40m. Sleeping for 30m.', /Další VinoKolem \(12_3\) za 40 min\. Spím 30 min\.$/],
    ['[Sleep] PM armed, shutting the OS down.', /^\[Spánek\] /]];
const mw = MASTER.filter(([raw, re]) => !re.test(ctx.robotLine(raw) || '')).map(([raw]) => raw + ' -> ' + ctx.robotLine(raw));
check('cs: the master\'s diary ([Master] / [Sleep]) translated (' + MASTER.length + ' samples)', !mw.length, mw.join(' | '));
check('"Reset accepted. Ready for Run." keeps its second sentence (en + cs)',
      ctx.robotLine('Reset accepted. Ready for Run.') === D.cs['auto.line.reset_ready'] && /Run/.test(D.cs['auto.line.reset_ready']) &&
      /Ready for Run/.test(D.en['auto.line.reset_ready']) && ctx.robotLine('Reset accepted') === D.cs['auto.line.reset']);
const WHYS = [['CRITICAL ERROR: BLOCKED_FAILED', 'Kritická chyba: sekačka je zablokovaná a zotavení selhalo'],
    ['CRITICAL ERROR: UNKNOWN', 'Kritická chyba: neznámá příčina'],
    ['Agent: retrying dock: dock manoeuvre failed', 'Agent: dokuji znovu: dokovací manévr selhal'],
    ['Mission ended with an error (mower_link). Press Reset to continue.', 'Mise skončila chybou (deska sekačky mlčí). Pokračuj tlačítkem Reset.'],
    ['Docking retry 1/2: stalled: no progress for 20 s (0.4 m to go): dock reflector not visible',
     'Dokuji znovu (1/2): uvázlo, 20 s bez postupu (zbývá 0.4 m): odrazka doku není vidět'],
    ['CRITICAL ERROR: SOMETHING_NEW', 'Kritická chyba: SOMETHING_NEW']];
const ww = WHYS.filter(([raw, want]) => ctx.robotLine(raw) !== want).map(([raw]) => raw + ' -> ' + ctx.robotLine(raw));
check('cs: reasons after the colon from a finite set translated, an unknown one raw', !ww.length, ww.join(' | '));
// the robot's [SAFETY] lines keep their level: the notice classifies the English original
{
    const N = read('vt_notice.js');
    check('notice: the level comes from the English original (classify(raw))', /level: classify\(raw\)/.test(N));
}
check('cs: "sekačka", never "sečka"', !Object.values(D.cs).some((v) => /[Ss]eč(ka|ku|ky|ce|kou)\b/.test(v)));

// 3) the notice and the log strip
{
    const N = read('vt_notice.js');
    const c2 = { setTimeout, clearTimeout }; vm.createContext(c2);
    vm.runInContext(N.replace("if (typeof document === 'undefined') { return; }", 'return;'), c2);
    let painted = null;
    const q = c2.VTNoticeMake({ paint: (it) => { painted = it && it.text; }, later: () => 1, stop: () => {}, now: () => 1000 });
    q.robot('Executing goal.', 'Driving to the goal');
    check('notice: a robot line shows its translation', painted === 'Driving to the goal');
    q.retext((raw) => (raw === 'Executing goal.' ? 'Jedu k cíli' : null));
    check('notice: a language switch re-translates the shown robot line from its original', painted === 'Jedu k cíli');
    q.retext(() => null);
    check('… and an unknown one falls back to the original English', painted === 'Executing goal.');
    check('notice: VTI18n.onChange hooked to retext with VTAutonomy.robotLine',
          /VTI18n\.onChange\(function \(\) \{\s*root\.VTNotice\.retext\(/.test(N) && /root\.VTAutonomy\.robotLine\(raw\)/.test(N));
    const MV = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
    const s0 = MV.indexOf('format_line(entry) {', MV.indexOf('class StatusLog')), fl = MV.slice(s0, MV.indexOf('append_compact(entry) {', s0));
    check('log strip: robot lines (numeric seq) through VTAutonomy.robotLine, the original in the tooltip',
          /typeof entry\.seq === 'number' && window\.VTAutonomy && VTAutonomy\.robotLine\) shown = VTAutonomy\.robotLine\(entry\.msg\) \|\| entry\.msg/.test(fl)
          && /shown !== entry\.msg && !entry\.key \? ' · ' \+ entry\.msg/.test(fl));
    check('map_view: the notice line gets robotLine for each /nextion/log_info line',
          /VTNotice\.robot\(text, window\.VTAutonomy && VTAutonomy\.robotLine \? VTAutonomy\.robotLine\(text\) : null\)/.test(MV));
}

// 5) the robot's other raw words (T8 dávka V, body 3 + 4)
{
    const both = (k) => k in D.en && k in D.cs;
    ['OK', 'WARN', 'ALERT', 'RAIN', 'UNAVAILABLE'].forEach((st) => check('rain step word ' + st + ' (weather_alert values.py / mosaic.py)', both('auto.rain.step.' + st)));
    check('rain step tooltip: "In {min} min: {state}", no raw UNAVAILABLE as a title',
          both('auto.rain.step.tip') && ph(D.cs['auto.rain.step.tip']) === '{min},{state}' &&
          /s\.title = t\('auto\.rain\.step\.tip', \{ min: \(i \+ 1\) \* 10, state: known\('auto\.rain\.step\.' \+ st, st\) \}\)/.test(AU) &&
          !/s\.title = \(S\.rain\[f\] \|\| 'UNAVAILABLE'\)/.test(AU));
    // node_mower + device_state_publisher's list of /mower/status states
    const MST = ['RUN', 'READY', 'WAIT', 'ERROR', 'ERR', 'CHANGE_HEIGHT', 'HOME', 'CALIBRATING', 'INIT', 'BLOCKED', 'TEMP', 'OFF', 'UNK'];
    const miss = MST.filter((x) => !both('mapview.mower.st.' + x));
    check('mower states in words (mapview.mower.st.*, en + cs)', !miss.length, miss.join(','));
    const MV = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
    check('map_view: the panel status shows the word, keeps the code in data-status',
          /const stKey = 'mapview\.mower\.st\.' \+ String\(message\.status/.test(MV) && /span_mower_panel_status\.dataset\.status = message\.status/.test(MV));
    check('map_view: device state INVALID (silent board) = red mower icon + data-vt-silent',
          /message\.mower === "INVALID" \? '1' : ''/.test(MV) && /ico_mower\.dataset\.vtSilent = mSilent/.test(MV));
    const RD = fs.readFileSync(path.join(JS, 'right_dock.js'), 'utf8');
    check('right panel: the blade start decides by the code (data-status), not by the shown word',
          /var code = st \? String\(st\.dataset\.status \|\| txt\)\.toUpperCase\(\) : ''/.test(RD) && /status: on \? startCode : ''/.test(RD) &&
          /cur\.status === 'READY'/.test(RD));
    check('right panel: a silent board = "Not answering", red, and no start',
          /if \(silent && on\) \{ txt = t\('rdock\.mower\.silent'\); state = 'err'; startCode = ''; \}/.test(RD) && both('rdock.mower.silent') && both('rdock.mower.silent.tip'));
    // V-b: in the dock the last word is OFF / UNK (section hidden): a silent board shows it anyway,
    // but only once a /mower/status came since the page loaded (data-status set for every message)
    check('V-b: silent + a message seen -> the Mower section shows even after OFF / UNK',
          /var seen = !!\(st && typeof st\.dataset\.status === 'string' && st\.dataset\.status !== ''\);/.test(RD) &&
          /var on = powered \|\| \(silent && \(seen \|\| linkSilent\)\);/.test(RD) &&
          /span_mower_panel_status\.dataset\.status = message\.status \|\| '';\s*if \(message\.status === 'UNK' \|\| message\.status === 'OFF'\)/.test(MV));
    check('V-b: the STOP (■) still works on the last RUN of a silent board (run = code, only the start is cleared)',
          /run: on \? code : ''/.test(RD) && /\(cur\.run !== undefined \? cur\.run : cur\.status\) === 'RUN'/.test(RD) &&
          /var canStart = function \(\) \{ return !!\(api\(\) && cur\.on && cur\.status === 'READY' && !spinning\(\)\); \};/.test(RD));
    check('the blade start tooltip has no raw READY', !/READY/.test(D.en['rdock.mower.start.notready']) && !/READY/.test(D.cs['rdock.mower.start.notready']));
    const SH = fs.readFileSync(path.join(JS, 'status_header.js'), 'utf8');
    check('header: the silent mark has its own words and repaints on it',
          /img\.dataset && img\.dataset\.vtSilent === '1'/.test(SH) && /'status\.d8\.st\.' \+ k\.st \+ '\.silent'/.test(SH) &&
          /attributeFilter: \['src', 'style', 'data-vt-silent'\]/.test(SH) && both('status.d8.st.mower.silent'));
}

// V-c: a page loaded while the board is ALREADY silent gets no /mower/status: /mower/link
// says "silent" itself; the template placeholders ("RUN", "0 rpm", "0°C") are never data
{
    const MV = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
    const RD = fs.readFileSync(path.join(JS, 'right_dock.js'), 'utf8');
    check('V-c: map_view subscribes /mower/link and marks data-link (+ last known state / values when silent)',
          /name: '\/mower\/link'/.test(MV) && /mower\.mower_link_topic\.subscribe/.test(MV) && /st\.dataset\.link = state/.test(MV) &&
          /if \(state !== 'silent'\) return;/.test(MV));
    check('V-c: right panel decides by the link message, not by missing data',
          /var linkSilent = !!\(st && st\.dataset\.link === 'silent'\);/.test(RD) &&
          /var on = powered \|\| \(silent && \(seen \|\| linkSilent\)\);/.test(RD) && /'data-link'\]/.test(RD));
    check('V-c: silent board: the blade cell says "—" (state unknown), not "stands"', /if \(silent && on\) \{ bt = '—'; \}/.test(RD));
    check('V-c: the template placeholders are cleared until the first data',
          /if \(st && !st\.dataset\.status\) \{\s*\[st, vR, vH, vT\]\.forEach\(function \(e\) \{ if \(e\) \{ e\.textContent = ''; \} \}\);/.test(RD));
    check('V-c: OFF / UNK zero the rpm (no stale "the blade turns" after RUN -> OFF -> silence)',
          /style\.display = 'none';\s*\/\/ V-c[^\n]*\n[^\n]*\n\s*if \(this\.span_mower_panel_rpm\) this\.span_mower_panel_rpm\.textContent = '0 rpm';/.test(MV) &&
          /\(code === 'OFF' \|\| code === 'UNK' \|\| rpm === null\) \? '0 rpm'/.test(MV));
}

// 4) coverage of a real log (report only)
{
    const f = process.argv[2] || path.join(process.env.HOME || '', '.ros', 'vitulus_status_log', 'status_log.jsonl');
    if (fs.existsSync(f)) {
        let all = 0, hit = 0; const miss = new Map();
        fs.readFileSync(f, 'utf8').split('\n').forEach((l) => {
            let j; try { j = JSON.parse(l); } catch (e) { return; }
            const m = String(j.msg || '').trim();
            if (!m) { return; }      // V-b: the master's diary too (it is in the Log)
            all++;
            if (ctx.robotLine(m) !== null) { hit++; } else { const k = m.replace(/\d+(\.\d+)?/g, '#'); miss.set(k, (miss.get(k) || 0) + 1); }
        });
        console.log('NOTE coverage ' + f + ': ' + hit + '/' + all + ' lines (' + (100 * hit / Math.max(1, all)).toFixed(1) + ' %), ' + miss.size + ' forms raw');
        [...miss.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).forEach(([k, n]) => console.log('NOTE   raw ' + n + '× ' + k));
        check('coverage of the real log >= 95 %', hit / Math.max(1, all) >= 0.95);
    } else { console.log('NOTE no status_log.jsonl here: coverage not measured'); }
}
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
