/* vt_links.js — links between the robot agent and the field kit inside the
 * robot UI (U2, I6 of docs/UI_INTEGRATION_PLAN.md). Read-only: every link
 * only OPENS something; nothing is sent, approved or written.
 *
 *   VTLinks.askAgent(text)       Agent › Chat with `text` put into the input
 *                                (the human reads, edits and presses Send)
 *   VTLinks.openIssue(n)         Support › Issues, card #n highlighted
 *   VTLinks.issueTimeline(n)     Agent › Activity filtered to issue #n
 *   VTLinks.openAgentJob(id, k)  Agent › Findings (k = 'finding') or the job
 *                                highlighted in Agent › Work
 */
(function () {
    'use strict';
    function later(fn, ms) { setTimeout(fn, ms || 0); }

    function askAgent(text) {
        if (!window.VAgent || !VAgent.open) { return false; }
        VAgent.open();
        if (VAgent.activateTab) { VAgent.activateTab('chat'); }
        later(function () {
            var inp = document.getElementById('vagent_input');
            if (!inp) { return; }
            var cur = inp.value || '';
            inp.value = cur && cur.indexOf(text) < 0 ? (cur.replace(/\s+$/, '') + '\n' + text) : (cur || text);
            try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* old browser */ }
            inp.focus();
            try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* not a text field */ }
        }, 150);
        return true;
    }
    function openIssue(n) {
        if (!window.VTSupport) { return false; }
        if (VTSupport.showIssue) { VTSupport.showIssue(n); return true; }
        VTSupport.open('issues');
        return true;
    }
    function issueTimeline(n) {
        if (!window.VAgent || !VAgent.open) { return false; }
        VAgent.open();
        if (VAgent.activateTab) { VAgent.activateTab('activity'); }
        if (window.VTActivity) { VTActivity.filterIssue(n); }
        return true;
    }
    function openAgentJob(id, kind) {
        if (!window.VAgent || !VAgent.open) { return false; }
        VAgent.open();
        if (kind === 'finding') { if (VAgent.activateTab) { VAgent.activateTab('findings'); } }
        else if (VAgent.highlightJob) { VAgent.highlightJob(id); }
        return true;
    }
    /* a small button in the card language */
    function button(label, fn, title) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-outline-info vt-needs-btn';
        b.textContent = label;
        if (title) { b.title = title; }
        b.addEventListener('click', function (e) { e.preventDefault(); fn(); });
        return b;
    }

    window.VTLinks = { askAgent: askAgent, openIssue: openIssue, issueTimeline: issueTimeline,
                       openAgentJob: openAgentJob, button: button };
})();
