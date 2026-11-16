#!/usr/bin/env node
/*
 * T8 dávka V-d: the "Needs you" bell before the first answer.
 *
 *     node tools/test_needs_bell.node.js
 *
 * For ~12 s after a load the field dashboard has not answered yet and the bell said
 * "Needs you: nothing waits" — a guess. Until the first answer (home or attention, ok
 * or not) it says "loading", without a number; after it nothing changes.
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
for (const l of ['en', 'cs']) { const c = { window: {} }; vm.createContext(c); vm.runInContext(read('i18n/' + l + '.js'), c); D[l] = c.window.VT_I18N_DICT[l]; }
const N = read('vt_needs.js');
check('model(): loaded = the field dashboard answered once (home or attention)', /loaded: !!\(home \|\| field\)/.test(N));
check('bell: no answer yet -> "loading" (aria-label), no number, data-loading',
      /var wait = !m\.n && !m\.loaded;/.test(N) && /t\(wait \? 'needs\.bell\.loading' : 'needs\.bell\.none'\)/.test(N) &&
      /bell\.setAttribute\('data-loading', '1'\)/.test(N) && /bellN\.textContent = m\.n \?/.test(N));
check('panel head: "loading" until the first answer, then "nothing waits" as before',
      /t\(m\.loaded \? 'needs\.nothing_waits' : 'needs\.loading'\)/.test(N));
['needs.bell.loading', 'needs.loading'].forEach((k) => check(k + ' in en + cs', k in D.en && k in D.cs && !/nothing|nic/.test(D.en[k] + D.cs[k])));
console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nOK — all checks passed');
process.exit(fails ? 1 : 0);
