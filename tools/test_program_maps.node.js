#!/usr/bin/env node
// vitulus-field#46: Programs lists the programs of every map, Run of another map's
// program names its map, the calendar keeps the map of a slot.
// Run: node tools/test_program_maps.node.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js');
const src = fs.readFileSync(path.join(JS, 'map_view.js'), 'utf8');
let fails = 0;
function ok(name, cond, extra) {
    console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond || extra === undefined ? '' : ' ' + JSON.stringify(extra)));
    if (!cond) fails++;
}
function cut(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error('no ' + head);
    let i = text.indexOf('{', start), depth = 0;
    for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error('unbalanced ' + head);
}
const published = [];
class Topic {
    constructor(o) { this.name = o.name; }
    subscribe() {} advertise() {}
    publish(m) { published.push([this.name, m.data]); }
}
const listeners = {};
const ctx = {
    console, window: {addEventListener: (k, f) => { listeners[k] = f; }, setTimeout: () => 0, clearTimeout() {}},
    document: {getElementById: () => null, addEventListener() {}},
    ROSLIB: {Topic, Message: function (m) { Object.assign(this, m); }},
    vtEsc: (s) => String(s), vtT: (k, p) => k + (p ? JSON.stringify(p) : ''),
    vtOnLang() {}, vtResultState: () => 'off', vtTag() {},
    uiPrefGet: () => '', uiPrefSet() {},
};
vm.createContext(ctx);
vm.runInContext(cut(src, 'class ProgramListItemTemplate') + cut(src, 'class ForeignProgramItemTemplate')
    + cut(src, 'class Programs') + '\nthis.Programs = Programs;', ctx);
const row = {innerHTML: '', classList: {toggle() {}}, style: {}, dataset: {}};
const span = () => ({innerText: '', removeAttribute() {}, value: 0, checked: false, className: '', classList: {contains: () => false}});
const menu = new Proxy({div_menu_program_items_row: row, div_menu_program_detail_row: row}, {
    get(t, k) { if (!(k in t)) t[k] = span(); return t[k]; }});
ctx.Programs.prototype.init = function () {};
const p = new ctx.Programs({}, menu, {markerArrayClient: {markers: {}}});
p.program_list_msg = {program_list: [{name: 'Own', map_name: 'LADA', area: 1, length: 1}]};
ctx.window.vitulusServedSite = 'LADA';
ctx.window.vitulusSites = [
    {name: 'BACK', programs: ['B1Test'], programs_info: [{name: 'B1Test', area: 7, zone_names: ['Z1']}]},
    {name: 'LADA', programs: ['Own'], programs_info: [{name: 'Own'}]},
    {name: 'T1', programs: []}];
p.smach_blocked = false;
p._setShowBtn = () => {};
listeners['vitulus-sites']();
ok('the list shows the map of the active one', row.innerHTML.includes('Own') && row.innerHTML.includes('(LADA)'), row.innerHTML);
ok('the list shows the program of another map', row.innerHTML.includes('B1Test') && row.innerHTML.includes('(BACK)'), row.innerHTML);
ok('the active map is not listed twice', (row.innerHTML.match(/Own/g) || []).length === 1);
ok('all programs', JSON.stringify(p.allPrograms()) === JSON.stringify([{site: 'LADA', name: 'Own'}, {site: 'BACK', name: 'B1Test'}]), p.allPrograms());
p.selected_program = {name: 'Own'};
p.runProgram('Own');
ok('own program: plain name', published.pop()[1] === 'Own');
p.show_foreign(0);
ok('another map: read-only card', p.selected_program.foreign === true);
p.runProgram('B1Test');
let last = published.pop();
ok('another map: Run names it', last[0] === '/web_plan/program_select' && last[1] === 'BACK|||B1Test', last);
p.resumeProgram('B1Test');
last = published.pop();
ok('another map: Resume names it', last[0] === '/web_plan/program_select_resume' && last[1] === 'BACK|||B1Test', last);
p.saveProgram();
ok('another map: Save does nothing', published.length === 0);
// no active map, nothing on the list: Mac's report
p.program_list_msg = {program_list: []};
ctx.window.vitulusServedSite = '';
listeners['vitulus-sites']();
ok('no map on: still all programs', row.innerHTML.includes('B1Test') && row.innerHTML.includes('Own'), row.innerHTML);
// legacy navi map: the planner's list is the whole truth
p.active_map_data = 'X***env*OUTDOOR';
listeners['vitulus-sites']();
ok('legacy: no site rows', !row.innerHTML.includes('B1Test'));
// D4 (P4): the last result in words, the planner's text kept for the tooltip
const R = (t) => ctx.Programs.resultText(t);
ok('result: done', R('succeeded').state === 'ok' && R('succeeded').text === 'prog.d4.res.done', R('succeeded'));
ok('result: checkpoint = unfinished in that zone', R('failed: on_path-Back_garden-by-the-fence-3-120').state === 'warn'
    && R('failed: on_path-Back_garden-by-the-fence-3-120').text === 'prog.d4.res.unfinished{"zone":"Back_garden-by-the-fence"}',
    R('failed: on_path-Back_garden-by-the-fence-3-120'));
ok('result: failed at the start', ['on_init', 'on_planner', 'on_mower'].every((ph) => R('failed: ' + ph).state === 'err'
    && R('failed: ' + ph).text === 'prog.d4.res.start_failed'));
ok('result: never run', R('').text === 'mapview.prog.never_run' && R('').state === 'off');
ok('result: anything else as it came', R('aborted by user').text === 'aborted by user');
if (fails) { console.log('FAILED ' + fails); process.exit(1); }
console.log('OK');
