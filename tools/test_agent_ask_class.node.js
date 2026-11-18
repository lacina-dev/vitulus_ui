#!/usr/bin/env node
/*
 * T8 V-j: a request the robot's gate holds is said by what it is (agent_chat.js askClass):
 * movement / the mower / another command on the robot / class not known - from what the core
 * sends in /agent/api/approvals (rule, moves, moves_why), with the command's own text cut
 * between words. Seen live 2026-11-18: request 115 (rostopic pub to a /mower/… topic) stood
 * over the map as "MOVEMENT NEEDS YOUR YES".
 *
 *     node tools/test_agent_ask_class.node.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const src = fs.readFileSync(path.join(JS, 'agent_chat.js'), 'utf8');
let fails = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) { fails++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); } };
const a = src.indexOf('var CLASS_MOWER'), b = src.indexOf('function askMoves(');   // askClass + askClassOld + cutWords + askCommand
check('agent_chat.js has askClass before askMoves', a > 0 && b > a);
const F = new Function(src.slice(a, b) + '\nreturn {askClass, askClassOld, cutWords, askCommand};')();
const live = { id: 115, command: "rostopic pub -1 /mower/zkouska_brany_neexistuje std_msgs/Empty '{}'", rule: 'mower:rostopic:pub', moves: true, moves_why: 'mower',
               detail: { what: 'Spustit držený příkaz na robotu (jednou).', payload: { kind: 'command', text: "rostopic pub -1 /mower/zkouska_brany_neexistuje std_msgs/Empty '{}'" } } };
check('the live request 115 (a mower topic) is "mower", not "move"', F.askClass(live) === 'mower', F.askClass(live));
check('rule motion:… is movement', F.askClass({ rule: 'motion:rostopic:pub', moves: true, moves_why: 'cmd_vel' }) === 'move');
check('no rule, stopped by cmd_vel / undock / goal: movement', ['cmd_vel', 'undock', 'move_base', 'goal', 'dock.undock'].every((w) => F.askClass({ moves: true, moves_why: w }) === 'move'));
check('no rule, stopped by a mower word: mower', ['mower', 'mow_', 'sekacka', 'set_motor', 'mow.program'].every((w) => F.askClass({ moves: true, moves_why: w }) === 'mower'));
check('held by the core for a reason that is neither: "robot"', F.askClass({ moves: true, moves_why: 'klasifikace nedostupná (KeyError)' }) === 'robot');
check('the core says it does not move (only the page\'s own guard holds it): class not known', F.askClass({ moves: false, moves_why: null, rule: 'net:curl' }) === 'cmd');
check('an older core without `moves`: as before, movement', F.askClass({ command: 'undock' }) === 'move');
check('nothing at all does not throw', F.askClass(undefined) === 'move' && F.askCommand(undefined) === '');
// T8 V-k: effects from the core (a subset of motion / mower); never milder than the older reading
const E = (ef, more) => F.askClass(Object.assign({ moves: true, effects: ef }, more || {}));
check('effects motion + mower: both', E(['motion', 'mower'], { rule: 'mower:rostopic:pub' }) === 'both');
check('effects mower only (request 115): mower', F.askClass(Object.assign({}, live, { effects: ['mower'], effects_why: 'deska sekačky' })) === 'mower');
check('effects motion only: movement', E(['motion'], { rule: 'x:y', moves_why: 'cmd_vel' }) === 'move');
check('effects empty, nothing else known: "a command waits"', F.askClass({ moves: false, effects: [], rule: 'ros:rosparam' }) === 'cmd');
check('effects empty but the rule says mower: stays mower (never milder)', E([], { rule: 'mower:rostopic:pub' }) === 'mower');
check('effects mower but the rule says motion: both (never milder)', E(['mower'], { rule: 'motion:rostopic:pub' }) === 'both');
check('effects empty but stopped by a movement word: stays movement', E([], { moves_why: 'undock' }) === 'move');
check('effects not a list: as without it', F.askClass(Object.assign({}, live, { effects: 'mower' })) === 'mower' && F.askClass({ command: 'undock', effects: null }) === 'move');
// T8 V-l (check A768): held = the page's words OR the core's effects; of several the strictest one speaks
const m0 = src.indexOf('var MOVE_RE = new RegExp'), m1 = src.indexOf('/* The whole point of the card');
check('agent_chat.js: MOVE_RE … askMoves can be taken out', m0 > 0 && m1 > m0);
const G = new Function(src.slice(m0, m1) + '\nreturn {askHeld, askStrictest, askMoves, askClass};')();
const quiet = { command: 'rosparam set /x 1', plain: 'nastavím parametr', rule: 'ros:rosparam', moves: false };
check('a request the words do not catch and without effects is not held', G.askMoves(quiet) === false && G.askHeld(quiet) === false);
check('… with effects motion it is held (red card, second tap)', G.askHeld(Object.assign({}, quiet, { effects: ['motion'] })) === true);
check('… with effects mower too', G.askHeld(Object.assign({}, quiet, { effects: ['mower'] })) === true);
check('… empty or unknown effects do not hold it', G.askHeld(Object.assign({}, quiet, { effects: [] })) === false && G.askHeld(Object.assign({}, quiet, { effects: ['x'] })) === false && G.askHeld(Object.assign({}, quiet, { effects: 'motion' })) === false);
check('never milder: what the words catch stays held whatever effects says', G.askHeld({ command: 'rostopic pub /cmd_vel', effects: [] }) === true && G.askHeld({ command: 'undock' }) === true);
const four = [Object.assign({}, live, { id: 1, effects: ['mower'] }), Object.assign({}, quiet, { id: 2 }),
              { id: 3, command: 'rostopic pub /web_plan/program_select std_msgs/String Bigger', rule: 'mower:rostopic:pub', moves: true, effects: ['motion', 'mower'] },
              { id: 4, command: 'rostopic pub /cmd_vel geometry_msgs/Twist', rule: 'motion:rostopic:pub', moves: true, effects: ['motion'] }];
check('four waiting (mower, plain, both, movement): the line speaks of "movement and mower"', G.askStrictest(four) === 2 && G.askClass(four[2]) === 'both', G.askStrictest(four));
check('without the "both" one: movement before the mower one', G.askStrictest([four[0], four[1], four[3]]) === 2);
check('equal classes: the first in the list (waits longest)', G.askStrictest([four[0], Object.assign({}, four[0], { id: 9 })]) === 0);
check('none held: -1 (the calm "approval waiting" line as before)', G.askStrictest([quiet, quiet]) === -1 && G.askStrictest([]) === -1);
check('the strip says how many more wait, the card and the order use askHeld', /_t\('appr\.strip\.more', \{n: stripAsks\.length - 1\}\)/.test(src) && /var moves = askHeld\(item\)/.test(src) && !/var m[ab] = askMoves/.test(src));
const cw = F.cutWords(live.command, 60);   // the strip's limit: "rostopic pub -1 /mower/zkouska_brany_neexistuje…"
check('the command is cut between words, with "…", within the limit', cw.length <= 60 && /neexistuje…$/.test(cw) && /…$/.test(cw) && live.command.indexOf(cw.slice(0, -1) + ' ') === 0, cw);
check('a short command stays whole', F.cutWords('rostopic list', 40) === 'rostopic list');
check('one very long word is still cut', F.cutWords('x'.repeat(100), 20).length === 20);
check('the command text comes from command, else from the payload', F.askCommand(live) === live.command && F.askCommand({ detail: { payload: { text: 'ls' } } }) === 'ls');
check('the strip and the card use the class', /label: _t\(ac === 'move' \? 'appr\.strip\.move' : 'appr\.strip\.' \+ ac\)/.test(src) && /'appr\.gate\.banner\.' \+ cls/.test(src));
const win = {}; const ctx = vm.createContext({ window: win });
['en', 'cs'].forEach((l) => vm.runInContext(fs.readFileSync(path.join(JS, 'i18n', l + '.js'), 'utf8'), ctx));
['en', 'cs'].forEach((l) => {
    const D = win.VT_I18N_DICT[l];
    ['appr.strip.more', 'appr.strip.both', 'appr.gate.banner.both', 'appr.gate.why', 'appr.strip.mower', 'appr.strip.robot', 'appr.strip.cmd', 'appr.gate.banner.mower', 'appr.gate.banner.robot', 'appr.gate.banner.cmd', 'appr.gate.tip', 'appr.gate.allow', 'appr.gate.allow_tip', 'appr.gate.confirm']
        .forEach((k) => check(l + ': ' + k, typeof D[k] === 'string' && D[k].length > 3));
    check(l + ': the mower / robot / unknown labels do not say "movement"', ['appr.strip.mower', 'appr.strip.robot', 'appr.strip.cmd', 'appr.gate.allow', 'appr.gate.confirm'].every((k) => !/POHYB|MOVEMENT|\bjet\b|jede|\bmove\b/i.test(D[k])));
});
console.log(fails ? fails + ' FAILED of ' + n : 'all ' + n + ' checks passed');
process.exit(fails ? 1 : 0);
