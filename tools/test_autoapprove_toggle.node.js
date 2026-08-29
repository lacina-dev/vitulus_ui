#!/usr/bin/env node
/*
 * Harness for the Jobs-tab auto-approve toggle (agent_chat.js).
 *
 *     node tools/test_autoapprove_toggle.node.js
 *
 * agent_chat.js is a DOM-bound IIFE with no exports, so the whole file cannot
 * be imported in node.  Instead the two functions under test
 * (autoApproveLabel, autoApproveToggle) are sliced out of the source verbatim
 * and evaluated against a stub DOM + a stub jobPost — which is exactly the
 * seam the real code uses: the toggle's only side effects are one jobPost
 * call and its own class/text.  Checks:
 *   - click posts to /<ref>/autoapprove with {on: true} when off (and
 *     {on: false} when on),
 *   - a {ok: true} reply flips the visual state (class 'on' + label),
 *   - a {ok: false} reply leaves the state alone and surfaces the error.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'nodes', 'templates', 'assets', 'js',
              'agent_chat.js'), 'utf8');

function slice(name) {
    const start = SRC.indexOf('function ' + name + '(');
    if (start < 0) { throw new Error(name + ' not found in agent_chat.js'); }
    let depth = 0, i = SRC.indexOf('{', start);
    for (let j = i; j < SRC.length; j++) {
        if (SRC[j] === '{') { depth++; }
        if (SRC[j] === '}') { depth--; if (!depth) { return SRC.slice(start, j + 1); } }
    }
    throw new Error(name + ' braces never closed');
}

// ---- stub DOM element: enough for createElement + addEventListener --------
function stubEl() {
    const el = {
        classes: new Set(),
        handlers: {},
        set className(v) { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
        get className() { return Array.from(el.classes).join(' '); },
        classList: {
            toggle(cls, on) { if (on) { el.classes.add(cls); } else { el.classes.delete(cls); } },
            contains(cls) { return el.classes.has(cls); },
        },
        addEventListener(ev, fn) { el.handlers[ev] = fn; },
        click() { return el.handlers.click({stopPropagation() {}}); },
    };
    return el;
}

const posts = [];
let reply = {ok: true};
const scope = {
    document: {createElement() { return stubEl(); }},
    AUTOAPPR_TIP: 'tip',
    jobPost(ref, verb, body) {
        posts.push({ref, verb, body});
        return Promise.resolve(reply);
    },
    afterAction() {},
};

const factory = new Function(
    'document', 'AUTOAPPR_TIP', 'jobPost', 'afterAction',
    slice('autoApproveLabel') + '\n' + slice('autoApproveToggle') +
    '\nreturn autoApproveToggle;');
const autoApproveToggle = factory(scope.document, scope.AUTOAPPR_TIP,
                                  scope.jobPost, scope.afterAction);

const failures = [];
function ok(label, cond) {
    if (!cond) { failures.push(label); }
    console.log('  ' + label.padEnd(62) + (cond ? 'ok' : 'FAIL'));
}

(async function main() {
    console.log('auto-approve toggle → endpoint payload (node harness)');

    // OFF → click turns it on
    let j = {ref: 'j:12', auto: false};
    let b = autoApproveToggle(j);
    ok('starts without the on class', !b.classList.contains('on'));
    await b.click();
    ok('posts verb autoapprove', posts[0] && posts[0].verb === 'autoapprove');
    ok('posts the job ref', posts[0] && posts[0].ref === 'j:12');
    ok('payload is {on: true}', posts[0] && posts[0].body.on === true);
    ok('flips model to on', j.auto === true);
    ok('flips class to on', b.classList.contains('on'));
    ok('label says on', /auto-approve on/.test(b.textContent));

    // ON → click turns it off
    await b.click();
    ok('second click posts {on: false}', posts[1] && posts[1].body.on === false);
    ok('flips model back off', j.auto === false);
    ok('drops the on class', !b.classList.contains('on'));

    // backend refusal → state untouched, error surfaced
    reply = {ok: false, error: 'práce #12 neexistuje'};
    await b.click();
    ok('refusal keeps model off', j.auto === false);
    ok('refusal keeps class off', !b.classList.contains('on'));
    ok('refusal lands in the title', /failed: práce #12/.test(b.title));

    // the creation form sends auto_approve only when checked (static seam)
    ok('form wires payload.auto_approve to the checkbox',
       /if \(autoCb\.checked\) \{ payload\.auto_approve = true; \}/.test(SRC));

    console.log('');
    if (failures.length) {
        console.log('FAILED (' + failures.length + '): ' + failures.join('; '));
        process.exit(1);
    }
    console.log('All good.');
}());
