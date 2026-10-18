# How to keep help current

The help of the robot UI **is** the documentation of the robot and the UI. Every topic is one
Markdown file in this directory; the UI (`?` in a panel head, `?` in the navbar, Support › Help)
draws exactly these files. Nothing of the help text lives in JavaScript — never keep it twice.

## Where things are

| What | Where |
|---|---|
| topics | `docs/help/<id>.md` (this README is not a topic) |
| translations | `docs/help/cs/<id>.md` — the Czech version of a topic; a topic without it shows in English. Format and rules: [`docs/I18N.md`](../I18N.md#help-docshelp) |
| pictures | `docs/help/img/*.svg|webp|png` → served at `/help/img/…`; robot icons are referenced as `../../nodes/templates/assets/img/…` (works in git and in the UI). `shot-*.webp` = screenshots made by `tools/help_shots.py`, `*.svg` = hand-drawn schemas (see [Pictures](#pictures)) |
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
- Pictures: `![alt text](img/x.webp "Caption")`. A paragraph that holds **only pictures** becomes
  figures with the caption under each; two or three pictures in one paragraph (one line) sit side
  by side as a grid (one column in a narrow pane). A help picture (`img/…`) opens full size on a
  click (Esc / click closes). The **alt text is required** (the test checks it) — say what the
  picture shows; the caption says what the numbers mean.
- Raw HTML is shown as text, never rendered.

## Pictures

The help should *show* what it talks about. Two kinds:

- **Schemas** (`img/*.svg`, hand-drawn): the robot (`robot.svg`), the dock (`dock.svg`), the drive
  priority (`takeover.svg`), the sources of the position (`localization.svg`), a map
  (`site.svg`), the camera overlays (`camera-overlays.svg`), the frame (`frame.svg`). Use them
  for the robot and for things that do not change with the UI. Palette of
  [UI_FIELD_STYLE](../UI_FIELD_STYLE.md): background `#1c2329`, surfaces `#282b30` / `#2b343c` /
  `#37434d`, accent `#0dcaf0`, OK `#43d58b`, warning `#ffab45`, fault `#ff5f6d`, grey `#8a939b`,
  robot `#ff7100`. **No words in a schema** (only UI literals such as `DOCK`, `RTK`): a part is a
  numbered cyan dot and the Markdown says what the number is — so the Czech topic reuses the same
  picture and translates only the list / caption.
- **Screenshots** (`img/shot-*.webp`): crops of the real UI with numbered markers, made by
  `tools/help_shots.py` from a running dev instance in `?mock`. **Refresh them after a UI change**
  (they go stale otherwise):

  ```sh
  # 1. a dev webnode of your worktree on a free port (never the live :7779), ROS master pointed
  #    nowhere so it cannot talk to the robot; the page still reads the robot live in ?mock
  sed 's/^port = 7779/port = 7861/' nodes/webnode > nodes/.webnode_dev.py
  ROS_MASTER_URI=http://10.254.254.254:11311 ROS_IP=10.254.254.254 \
    VITULUS_UI_SETTINGS=/tmp/help_shots_ui.json nice -n 19 python3 nodes/.webnode_dev.py __name:=webnode_shots &
  # 2. all pictures, or only some
  nice -n 19 tools/help_shots.py --url http://127.0.0.1:7861
  nice -n 19 tools/help_shots.py --url http://127.0.0.1:7861 --only shot-dock-tab,shot-navi --png /tmp/look
  tools/help_shots.py --list
  # 3. look at them (--png keeps PNG copies), stop the dev webnode, rm nodes/.webnode_dev.py
  ```

  Each shot is one entry of `SHOTS` in the script: which panel / tab to open, what to crop, and
  the markers `(selector, number, where)`. A marker that is not found is reported — then fix its
  selector, the numbers in the caption must still match. The script only clicks menu buttons,
  tabs and section heads, refuses `:7779` and stops when the page is not in mock mode. The
  pictures show the robot's state at that moment: avoid things that would mislead or expose the
  owner (the aerial photo and the rain radar show where the garden is — the script switches the
  aerial layer off; at night the camera is black, hence the schematic `camera-overlays.svg`).
- Size: WebP (quality ~82) or SVG, at most 400 kB per file (the test checks); 2× pixels for small
  crops so they stay sharp in the lightbox.

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
5. Pictures: a changed panel → run `tools/help_shots.py` for its shots and check the numbers in
   the caption; a new panel / feature → add a shot (or a schema) and a numbered caption
   ([Pictures](#pictures)).
6. Run `node tools/test_help_docs.node.js` and `node tools/test_i18n.node.js` (and the other
   `tools/*.node.js`). A translated topic (`docs/help/cs/`) changes together with the English one.
7. Deploy: `tools/restart_webnode` (only needed when JS/CSS/the server changed — Markdown alone
   is read live), then open the help and the changed topic once on a PC and a phone (`?mock`).

The test fails when a topic misses `id` / `title` / `group` / `summary`, a link or an anchor is
dead, an image does not exist (in an English topic or a translation), a help picture has no alt
text, `img/` holds a picture no topic shows or one over 400 kB, an icon is not in line-awesome, a `ui:` key is claimed twice, a
panel / tab / help spot has no topic, or the renderer would let raw HTML through.
