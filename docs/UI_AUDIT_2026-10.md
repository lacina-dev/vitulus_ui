# Audit designu UI (2026-10, úkol U1)

Prošlo se všech 5 panelů levého šuplíku (Marker, Settings, Map, Programs,
Agent), map editor, pravý panel a mobil (390×844) na dev instanci z větve
`ui-unify` (headless Chrome, screenshoty desktop 1440×900 + mobil).

## Kolik podob má „panel“ (stav před U1)

| Panel | Hlavička | Šířka | Záložky | Patička | Pozn. |
|---|---|---|---|---|---|
| Marker / Map / Settings | sdílená `#ui_drawer_head`: TITULEK + ⤢ + ✕ | 460 px | `drawer-pills` | žádná | Settings: 7 záložek se zalomí na 2 řádky |
| Programs | sdílená | **640 px** (`.wide`) | `drawer-pills` | žádná | „New program“ vpravo v těle |
| Map editor | **vlastní** sticky hlavička (sdílená skrytá třídou `.editor`), bootstrap `btn-outline-*` tlačítka | 460 px + vnitřní rám 452 px s odsazením | žádné | velké oranžové **Close editor** | na mobilu přes celou obrazovku → mapa není vidět, editovat nejde |
| Agent | sdílená, ale doplněná tečkou/stářím/▤/⌧/STOP | 460 px | **vlastní podtržené** `.vagent-tab` + pilulkové filtry | vstup chatu | karty zpráv s **barevným pruhem vlevo** |
| Pravý panel | vlastní `.rp-top`, sekce `h5` 10 px verzálky + ▾ | 196 px | – | – | jiný podklad `rgba(24,32,40,.94)`, rádius 6 px |

## Nejednotnosti

1. **Hlavičky**: tři různé (sdílená, editorová, agentní s vlastními tlačítky);
   tlačítka ⤢/✕ jednou vlastní CSS, jednou `btn-outline-info/warning`.
2. **Zaoblení**: šuplík 8 px, sekce 5 px, pravý panel 6 px, editor 6 px,
   tlačítka .375rem, štítky jednou pilulky, jednou hranaté.
3. **Sbalitelné sekce**: 4× duplicitní CSS (`map-sec`, `mapedit-sec`,
   `drawer-sec`, pravý panel `rp-sec`) + agentní sekce (NEEDS YOU…).
4. **Pruh vlevo** (zakázaný): aktivní mapa v seznamu map (zelený), karty
   agentního chatu (oranžový/jiný podle stavu), kritické události v logu.
5. **Záložky**: dva systémy (pilulky vs. podtržení); Settings se láme na dva řádky.
6. **Šířky**: 460 / 640 / 452 px podle panelu → šuplík „skáče“.
7. **Akce**: primární akce jednou nahoře vpravo v těle (Cancel navi, New
   program), jednou dole jako velké tlačítko (Close editor).
8. **Barvy**: každý `div_menu_*` má inline vlastní gradient a rámeček
   (v šuplíku přebito `!important`), pravý panel a log mají vlastní RGB.
9. **Mobil**: každý panel = celá obrazovka, mapa zmizí — u map editoru je
   to neopravitelné (kreslíš do mapy, kterou nevidíš). Pravý panel překrývá
   polovinu mapy.
10. **Mapa v různých podobách**: hlavní 3D pohled, top-down v editoru,
    malý náhled v Agent → Robot. Mapa sama je vždy na stejném místě (pozadí),
    mění se jen kamera; to zůstává, sjednocuje se panel kolem ní.

## Cíl (anatomie panelu)

Jeden panel = **hlavička** (titulek · meta/stav · akce vpravo: vlastní akce
panelu, ⤢, ✕ — vždy stejné ikonové tlačítko 36 px) → **záložky** (vždy
stejné pilulky, jeden řádek s vodorovným posunem) → **tělo** (sekce
`details` jednoho vzhledu, karty s jemným nádechem podle stavu, bez pruhu
vlevo) → **patička akcí** (primární akce panelu, např. Close editor).
Desktop: šuplík vlevo, jedna šířka 480 px (⤢ = široký/celá obrazovka).
Mobil: **bottom sheet** zespodu přes ~60 % výšky, mapa zůstane vidět nahoře;
⤢ = celá obrazovka. Stejné pro všechny panely včetně Agenta a editoru.

Tokeny: `assets/css/vt_tokens.css` (barvy, rádiusy, mezery, písmo),
komponenta: `assets/css/vt_panel.css`.

## Stav po U1 (větev `ui-unify`)

| Panel | Před | Po |
|---|---|---|
| Šuplík (všechny panely) | 460/640 px, rádius 8 px, různé hlavičky | jedna šířka 480 px, rádius 12 px, hlavička titulek · meta · akce · ⤢ · ✕, patička akcí |
| Map editor | vlastní hlavička + rám, na mobilu zakryl mapu | sdílená hlavička (meta = obsluhovaná mapa), Close editor v patičce, mapa rámovaná do nezakryté plochy |
| Agent | vlastní podtržené záložky, karty s pruhem vlevo | stejné pilulky, tečka/stáří v meta, ▤ ⌧ STOP ve slotu akcí, karty s nádechem stavu |
| Settings | záložky na 2 řádky | 1 řádek, posun do strany s náznakem pokračování |
| Map → uložené mapy | zelený/oranžový pruh vlevo | nádech celé karty |
| Řádek menu | aktivní vidět jen u Agenta | aktivní tlačítko vidět u všech pěti |
| Pravý panel | vlastní podklad, 6 px, nadpisy 10 px verzálky | tokeny šuplíku, 12 px, nadpisy sekcí jako v šuplíku |
| Log rozbalený | pravý panel a kamera přes něj (mobil) | čistá vrstva, bez pruhu u kritických událostí |
| Mobil | každý panel přes celou obrazovku | sheet zespodu 60 %, mapa nahoře vidět, ⤢/úchyt = celá obrazovka |

## Co zbývá (návrh další etapy)

- Těla záložek Settings (Motors/Power/Mower/Diag/Rosbag/IMU) jsou pořád
  starý Bootstrap s inline styly — přepsat na sekce/karty anatomie
  (stav motorů/baterie jako karty s nádechem).
- Path/Point: „Cancel navi“ a Programs: „New program“ přesunout do slotu
  akcí hlavičky nebo do patičky (jedno místo pro primární akci panelu).
- Agent → Robot: malý náhled mapy je třetí podoba mapy; zvážit odkaz
  „ukázat na mapě“ místo vlastního náhledu.
- Pravý panel na telefonu překrývá polovinu mapy — sbalit do jednoho
  řádku (mapa + baterie + Dock/Stop) s rozbalením.
- Sheet na telefonu: tažení úchytem (teď jen klepnutí = celá obrazovka).
