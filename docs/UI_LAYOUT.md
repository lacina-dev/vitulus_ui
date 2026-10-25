# Rám aplikace a rozložení (U1 kolo 5, U3 rám C3)

Jeden **rám** drží všechny oblasti UI: horní lišta (navbar + pás menu + pás
hlášek), spodní lišta, levý panel (šuplík) a mezi nimi mapa. Pravý stavový
panel, log, joystick a velká kamera jsou **výběžky rámu** (C frame 3, níže). Řídí to
`assets/js/vt_frame.js` (režim, CSS proměnné rámu) a sekce „frame“ ve
`assets/css/vt_panel.css`.

## Tvar rámu: „C“ (owner 2026-10-18)

Horní lišta (navbar + pás menu), levý sloupec a spodní lišta
jsou **jeden tvar v jedné barvě** (`--vt-frame-bg`), otevřený doprava k mapě.
Vnější rohy u okrajů stránky jsou ostré; dva vnitřní rohy, kde sloupec
přechází do horní a spodní lišty, jsou konkávně zaoblené (`--vt-frame-r`,
14 px) — mapa leží v „dutině“ C. Tlačítka pásu menu a spodní lišty nemají
vlastní rámečky; aktivní stav = jemná výplň + hrana akcentu směrem k mapě.

| Stav | Záda C |
|---|---|
| panel zobrazený (PC, na šířku) | levý panel = záda C, dutina začíná za ním |
| panel skrytý | úzký hřbet 12 px (telefon 6 px) `#vt_c_spine`, klik = otevře panel; na PC se mapa odsune za hřbet |
| telefon na výšku, sheet otevřený | sheet je spodní část C, která vystoupala; hřbet končí na sheetu, zaoblený roh dutiny sedí nad sheetem |

Hlášky jsou uvnitř dutiny (PC, na šířku) nebo v horní liště (telefon na výšku).

### Výběžky rámu (C frame 3, owner 2026-10-18)

Pravý panel, log a joystick patří do obvodové linky C: stejná plocha
(`--vt-frame-bg`), žádný vlastní rámeček ani stín; u okraje stránky ostré
rohy, kde končí v dutině konvexně zaoblené, kde vystupují z rámu konkávní roh
(`#vt_c_tr`, `#vt_c_jb`, `#vt_c_lr`). Bez rozbaleného čehokoli čte celek jako C
(pravá strana převážně otevřená); rozbalené panely čelní stranu částečně
uzavřou.

| Výběžek | Kde | Rohy |
|---|---|---|
| Pravý stavový panel | visí z horní lišty (bez mezery) podél pravé hrany; končí 14 px nad spodní lištou / malým logem / joystickem (otevřená čelní strana) | konkávní vlevo nahoře (`#vt_c_tr`), konvexní vlevo dole |
| Malý log | vyrůstá ze spodní lišty od hřbetu C / levého panelu po joystick / pravou hranu (nikdy pod panelem — panel jde až ke spodní hraně); tlačítko Expand uvnitř pruhu vpravo nahoře | roh hřbetu `#vt_c_bl` sedí nad logem |
| Celý log | roste ze spodní lišty do dutiny pod pásem hlášek, vedle pravého panelu / joysticku (8 px mezera) | konvexní vpravo nahoře, konkávní pata vpravo (`#vt_c_lr`) |
| Joystick | stojí na spodní liště u pravé hrany vedle malého logu; když by se vedle sebe nevešly (< 420 px na log), stojí NA logu (telefon na výšku); když by rozbalenému pravému panelu nad ním zbylo < 240 px (telefon na šířku), stojí vedle sloupce pravého panelu a panel sahá až k logu | konvexní vlevo nahoře, konkávní pata vlevo (`#vt_c_jb`) |
| Joystick = panel jízdy (2026-10-18, kolo 2) | **přednost před řádky výše i níže**: PC / na šířku = **pata pravého sloupce** — stojí na spodní liště (na malém logu při `vt-joy-on-log`) u pravé hrany, šířka = pravý panel (`--vt-frame-col-w`), panel jízdy = **prstenec** (2026-10-25, varianta C2 „Celý prstenec“, `vt_joy.js` buildRing): jeden kruhový ovladač o průměru `--vt-ring-d` (PC 184 px → panel 196 × 200 px; telefon na šířku 150 px → ~166 px), horní ~2/3 = 7 dílků rychlosti (azurová → oranžová), − / + na švech, Pomalu/Středně/Rychle podél dílků (svítí režim robota), kapsle „0.25 m/s · RYCHLOST · POMALU“ nad páčkou, spodní ~1/3 = ikony Motory (oranžová VYP / zelená ZAP / šedá neznámo) a Klávesy (azurová ZAP; na dotyku není a Motory zaberou celý spodek), ? v rohu = karta „Řízení ručně“; stav = okraj páčky; řádek pod prstencem jen ve výjimečných stavech) stojí na spodní liště; vt_frame.js počítá sloupec (`vt-col-on`, výška panelu jízdy) jako dřív joystick (pravý okraj logu, L-log, vedle sloupce pravého panelu), right_dock.js končí pravý panel nad ním. Telefon na výšku = pás přes celou šířku na spodní liště (`vt-joy-band`, započtený do `--vt-frame-bottom`, sheet stojí na něm): vlevo krátký text (název + tip, ve výjimečném stavu místo tipu hláška), vpravo prstenec 150 px, pás ~164 px | konvexní vlevo nahoře, konkávní pata vlevo (`#vt_c_jb`, `vt-col-on`) |
| Levý panel s logem | (2026-10-25) log je vždy vedle panelu, panel jde až ke spodní hraně; když vedle logu nezbude místo na panel jízdy (< 420 px na log), panel jízdy stojí NA logu (`vt-joy-on-log`); dřívější `vt-log-wide` (log pod panelem) zrušené | — |

### Kamera (C frame 3)

Přepínač **Off / S / L** v hlavičce sekce Camera pravého panelu, **Alt+C**
(small ↔ large), klik na obraz (zoom). Large si stav pamatuje
(`vitulus_cam_large`). Stream běží jen když je kamera na obrazovce.

| Stav | PC / na šířku | Telefon na výšku |
|---|---|---|
| Off | sekce Camera sbalená nebo pravý panel zavřený — stream stojí | totéž (rozbalený řádek → sekce) |
| Small | živý náhled ve slotu pravého panelu | v rozbaleném pravém panelu |
| Large | kamera vyplní dutinu C (obraz 4:3 vycentrovaný, od pásu hlášek po spodní část rámu, vlevo od pravého panelu); **mapa jde do slotu pravého panelu** (okno vyříznuté maskou) — klik na malou mapu = zpět na small (žádný omylem odeslaný cíl). Joystick a hlášky zůstávají nad ní / mimo ni. Otevření editoru mapy vrátí small. Sbalený pravý panel (telefon na šířku): kamera 4:3 v levém horním rohu dutiny, mapa vedle. | pás přes horní část dutiny (pod řádkem pravého panelu, nejvýš ½ dutiny), mapa pod ním; tlačítko kamery ve sbaleném řádku pravého panelu přepíná large / vypnuto |
| Panel ustoupí (sheet, celý drawer) | — | velká kamera se pozastaví a vrátí se s panelem; zavření panelu / sbalení sekce = vypnuto |

### Nápověda (help pane, 18. 10. 2026)

Malé **?** v hlavičce levého panelu (před ⤢ / ✕; v kompaktní hlavičce na
telefonu v řádku záložek), **?** v navbaru (PC), **?** v hlavičce sekce Navi
pravého panelu a v liště logu otevře nápovědu k tomu, co je otevřené (panel
**i jeho záložka**). Obsah = `docs/help/*.md` (`vt_help.js`, `docs/help/README.md`).

| | PC / na šířku | Telefon na výšku |
|---|---|---|
| Poloha | výběžek u pravé hrany od pásu menu ke spodní liště / malému logu (nad joystickem končí nad ním), přes pravý panel; z 9 (pod lištami) | sheet nad spodní lištou (72 % výšky, úchyt = celá výška), z 1001 nad sheetem panelu |
| Zavření | ✕, Esc (zavře nápovědu a zároveň je to STOP, panel zůstane) | ✕ |
| Nikdy | neotevře se sama, nemá backdrop — mapa i panel jdou dál ovládat | totéž |

### Velký STOP (owner 2026-10-25: kulatý hřib vpravo nahoře)

Jeden velký červený **STOP** (`#vt_stop_big`, vt_frame.js) — **kulatý hřib**
jako 18.–19. 10. (červená hlava `.vt-estop-cap` v tmavé objímce
`.vt-estop-plate`, „STOP“), ale na místě varianty A: v **pravém horním rohu,
v hlavě pravého sloupce** („Tlačítko STOP chci kulaté jako bylo“). Totéž
tlačítko na všech obrazovkách, vždy na stejném místě, nikdy nic nezakrývá a nic
nezakrývá jeho (z-index 10050: nad panely, logem, nápovědou, dialogy i
zvětšeným obrázkem). Klikací je jen hlava (tlačítko = hlava). Stiskne skrytý
`#btn_stop_all` (map_view.js publikuje všechna zastavení, `docs/STOP_PATHS.md`
ve vitulus_agent) a pustí páčku; **Esc** udělá totéž vždy (capture fáze, i při
psaní a v dialogu; nápověda / obrázek / dialog Esc dostanou dál; hlava se
krátce promáčkne, `vt-pressed`). Mezerník STOP není (nikdy nebyl). STOP panelu
Agent (`#vagent_stop`) je jiná věc — zastaví misi agenta.

| | PC / na šířku (`vt-m-dock`, `vt-m-overlay`) | Telefon na výšku (`vt-m-sheet`) |
|---|---|---|
| Velikost | hlava `--vt-estop-cap` 68 px, objímka `--vt-estop-rim` 6 px (okno ≤ 560 px: 54 / 5 px) | 58 px, objímka 4 px; dotyková plocha = celá hlava (≥ 44 px) |
| Poloha | **přímo v pravém horním rohu okna**: hlava `--vt-estop-rim` od horní i pravé hrany, vnější hrana objímky se dotýká obou hran | totéž (pravý konec navbaru) |
| Napojení | objímka = disk v barvě rámu (`.vt-estop-plate`, mělký kruhový výřez kolem hlavy); horní lišta do ní vbíhá zleva jako jeden tvar. PC: lišta (80 px) je vysoká jako objímka — bez pravého panelu se dolní roh pásu menu stáčí podle objímky. Nízké okno (řádek 44 px): objímka visí pod řádek; s pravým panelem hlava sloupce `#vt_c_head` (plocha rámu do paty objímky, konkávní roh `#vt_c_tr` u řádku), bez něj zaoblený přechod `#vt_stop_fillet` (SVG, placeStop). Pravý sloupec začíná pod hlavičkou i objímkou (`--vt-frame-col-top`, right_dock.js) | objímka v ploše navbaru a pásu menu |
| Co uhne | řádky horní lišty (navbar, pás menu) nechávají roh volný: `padding-right: --vt-stop-zone` (= objímka + 6 px, placeStop) | navbar; pás menu jen když do něj objímka zasáhne (`vt-stop-menu`) |
| Spodek | levý panel i hřbet jdou až ke spodní hraně, spodní lišta začíná za nimi (sekce níž) | spodní lišta a pás jízdy volné pro palce |

### Spodní lišta (část C)

| | PC | Telefon (na výšku i na šířku, dotyk) |
|---|---|---|
| Začátek (owner 2026-10-25: „tlačítko Log by mělo začít až za levým panelem a panel jet až dolů“) | lišta začíná **za otevřeným levým panelem** (`--vt-frame-bar-left` = šířka panelu), se zavřeným panelem **za hřbetem** `#vt_c_spine` (12 px); panel i hřbet jdou až ke spodní hraně okna (`vt-c-backdown`); **Log** je první tlačítko hned vpravo od panelu. Panel přes celou šířku (⤢) stojí na liště, lišta má celou šířku | na šířku jako PC; na výšku sheet stojí na liště (lišta i pás jízdy přes celou šířku, `vt-c-backdown` se nenastaví) |
| Pořadí (2026-10-25: Log a Joystick prohozené) | Log · Follow · **Joystick** | Log · *volné místo 84 px* · Follow · **Joystick** |
| Joystick = ouško panelu jízdy | na pravém konci, šířka a poloha = pravý sloupec / panel jízdy (`--vt-frame-col-w`; s panelem jízdy vedle rozbaleného pravého panelu posunuté o `--vt-frame-joy-r`) | na výšku: pravý konec lišty pod prstencem pásu jízdy, 104 px; na šířku: jako PC (pod panelem jízdy). Na dotyku drží Follow + Joystick pravou polovinu, takže mezera 84 px zůstává uprostřed (s panelem jízdy vedle pravého panelu jde Follow doleva k Logu a mezera je hned vedle ouška) |
| Poloha | spodní okraj | **úplně dole u spodní hrany**, tlačítka nad `env(safe-area-inset-bottom)`; střed volný pro systémové tlačítko / gesto Androidu a Chromu. Když otevřený panel na šířku sahá přes střed obrazovky (lišta začíná až za středem − 140 px), mezera odpadne (`vt-bar-nogap`) — gesto pak leží nad patou panelu |
| STOP | v liště není — velký STOP je v pravém horním rohu (sekce výš); `#btn_stop_all` zůstává skrytý jako jeho obsluha | totéž |
| Kamera | v pravém panelu (sekce Camera) | v pravém panelu: ▾ rozbalí sbalený řádek, sekce Camera |

**Ouško Joystick** (owner 2026-10-25: „Joystick bude u joysticku a bude s ním
jakoby spojený“): tlačítko Joystick je úchyt panelu jízdy, ne samostatná krabička.

| Stav | Vzhled |
|---|---|
| panel jízdy zavřený | ouško vystupuje 12 px (`--vt-joy-tab-h`) z lišty: plocha rámu, konvexní roh vlevo nahoře, konkávní přechod do lišty vlevo, ostrý roh u pravé hrany stránky, uprostřed úchyt (pruh akcentu 28 × 3 px), u popisku **▴** = otevře panel nad sebou; pravý panel končí nad ním se stejnou mezerou jako nad lištou (right_dock.js) |
| panel jízdy otevřený | panel stojí na oušku, jeden sloupec až ke spodní hraně bez švu (žádná hrana akcentu mezi nimi), ouško jemně podsvícené, **▾** = zavřít; `aria-expanded` + `aria-controls="joy_view"` |
| ouško nevystupuje | když na tom místě leží jiná část rámu: malý / celý log, sheet panelu na telefonu, panel přes celou šířku, nápověda — třída `vt-joy-tab` na `<body>` (vt_frame.js), nápověda přes `:has(#vt_help.open)` |

## Režimy (třída na `<body>`)

| Režim | Kdy | Levý panel |
|---|---|---|
| `vt-m-dock` | šířka ≥ 1024 px a výška ≥ 500 px (PC, velký tablet) | **dokovaný sloupec** 480 px: mapa se zúží vedle něj, nic nepřekrývá |
| `vt-m-overlay` | 576–1023 px nebo nízké okno (telefon na šířku, malý tablet) | sloupec 480 px (max. 60 % šířky) **přes mapu**, hrany lícují s lištami, mapa se nezužuje |
| `vt-m-sheet` | šířka < 576 px (telefon na výšku) | **sheet** navazující na spodní lištu (60 % výšky; ⤢/tah nahoru = celá výška) |

Stav panelu: **zobrazený** (`vt-panel-open`) / **skrytý** (mapa na celou plochu
mezi lištami). Přepínač: tlačítko ◧ vlevo v pásu menu (`#btn_panel_toggle`),
**Alt+P** na PC, ✕ v hlavičce panelu skryje, na telefonu i tah sheetu dolů.
Znovuotevření vrátí poslední panel (`vitulus_last_panel`); stav otevřeného
panelu přežije reload (`vitulus_open_panel`, beze změny z dřívějška).

## Navbar (horní lišta, owner 2026-10-25, varianta A „Tři zóny“)

`vt_header.js` + `vt_header.css` (třídy na `<body>`, `--navbar-h`), čísla
`status_header.js` + `status_header.css`. Zásada: **žádné `flex-grow` dělení
zbylého místa, které posouvá střed** — levá zóna má pevnou šířku, pravá pevné
sloty, takže se při změně čísel nic nehýbe (naměřeno 0,0 px) a lišta se nikdy
nezalomí (`flex-wrap: nowrap`, užší okno věci ubírá).

| Rozložení | Třída | Výška | Obsah |
|---|---|---|---|
| PC / tablet | `vt-h-pc` | navbar 44 + pás menu 36 = 80 px | vlevo logo + tečka (pevně 172 px), ikony stavu od x = 184 · vpravo systém v pevných slotech · ? · zvonek · Restart · ⋯, konec v objímce STOPu |
| telefon na výšku (< 576 px) | `vt-h-ph` | navbar 52 + menu 44 + ikony 28 + hlášky 28 = 152 px | navbar: logo, tečka, zvonek, Restart, ⋯, STOP; ? a systém v ⋯ |
| nízké okno (výška < 500, telefon na šířku) | `vt-h-row` | jeden řádek 44 px | tečka · tlačítka panelů (`#row_menu` se přestěhuje do navbaru) · ikony po skupinách · zvonek · Restart · ⋯; logo, ? a systém v ⋯; STOP v rohu nad pravým sloupcem |

| Místo | Obsah | Poznámka |
|---|---|---|
| vlevo | logo VITULUS + **tečka spojení** (`#conn_status`, `data-state`), zóna pevně 172 px | zelená = spojeno, oranžová pulzující = připojuji, červená = bez spojení; slova jen v `title` + `aria-label` (en/cs, `mapview.conn.*`); klik / Enter = hned znovu připojit (`ConnectionStatus`, map_view.js) |
| střed | **řada stavových ikon** (`#status_div`, status_header.js) od pevného x: skupiny počasí · senzory · pojezd · teploty · napájení | počasí = `#ico_rain` (klik = radar, rain_alert.js); `vt-h-sum` (< 1100 px a nízké okno): 1 ikona za skupinu = nejhorší (`.sh-rep`: červená > oranžová > zelená > šedá) |
| vpravo | **systém** `#system_monitor_header` (CPU · RAM · ↓ ↑) · `.vt-hdr-vdiv` · ? `#btn_help` · zvonek `#btn_needs` · Restart `#btn_robot_restart` (jen ikona, potvrzení `appjs.restart.confirm`) · ⋯ `#btn_hdr_more` | pořadí dělá CSS `order`, ne DOM (moduly vkládají tlačítka před `#btn_navbar_toggler`, který je skrytý); řádek nechává volný roh STOPu (`padding-right: --vt-stop-zone`) |
| ⋯ menu `#vt_hdr_menu` | Fullscreen (`VTApp.toggleFs`, jen kde je Fullscreen API), jazyk EN / CS (`VTI18n.setLang`, totéž co Settings › App); na telefonu a nízkém okně i ? (`VTSupport.help`) a systém (`VTSys.section()`), na nízkém okně navíc logo | malá tečka na ⋯ (telefon, nízké okno), když systém hlásí jantar / červenou |

**Systém v pevných slotech**: Roboto `tabular-nums`; procenta ve slotu 3ch + „%“;
síť: hodnota ve slotu 3ch (8.4 · 88 · 317) + jednotka v boxu 2,9em; vyhlazení
EMA τ ≈ 6 s (vzorek /api/system každé 2 s); jednotka s hysterezí (nahoru při
1000, dolů pod 900). Blok má pevnou šířku 266 px (`vt-h-w1600`: 186 px, jen ↓).
Barvy jen když je potřeba: CPU podle **průměru za 30 s** (≥ 90 % jantar, ≥ 97 %
červená), RAM / disk podle hodnoty (≥ 90 / ≥ 97 %). Klik = karta `#sh_sys_card`
(kruhy CPU · RAM · DISK, síť, průměr, zátěž, odkaz Settings › Diag).

**Zúžení** (jen PC, nic se nezalamuje): `vt-h-w1600` < 1600 síť jen ↓ ·
`vt-h-w1366` < 1366 systém jako čip `#btn_sys_chip` (barva nejhorší z CPU / RAM /
disk, klik = karta) · `vt-h-w1280` < 1280 pás menu jen ikony (44 px, název v
tooltipu) · `vt-h-w1100` < 1100 ikony po 1 za skupinu. Logo, tečka, ?, zvonek, ⋯
a STOP se neskrývají nikdy.

**Pás menu** (PC): tlačítka přirozené šířky zleva (`flex: 0 0 auto`), ne
roztažená přes lištu; bez pravého panelu se dolní pravý roh pásu stáčí podle
objímky STOPu (`--vt-collar-r`).

**Hlášky = jeden překryv** v horní části dutiny (PC, nízké okno), který nic
neodsouvá: vlevo agent (`#vagent_bars`: pás `#vagent_strip`, odemčený dok,
STOP latch — pilulky max 230 px, celý text v tooltipu), uprostřed hláška robota
(`.vt-notice-row`, jeden řádek s elipsou, celý text v `title`) v pevném slotu
(od `cleft + 254 px`, symetricky když je dutina ≥ 1220 px). `layoutBars`
(agent_chat.js) už pás menu neposouvá (`margin-top: 0 !important`), mapa ani
pravý panel se při objevení pásu agenta nepohnou. Telefon na výšku: řádek
hlášek 28 px je součást horní lišty (agent vlevo, hláška vedle).

**Výpadek spojení** ohlásí i pás hlášek (`#span_status_info` třída
`vt-notice-conn`, červená hrana, text `mapview.conn.lost`) — jakmile spojení
spadne (nebo selže první pokus), zůstane do obnovení, po připojení zmizí.
Navbar je vidět ve všech polohách (LayoutManager ho už neschovává; na nízkém
okně je to jediný řádek hlavičky a mapa pod ním běží celou výškou).

## Matice: kde je která oblast

### PC (`vt-m-dock`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | navbar 44 px + pás menu 36 px = 80 px, celá šířka, končí v objímce STOPu | totéž |
| Hlášky (`#span_status_info`, `#vagent_bars`) | překryv v horní části dutiny (agent vlevo, hláška v pevném slotu), nic neodsouvá | totéž od hřbetu |
| Levý panel | sloupec 480 px od pásu menu **až ke spodní hraně okna** (spodní lišta začíná za ním), sdílené hrany, bez stínu | hřbet 12 px až ke spodní hraně |
| Mapa | vpravo od panelu (plátno se zúží) | celá plocha mezi lištami |
| Pravý stavový panel | výběžek z horní lišty u pravé hrany (hned pod pásem menu a pod STOPem, který je hlavou sloupce), konec nad logem / joystickem | totéž |
| Log malý | výběžek spodní lišty od panelu po joystick (nebo pravou hranu) | od hřbetu po joystick / pravou hranu |
| Log celý | ze spodní lišty do dutiny pod hlášky, vlevo od panelu; **tvar L (P21)**: vedle pravého panelu končí u jeho hrany, pod ním pokračuje až k joysticku (bez joysticku k pravé hraně) — log, pravý panel a joystick jsou jedna plocha rámu, otevřené zůstává jen okno mapy mezi spodkem pravého panelu a joystickem | totéž od hřbetu |
| Log skrytý | — (tlačítko ≡ ve spodní liště) | — |
| Joystick | stojí na spodní liště u pravé hrany vedle malého logu, pod ním ouško Joystick | totéž |
| Kamera large | dutina vlevo od pravého panelu, mapa ve slotu pravého panelu | totéž |
| Spodní lišta | od pravé hrany panelu po pravou hranu okna (Log hned vedle panelu); panel přes celou šířku: celá šířka | od hřbetu po pravou hranu |

### Telefon na šířku / malý tablet (`vt-m-overlay`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | při výšce < 500 px jeden řádek 44 px (`vt-h-row`: tečka · panely · ikony po skupinách · zvonek · Restart · ⋯); vyšší okno jako PC | totéž |
| Hlášky | překryv v horní části dutiny vpravo od panelu (agent vlevo, hláška v pevném slotu) | totéž od hřbetu |
| Levý panel | sloupec přes mapu, min(420 px, 52 % šířky), od pásu menu až ke spodní hraně (spodní lišta začíná za ním, bez mezery pro gesto), stín vpravo | hřbet až ke spodní hraně, lišta za ním |
| Hlavička panelu (výška ≤ 480 px) | panely se záložkami (Settings, Map, Programs, Agent, Support): akce hlavičky (STOP agenta, ⤢, ✕) sedí na pravém konci řádku záložek, titulek a meta ustoupí (P20); Marker a editor mapy mají hlavičku beze změny; řádek záložek drží při rolování nahoře (P24); editor mapy na šířku skryje patičku Close editor, zavírá ✕ v hlavičce (P25) | — |
| Mapa | celá plocha (panel ji částečně kryje) | celá plocha |
| Pravý stavový panel | **sbalený řádek** (mapa · Pose · GNSS · baterie · kamera · ▾) visí z pásu menu u pravé hrany; rozbalený = sloupec, joystick pak stojí vedle něj | totéž |
| Log malý | pruh vpravo od panelu (panel jde až dolů); když vedle něj nezbude 420 px i na panel jízdy, panel jízdy stojí na logu | od hřbetu po joystick |
| Log celý | plocha vpravo od panelu, pod hláškami, ze spodní lišty, před joystickem | od hřbetu, před joystickem / pravým panelem |
| Joystick | na spodní liště u pravé hrany vedle logu (s rozbaleným pravým panelem vedle jeho sloupce) | totéž |
| Kamera large | se sbaleným pravým panelem: 4:3 v levém horním rohu dutiny, mapa vedle | 4:3 v levém horním rohu dutiny |

### Telefon na výšku (`vt-m-sheet`)

| Oblast | Panel zobrazený (sheet) | Panel skrytý |
|---|---|---|
| Horní lišta | navbar 52 + pás menu 44 | totéž |
| Ikonky + hlášky | součást horní lišty (plocha rámu), pod pásem menu: ikony 28 px v jednom řádku, hlášky 28 px (agent vlevo + hláška s elipsou) — celkem 152 px | totéž |
| Pravý stavový panel | — (při otevřeném sheetu ustoupí) | sbalený řádek visí z horní lišty u pravé hrany (📷 = large kamera, ▾ rozbalí) |
| Levý panel | sheet od spodní lišty, 60 % výšky (celá výška ⤢) | — |
| Hlavička panelu | panely se záložkami: STOP agenta, ⤢, ✕ na pravém konci řádku záložek, titulek panelu v řádku úchytu sheetu vlevo (P27); Marker a editor mapy beze změny | — |
| Mapa | nad sheetem (editor ji rámuje do volné části) | celá plocha |
| Log malý | za sheetem (sheet je stoupající spodek C) | výběžek spodní lišty přes celou šířku (od hřbetu) |
| Log celý | od hlášek/pravého panelu ke spodní liště; otevřený sheet je nad ním | od řádku pravého panelu ke spodní liště, joystick zůstává nad ním |
| Joystick | pás prstence na spodní liště, **sheet stojí na něm** (nikdy ho nepřekryje — `vt-joy-band`) | pás prstence na spodní liště (text vlevo, prstenec 150 px vpravo) |
| Kamera large | pozastavená (pravý panel ustoupil) | pás v horní části dutiny, nejvýš ½, mapa pod ním |

## Ovládání rámu

| Ovládání | PC | Telefon |
|---|---|---|
| Zobrazit / skrýt panel | ◧ Panel v pásu menu, **Alt+P**, ✕ (Esc už panel neskrývá — Esc = STOP) | ◧, ✕, tah sheetu dolů |
| Popisky tlačítek | ikona + text v pásu menu i spodní liště | jen ikona; název v `aria-label` / tooltipu |
| Stav přepínačů | aktivní panel, zapnutá kamera / joystick / log / sledování robota = podsvícené tlačítko (`vt-on`, `aria-pressed`) | totéž |
| Fokus z klávesnice | jeden viditelný prstenec (`:focus-visible`, barva akcentu) v liště, panelu, pravém panelu i logu | — |
| Animace | krátké (0,15–0,2 s); `prefers-reduced-motion: reduce` je vypne | totéž |

## Pravidla

- Hlášky a ovládání (lišty, panel, pravý panel) **nic nepřekrývá** — log ani
  v celé velikosti, ani velká kamera (začíná pod pásem hlášek); STOP vždy
  vpravo nahoře v hlavě pravého sloupce, kulatý hřib (telefon na výšku: pravý konec navbaru); zapnutý joystick je vždy nahoře (z 9) a dosažitelný; vrstvy: lišty a pás menu/hlášek (z 10) > panel (1000,
  ale mimo lišty) > pravý panel (5) / log (8) mimo sebe navzájem.
- Log má 3 stavy: skrytý ↔ malý (≡ ve spodní liště) a malý ↔ celý (úchyt
  „Expand“ / „Collapse“ v liště logu); stav si pamatuje (`vitulus_hud_log`,
  `vitulus_log_expanded`).
- Změna šířky plochy mapy (dok/skrytí panelu) vyvolá `resize`, plátno 3D
  mapy se přepočítá.

## CSS proměnné rámu (nastavuje vt_frame.js)

| Proměnná | Význam |
|---|---|
| `--vt-frame-top` | spodní hrana pásu menu (px od horní hrany okna), aspoň pata STOPu + 4 px |
| `--vt-stop-pad` / `--vt-stop-zone` | polštář nad tlačítky pásu menu, aby byla horní lišta vysoká jako objímka STOPu / roh horní lišty, který řádky nechávají STOPu (šířka sloupce; telefon na výšku objímka + 6 px) |
| `--vt-frame-notice-b` | spodní hrana pásu hlášek (nebo `--vt-frame-top`, když je prázdný) |
| `--vt-frame-bottom` | výška zóny spodní lišty (od spodní hrany okna) |
| `--vt-frame-bar-left` | levý okraj spodní lišty: šířka otevřeného panelu / hřbet; 0 = sheet nebo panel přes celou šířku (`vt-c-backdown` = panel a hřbet jdou až ke spodní hraně) |
| `--vt-frame-left` | šířka obsazená levým panelem v režimu dock/overlay (0 = skrytý) |
| `--vt-frame-dock` | o kolik se zúží mapa (jen `vt-m-dock`) |
| `--vt-frame-rp-w` | šířka pravého panelu v ploše mapy (0 = zavřený / telefon) |
| `--vt-frame-rp-b` | spodní hrana pravého panelu (telefon: sbalený řádek) |
| `--vt-frame-log-h` | výška malého logu, když je zobrazený (jinak 0) |
| `--vt-frame-cleft` / `--vt-frame-cbottom` | levý okraj dutiny (panel / hřbet) / dno dutiny u hřbetu (lišta + malý log, vršek celého logu, vršek sheetu) |
| `--vt-frame-log-left` / `--vt-frame-log-right` | okraje malého logu (hřbet / pravá hrana panelu / šířka joysticku nebo 0) |
| `--vt-frame-ledge` | vršek spodní části rámu (lišta + malý log) |
| `--vt-frame-joy-w` / `--vt-frame-joy-b` / `--vt-frame-joy-r` | šířka joysticku / jeho spodek (lišta, nebo lišta + log) / odsazení zprava (vedle sloupce pravého panelu) |
| `--vt-frame-rp-left` | levá hrana pravého panelu (roh `#vt_c_tr`) |
| `--vt-frame-logfull-r` | pravý okraj celého logu (pravý panel / joystick + 8 px) |
| `--vt-cam-l/t/w/h`, `--vt-cam-cw/ch`, `--vt-cam-ml` | box velké kamery a obraz 4:3 v něm (stream max. 640 px šířky, škáluje CSS) |
| `--rp-cam-*`, `--rp-hole-x/y` (right_dock.js) | slot kamery v pravém panelu; při large v něm leží mapa a panel má na tom místě okno (maska) |

Třídy na `<body>`: `vt-c-rp`, `vt-c-log`, `vt-c-logfull`, `vt-joy-on`,
`vt-joy-on-log`, `vt-joy-beside-rp`, `vt-c-backdown`, `vt-bar-nogap`, `vt-stop-menu`, `vt-cam-large`,
`vt-map-mini`, `vt-cam-paused`. Proměnné i třídy se zapisují jen při změně
(žádná smyčka observerů); poloha výběžků nezávisí na poloze pravého panelu,
takže se vt_frame.js a right_dock.js nemohou honit.

## Požadavky na tokeny (pro U2 / vt_tokens.css)

- `--vt-dock-w-desktop` (dnes 480 px natvrdo jako `--vt-drawer-w`) — šířka
  dokovaného sloupce, ať ji jde ladit spolu se vzhledem.
- `--vt-frame-border` — barva sdílených hran rámu (dnes `--vt-border-strong`).
- `--vt-frame-log-h` výchozí výška malého logu (dnes 106 px / 62 px na nízkém
  okně, natvrdo v index.html a right_dock.css).
