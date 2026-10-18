# UI robota × field dashboard — srovnání a společný jazyk (U2, 2026-10)

Zadání (Robert, 18. 10. 2026): původní Vitulus, osobitý, ale uhlazenější,
jednotný a **s nádechem field UI**. Tento dokument říká, co z field dashboardu
(`vitulus-field/dash/style.css`, služba `vitulus-dash` :8790) přebíráme, co
z Vitulusu zůstává, a jak se to píše (třídy). Implementace:
`assets/css/vt_tokens.css` (tokeny) + `assets/css/vt_field.css` (komponenty).

## 1. Srovnání v kostce

| Oblast | UI robota (před U2) | Field dashboard | Rozhodnutí |
|---|---|---|---|
| Podklad / plochy | `#1c2329` / `#232b32` / `#2b343c` / `#37434d` | `#1a2127` / `#232c33` / `#28323a` | **zůstává robot** (je to vzor, z něhož field vychází) |
| Logo, značka | `#ff7100`, Bitter v navbaru | totéž | zůstává |
| Akcent | `--bs-info` = `#5bc0de` (Slate) | **`#0dcaf0`** | **od P27 `#0dcaf0` jako field** (owner 18. 10.) — přebité u zdroje (`--bs-info`, `.btn-info`, `.btn-outline-info`, `--vt-accent`) ve `vt_tokens.css`; na plné azurové tmavý text `#10181d` (kontrast 11:1, bílý by měl 1,9:1) |
| Tóny stavu | ok / warn / err (+info) jako lineární gradient shora | `--st / --st-glow / --st-edge` a **radiální nádech z levého horního rohu** + jemná záře horní hrany | **přebíráme** radiální nádech a záři hrany, i tón `off` a `brand` |
| Tvar | panel 12 px, karta 10 px, štítek 3 px | panel 14, karta 10, štítek 3 | zůstává 12/10/3 (stejný princip „hranaté uvnitř kulatého“) |
| Elevace | jeden `--vt-shadow` | dvě úrovně: klid / hover-focus | **přebíráme** `--vt-elev-1/2` |
| Stav v hlavičce | `.vt-dot` bez halo | tečka s halo (`box-shadow 0 0 0 4px glow`) | **přebíráme** (`.vt-sdot`) |
| Štítky | `.vt-tag` (šedý obrys) | `.chip` s tečkou v barvě tónu, 3 px | **přebíráme** jako `.vt-pill` (plné `.vt-chip` pravého panelu zůstávají) |
| „Potřebuje tě“ | agentní pruh `#vagent_strip` — plné barvy (hnědá, vínová) | tónovaný panel, čtvercový štítek v tónu, tečka | **přebíráme** vzhled, pruh zůstává tam, kde je |
| Aktivita | log (monospace řádky) | řádek: čas · tečka · text · meta, pevná výška, pulzující tečka „běží“ | **přebíráme** `.vt-act` (pro agentní práci, nálezy, později feed) |
| Prázdné stavy | `.vt-empty` (text na střed) | tichý čárkovaný box, „dobrá zpráva“ | **přebíráme** |
| Typografie | 11/12/13/15, sans všude; titulky VERZÁLKY akcentem | 12/13/15/17/20/24; nadpisy panelů Bitter | škála **11/12/13/15/17/20/24**; titulek panelu zůstává VERZÁLKY akcentem (Vitulus), **velká čísla a verdikty Bitter** (nádech field) |
| Mezery | 4/8/12 | 4/8/12/16/24/32 | **přebíráme** celou řadu |
| Bez poskakování | částečně | tabulková čísla, rezervované sloty, elipsa | **přebíráme** jako pravidlo |

## 2. Co zůstává z Vitulusu (charakter)

- tmavá paleta Slate, navbar `#282b30`, logo `#ff7100`, Roboto + Bitter;
- titulek panelu = malé VERZÁLKY v akcentu, ikonové pilulky záložek;
- STOP plnou červenou (`--vt-danger`), nikdy jen nádechem;
- mapa jako hlavní plocha — panely přes ni (overlay `--vt-overlay`);
- hustší rozložení než field (robot UI je ovladač, ne čtení): základ 13 px.

## 3. Co přebíráme z fieldu (nádech)

1. **Tón jako proměnné** — každý povrch nese `--vt-st` (barva), `--vt-st-glow`
   (nádech) a `--vt-st-edge` (hrana). Varianta se zapne třídou tónu nebo
   `data-state`; komponenta pak tón jen „spotřebuje“.
2. **Radiální nádech** z levého horního rohu + **záře horní hrany**
   (`inset 0 1px 0 edge`) místo plochého gradientu. Bez pruhu vlevo.
3. **Tečka s halo** v hlavičce karty = stav na první pohled.
4. **Štítek s tečkou** (`.vt-pill`), čtvercový (3 px), tabulková čísla.
5. **Řádek aktivity** s pevnou výškou, čas vpravo, pulzující tečka pro „běží“.
6. **Banner „Needs you“** — tónovaný, štítek v tónu, text, meta vpravo.
7. **Tichý prázdný stav** a **skeleton** při načítání (nic neposkočí).

## 4. Třídy (jak to psát)

```html
<!-- karta s tónem: data-state (ok|warn|err|info|off|brand) (.vt-tone-* zůstává jen barvou textu) -->
<div class="vt-card" data-state="warn">
  <div class="vt-card-head">
    <span class="vt-sdot"></span><span class="vt-card-title">Battery</span>
    <span class="vt-end">12 min ago</span>
  </div>
  <div class="vt-big">23 %</div>            <!-- velké číslo: Bitter, tabulkové -->
  <div class="vt-pills"><span class="vt-pill" data-state="warn">LOW</span><span class="vt-pill">DOCK</span></div>
</div>

<!-- "Needs you" banner (vzhled #vagent_strip i samostatné použití) -->
<div class="vt-attn" data-state="warn"><span class="vt-attn-lab">Needs you</span>
  <span class="vt-attn-txt">Approve the undock</span><span class="vt-attn-meta">2 min</span></div>

<!-- řádky aktivity -->
<ul class="vt-acts">
  <li class="vt-act vt-busy" data-state="info"><span class="vt-sdot"></span>
    <span class="vt-act-txt">Agent checks the lidar</span><span class="vt-act-time">00:42</span></li>
</ul>

<p class="vt-empty-ok">Nothing waits for you.</p>
<span class="vt-skel"></span>
```

Tokeny (výběr): `--vt-ok/warn/err/info/off(-rgb)`, `--vt-glow-*`, `--vt-edge-*`,
`--vt-elev-1/2`, `--vt-fs-xs…--vt-fs-xxl`, `--vt-gap-1…6`, `--vt-font-num`.
Stará jména (`--vt-tint-*`, `--vt-shadow`, `--vt-fs-title`) zůstávají
platná — `--vt-tint-*` je teď radiální nádech, takže se změna projeví ve
všech existujících kartách naráz bez zásahu do HTML.

## 5. Otevřené rozhodnutí (pro Roberta)

- **Jedna azurová?** Robot `#5bc0de`, field `#0dcaf0`. Při spojení do jednoho
  UI by měla být jedna. Návrh: robot zůstává `#5bc0de` (je ve všech
  Bootstrap `info` prvcích a je méně křiklavá na mapě); field při integraci
  převezme `--vt-accent`. Opačná varianta = změnit `--bs-info` v
  `bs-theme-overrides.css` — jeden řádek, ale přebarví vše.
- Nadpisy panelů ve fieldu jsou Bitter normálním písmem, u robota VERZÁLKY
  akcentem. Navrhuji ponechat (rozlišuje „ovladač“ od „čtení“); Bitter jen pro
  velká čísla, verdikty a nadpisy v integrovaných field stránkách.

## 6. V rámu C (U1) — doladění integrovaných panelů

- Zvonek a **?** v navbaru jsou součástí plochy C: bez rámečku, hover =
  jemná výplň; čeká-li něco, zvonek nese tón (amber / červená) jako nádech;
  otevřený panel = výplň + hrana akcentu směrem k mapě (stejně jako pás menu).
- Akce na kartách: první (cesta ven, „Open in Support“) obrysová, další jsou
  textová tlačítka — místo tří obrysových boxů na kartu; 32 px myš / 40 px dotyk,
  na telefonu první akce přes celou šířku.
- Filtry Activity mluví jazykem záložek panelu (pilulky v tmavém pásu).
- Agentní panel (Chat / Work / Findings / Robot / Models): jeden nadpis sekce
  (malé verzálky, tlumený, počet jako čtvercový štítek), jeden prázdný stav
  (`.vagent-empty`, `.vpk-none`, `.vm-none` = čárkovaný box jako `.vt-empty`),
  načítání jako skeleton / dýchající text místo červeného řádku, štítky nálezů
  tónované (ne plné bloky), řádky nálezů jako karty bez pruhu vlevo, nativní
  checkboxy v barvě akcentu a tmavém schématu.

## 7. Noční kola P1–P11 (2026-10-18) — tlačítka, volby, formuláře

- **Tlačítka ploše** (P11): motiv Slate kreslil každému `.btn` svislý
  gradient, stín textu a černou hranu; teď jedna výplň, 1 px světlá hrana,
  akcent na hover (jako `.btn` field dashboardu). Barvy variant zůstávají.
- **Tónované akce** (P3, P10, P11): `success` / `warning` v těle panelu,
  Activate v seznamu map, Cancel v patičce = jemná výplň + hrana v tónu,
  plně až na hover. Plná zůstává jen destruktivní červená (STOP, STOP MOTOR)
  a hlavní GO akce panelu (Send goal = akcentová, jako `.btn-go`).
- **Vybraná volba skupiny** (P6): třída `.vt-sel` (akcentová výplň + hrana),
  nastavuje ji `vtSel(btn, on)` v `map_view.js` — žádné inline barvy textu.
- **Formuláře** (P3, P7, P10): checkbox = tmavá jamka / akcent když zapnuto
  (i `.form-check-input`), posuvník = tmavá dráha + azurový jezdec, vstupy
  vždy tmavé; řádky „popisek · hodnota · jednotka · vstup · akce“ mají pevné
  sloupce (popisek 146 px, jednotka 40 px), dvojice voleb (ON | OFF) jsou
  stejně široké.
- **Karty i tam, kde chyběly** (P4, P10): Dock lock, stav robota, Diag
  (souhrn + skupiny řádků tečka · název · zpráva, stabilní pořadí).
- **Ikony** (P5): v editoru mapy line-awesome místo emoji; barva nástroje
  jen na ikoně, aktivní nástroj v akcentu.

## 8. Rozhodnutí majitele 18. 10. (P27)

- **Akcent `#0dcaf0`** všude (viz tabulka § 1); hover výplní `#3dd5f3`,
  stisk `#0bb5d8`, text na plné azurové `#10181d`.
- **Nadpisy sekcí písmem Bitter** (jako `.sec-head h2` ve fieldu): sbalitelné
  sekce panelů (`drawer-sec`, `map-sec`, `mapedit-sec`, skupiny Needs you,
  nápověda), nadpisy sekcí agenta (RUNNING, ROBOT STATE, …), dny v Activity,
  skupiny v Diag. Karty, popisky a ovládání zůstávají Roboto.
- **Stavové ikony — čtyři barvy** (barva je přímo v PNG v
  `assets/img/robot_icons/`, přebarvené z neonových barev displeje Nextion;
  bez CSS filtrů). Kontrast proti ploše rámu `#282b30`:

  | Stav | Barva | Kontrast | Pozn. |
  |---|---|---|---|
  | OK | `#43d58b` | 7,5 : 1 | = `--vt-ok`, zelená fieldu |
  | varování | `#ffab45` | 7,4 : 1 | oranžová, světlejší a žlutější než logo `#ff7100` (5,2 : 1), aby nesplývala |
  | chyba | `#ff5f6d` | 4,8 : 1 | sytější než `#f1868f`, čitelná i na slunci |
  | bez dat / vypnuto | `#8a939b` | 4,6 : 1 | neutrální šedá |
