# How to keep help current

The help of the robot UI **is** the documentation of the robot and the UI. Every topic is one
Markdown file in this directory; the UI (`?` in a panel head, `?` in the navbar, Support › Help)
draws exactly these files. Nothing of the help text lives in JavaScript — never keep it twice.

## Where things are

| What | Where |
|---|---|
| topics | `docs/help/<id>.md` (this README is not a topic) |
| translations | `docs/help/cs/<id>.md` — the Czech version of a topic; a topic without it shows in English. Format and rules: [`docs/I18N.md`](../I18N.md#help-docshelp) |
| pictures | `docs/help/img/*.svg|png` → served at `/help/img/…`; robot icons are referenced as `../../nodes/templates/assets/img/…` (works in git and in the UI) |
| server | `nodes/webnode`: `GET /help/docs.json[?lang=cs]` (all topics + the translations of that language, read from disk on every request — an edit shows after a reload, no restart), `GET /help/img/<file>` |
| renderer | `nodes/templates/assets/js/vt_help_md.js` (the Markdown dialect below, escapes everything) |
| help pane | `nodes/templates/assets/js/vt_help.js` + `assets/css/vt_help.css` |
| check | `tools/test_help_docs.node.js` |

The pane sits on the right edge of the C frame (over the right panel, ending above the log and the
joystick) on a PC and a landscape phone, and is a sheet on a phone held upright. It opens only when
someone asks; Esc / ✕ closes it.

## A topic file

```markdown
---
id: dock                      # = file name without .md
title: Dock and undock
group: Robot                  # Start here | Robot | Using the UI | When something is wrong
order: 30                     # position in its group
icon: la-home                 # a line-awesome class (must exist in assets/fonts/line-awesome.min.css)
summary: One line for the topic card and the search.
ui: [map/dock, map/rain#weather-map--rain]   # UI spots this topic answers (see below)
related: [localization, safety]               # topic ids shown under the text
keywords: [dock, undock, reflector]            # extra words for the search
---
# Dock and undock
…
```

Write **task first**: "How do I …", short numbered steps, what you will see, and *what to do when
it does not work*. The source is **English** (`docs/help/<id>.md`); the Czech version lives in
`docs/help/cs/<id>.md` (same id, group, ui keys — see [`docs/I18N.md`](../I18N.md)) and is updated
together with the English one. Facts must be checked in code or config — when unsure, leave it
out or say so.

### The dialect (GitHub-compatible)

- `## Heading` — anchors are GitHub slugs: `## The Loc tab (lidar global localization)` →
  `#the-loc-tab-lidar-global-localization`.
- Links: `[text](other.md#anchor)` (another topic), `[text](#anchor)` (same topic),
  `https://…` (new tab). They work on GitHub too.
- Callouts: `> [!TIP]`, `> [!NOTE]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` (green, cyan,
  cyan, orange, red). Lists inside are fine.
- Tables; a cell that is just `green` / `orange` / `red` / `grey` gets the UI's colour dot.
- A step diagram:

  ````markdown
  ```flow
  Undock | out of the dock
  warn: Wait for RTK | both receivers RTK
  ok: Ready
  ```
  ````

  one step per line, `Title | detail`, optional tone `ok:` `warn:` `err:` `info:` `off:`.
- Raw HTML is shown as text, never rendered.

## UI keys (`ui:`) — what the `?` opens

`?` in the left panel's head opens the topic of the **panel + its open tab**:

| Key | Spot |
|---|---|
| `marker`, `map`, `program`, `config`, `editor`, `agent`, `needs`, `support` | the panel (fallback for its tabs) |
| `map/<tab>`, `program/<tab>`, `config/<tab>` | a tab: the pane id without `tab-` / `tab_` (`#tab-dock` → `map/dock`, `#tab_lidar` → `config/lidar`) |
| `agent/<tab>` | `TAB_ORDER` in `agent_chat.js` |
| `support/<tab>` | `TABS` in `vt_support.js` |
| `right/state`, `log` | the `?` in the right panel's Navi head and in the log toolbar |
| `frame`, `drive`, `camera`, `icons`, `stop` | spots without a button (`VTHelp.open('drive')`) |

`key#anchor` opens the topic at that heading. A key may belong to one topic only.

## Checklist when the UI or the robot changes

1. **New panel or tab** → add its key to `ui:` of the right topic (the test fails until you do).
2. **Changed behaviour** (a button, a state, a timeout, a default) → update the sentence that
   describes it. Search the help for the old word: `grep -rn "old word" docs/help/`.
3. **New feature** → a section in the right topic (or a new topic file); link it from related
   topics.
4. **Removed feature** → remove its text, its `ui:` key and links to it.
5. Pictures are schematic SVG on purpose (screenshots go stale); keep them simple.
6. Run `node tools/test_help_docs.node.js` and `node tools/test_i18n.node.js` (and the other
   `tools/*.node.js`). A translated topic (`docs/help/cs/`) changes together with the English one.
7. Deploy: `tools/restart_webnode` (only needed when JS/CSS/the server changed — Markdown alone
   is read live), then open the help and the changed topic once on a PC and a phone (`?mock`).

The test fails when a topic misses `id` / `title` / `group` / `summary`, a link or an anchor is
dead, an image does not exist, an icon is not in line-awesome, a `ui:` key is claimed twice, a
panel / tab / help spot has no topic, or the renderer would let raw HTML through.
