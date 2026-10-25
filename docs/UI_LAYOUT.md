# Rám aplikace a rozložení (U1 kolo 5, U3 rám C3)

Jeden **rám** drží všechny oblasti UI: horní lišta (navbar + pás menu + pás
hlášek), spodní lišta, levý panel (šuplík) a mezi nimi mapa. Pravý stavový
panel, log, joystick a velká kamera jsou **výběžky rámu** (C frame 3, níže). Řídí to
`assets/js/vt_frame.js` (režim, CSS proměnné rámu) a sekce „frame“ ve
`assets/css/vt_panel.css`.

## Tvar rámu: „C“ (owner 2026-10-18)

Horní lišta (navbar + pás agenta + pás menu), levý sloupec a spodní lišta
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
| Malý log | vyrůstá ze spodní lišty od hřbetu C po joystick / pravou hranu; tlačítko Expand uvnitř pruhu vpravo nahoře | roh hřbetu `#vt_c_bl` sedí nad logem |
| Celý log | roste ze spodní lišty do dutiny pod pásem hlášek, vedle pravého panelu / joysticku (8 px mezera) | konvexní vpravo nahoře, konkávní pata vpravo (`#vt_c_lr`) |
| Joystick | stojí na spodní liště u pravé hrany vedle malého logu; když by se vedle sebe nevešly (< 420 px na log), stojí NA logu (telefon na výšku); když by rozbalenému pravému panelu nad ním zbylo < 240 px (telefon na šířku), stojí vedle sloupce pravého panelu a panel sahá až k logu | konvexní vlevo nahoře, konkávní pata vlevo (`#vt_c_jb`) |
| Joystick = panel jízdy + velký STOP (2026-10-18, kolo 2) | **přednost před řádky výše i níže**: PC / na šířku = **pata pravého sloupce** — `#vt_stop_big` (64 px, vždy vidět) stojí na spodní liště (na malém logu při `vt-joy-on-log`) u pravé hrany, šířka = pravý panel (`--vt-frame-col-w`), panel jízdy = **prstenec** (2026-10-25, varianta C2 „Celý prstenec“, `vt_joy.js` buildRing): jeden kruhový ovladač o průměru `--vt-ring-d` (PC 184 px → panel 196 × 200 px; telefon na šířku 150 px → ~166 px), horní ~2/3 = 7 dílků rychlosti (azurová → oranžová), − / + na švech, Pomalu/Středně/Rychle podél dílků (svítí režim robota), kapsle „0.25 m/s · RYCHLOST · POMALU“ nad páčkou, spodní ~1/3 = ikony Motory (oranžová VYP / zelená ZAP / šedá neznámo) a Klávesy (azurová ZAP; na dotyku není a Motory zaberou celý spodek), ? v rohu = karta „Řízení ručně“; stav = okraj páčky; řádek pod prstencem jen ve výjimečných stavech) stojí na spodní liště; vt_frame.js počítá sloupec (`vt-col-on`, výška STOP + panel) jako dřív joystick (pravý okraj logu, L-log, vedle sloupce pravého panelu), right_dock.js končí pravý panel nad horním z nich. Telefon na výšku = pás přes celou šířku na spodní liště (`vt-joy-band`, započtený do `--vt-frame-bottom`, sheet stojí na něm): vlevo krátký text (název + tip, ve výjimečném stavu místo tipu hláška), vpravo prstenec 150 px, pás ~164 px; STOP = ten ze spodní lišty | konvexní vlevo nahoře, konkávní pata vlevo (`#vt_c_jb`, `vt-col-on`) |
| Levý panel s logem | když vedle otevřeného panelu zbývá logu < 420 px, log vede pod panelem od levé hrany a panel stojí na něm (`vt-log-wide`) | — |

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
| Zavření | ✕, Esc (Esc zavře nejdřív nápovědu, panel zůstane) | ✕ |
| Nikdy | neotevře se sama, nemá backdrop — mapa i panel jdou dál ovládat | totéž |

### Spodní lišta (část C)

| | PC | Telefon (na výšku i na šířku, dotyk) |
|---|---|---|
| Pořadí | STOP · Joystick · Follow · Log | STOP · Joystick · *volné místo 84 px* · Follow · Log |
| Poloha | spodní okraj | **úplně dole u spodní hrany**, tlačítka nad `env(safe-area-inset-bottom)`; střed volný pro systémové tlačítko / gesto Androidu a Chromu |
| STOP | vlevo dole, 20 % šířky | totéž — **vždy stejné místo a velikost, nikdy se nezmenšuje ani neposouvá** |
| Kamera | v pravém panelu (sekce Camera) | v pravém panelu: ▾ rozbalí sbalený řádek, sekce Camera |

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

## Navbar (horní lišta, owner 2026-10-25)

Zleva doprava, stejně na PC i telefonu:

| Místo | Obsah | Poznámka |
|---|---|---|
| vlevo | logo VITULUS + **tečka spojení** (`#conn_status`, `data-state`) | bez textu a bez nadpisu pohledu („Map view“ zrušen); zelená = spojeno, oranžová pulzující = připojuji (s `prefers-reduced-motion` bez pulzu), červená = bez spojení; slova jen v `title` + `aria-label` (en/cs, `mapview.conn.*`); klik / Enter = hned znovu připojit (`ConnectionStatus`, map_view.js) |
| střed (PC ≥ 992 px) | **řada stavových ikon** (`#status_div`, status_header.js): skupiny počasí · senzory · pojezd · teploty · napájení | počasí = ikona deště `#ico_rain` (jediná viditelná z `#ico_rain_ok/warn/danger`, barva = stav, 16 px jako ostatní; bez dat skupina není vidět); klik / Enter = obnoví radar a otevře levý panel › Map › Rain (rain_alert.js) |
| vpravo | ? · zvonek · monitor počítače · Fullscreen / Restart (pod lg v ☰) | beze změny |

Pod 992 px řada ikon (včetně počasí) visí z horní lišty nad mapou (telefon na
výšku: přes celou šířku, prázdné boční sloupce řady skryté, takže se ikony vejdou
do jednoho řádku i na 360 px; kdyby ne, zalomí se do dvou v rámci 32 px); na šířku s otevřeným panelem ukazuje jen
ikony, které hlásí problém (déšť se čeká / prší ano, „bez deště“ ne).

**Výpadek spojení** ohlásí i pás hlášek (`#span_status_info` třída
`vt-notice-conn`, červená hrana, text `mapview.conn.lost`) — jakmile spojení
spadne (nebo selže první pokus), zůstane do obnovení (10s časovač StatusBar ji
neschová), po připojení zmizí. Na nízkém okně (telefon na šířku, navbar
skrytý) je tečka schovaná a výpadek hlásí právě tenhle pás.

## Matice: kde je která oblast

### PC (`vt-m-dock`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | navbar 42 px + pás menu, celá šířka | totéž |
| Hlášky (`#span_status_info`) | vlastní pás pod menu, vycentrovaný mezi levým a pravým panelem | vycentrovaný mezi hřbetem a pravým panelem |
| Levý panel | sloupec 480 px od pásu menu ke spodní liště, sdílené hrany, bez stínu | — |
| Mapa | vpravo od panelu (plátno se zúží) | celá plocha mezi lištami |
| Pravý stavový panel | výběžek z horní lišty u pravé hrany (hned pod pásem menu), konec nad logem / joystickem | totéž |
| Log malý | výběžek spodní lišty od panelu po joystick (nebo pravou hranu) | od hřbetu po joystick / pravou hranu |
| Log celý | ze spodní lišty do dutiny pod hlášky, vlevo od panelu; **tvar L (P21)**: vedle pravého panelu končí u jeho hrany, pod ním pokračuje až k joysticku (bez joysticku k pravé hraně) — log, pravý panel a joystick jsou jedna plocha rámu, otevřené zůstává jen okno mapy mezi spodkem pravého panelu a joystickem | totéž od hřbetu |
| Log skrytý | — (tlačítko ≡ ve spodní liště) | — |
| Joystick | stojí na spodní liště u pravé hrany vedle malého logu | totéž |
| Kamera large | dutina vlevo od pravého panelu, mapa ve slotu pravého panelu | totéž |
| Spodní lišta | celá šířka | totéž |

### Telefon na šířku / malý tablet (`vt-m-overlay`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | při výšce < 600 px jen pás menu (navbar skrytý, jako dřív) | totéž |
| Hlášky | pás pod menu, vycentrovaný vpravo od panelu | přes celou šířku |
| Levý panel | sloupec přes mapu, min(420 px, 52 % šířky), lícuje s lištami, stín vpravo | — |
| Hlavička panelu (výška ≤ 480 px) | panely se záložkami (Settings, Map, Programs, Agent, Support): akce hlavičky (STOP agenta, ⤢, ✕) sedí na pravém konci řádku záložek, titulek a meta ustoupí (P20); Marker a editor mapy mají hlavičku beze změny; řádek záložek drží při rolování nahoře (P24); editor mapy na šířku skryje patičku Close editor, zavírá ✕ v hlavičce (P25) | — |
| Mapa | celá plocha (panel ji částečně kryje) | celá plocha |
| Pravý stavový panel | **sbalený řádek** (mapa · Pose · GNSS · baterie · kamera · ▾) visí z pásu menu u pravé hrany; rozbalený = sloupec, joystick pak stojí vedle něj | totéž |
| Log malý | když vpravo od panelu zbývá ≥ 420 px (bez joysticku): pruh vpravo od panelu; jinak **od levé hrany po joystick a panel stojí na něm** (`vt-log-wide`) | od hřbetu po joystick |
| Log celý | plocha vpravo od panelu, pod hláškami, ze spodní lišty, před joystickem | od hřbetu, před joystickem / pravým panelem |
| Joystick | na spodní liště u pravé hrany vedle logu (s rozbaleným pravým panelem vedle jeho sloupce) | totéž |
| Kamera large | se sbaleným pravým panelem: 4:3 v levém horním rohu dutiny, mapa vedle | 4:3 v levém horním rohu dutiny |

### Telefon na výšku (`vt-m-sheet`)

| Oblast | Panel zobrazený (sheet) | Panel skrytý |
|---|---|---|
| Horní lišta | navbar + pás menu | totéž |
| Ikonky + hlášky | součást horní lišty (plocha rámu), pod pásem menu | totéž |
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
| Zobrazit / skrýt panel | ◧ Panel v pásu menu, **Alt+P**, **Esc** (skrýt; ne při psaní, otevřeném modálu nebo celém logu), ✕ | ◧, ✕, tah sheetu dolů |
| Popisky tlačítek | ikona + text v pásu menu i spodní liště | jen ikona; název v `aria-label` / tooltipu |
| Stav přepínačů | aktivní panel, zapnutá kamera / joystick / log / sledování robota = podsvícené tlačítko (`vt-on`, `aria-pressed`) | totéž |
| Fokus z klávesnice | jeden viditelný prstenec (`:focus-visible`, barva akcentu) v liště, panelu, pravém panelu i logu | — |
| Animace | krátké (0,15–0,2 s); `prefers-reduced-motion: reduce` je vypne | totéž |

## Pravidla

- Hlášky a ovládání (lišty, panel, pravý panel) **nic nepřekrývá** — log ani
  v celé velikosti, ani velká kamera (začíná pod pásem hlášek); STOP vždy
  vlevo dole; zapnutý joystick je vždy nahoře (z 9) a dosažitelný; vrstvy: lišty a pás menu/hlášek (z 10) > panel (1000,
  ale mimo lišty) > pravý panel (5) / log (8) mimo sebe navzájem.
- Log má 3 stavy: skrytý ↔ malý (≡ ve spodní liště) a malý ↔ celý (úchyt
  „Expand“ / „Collapse“ v liště logu); stav si pamatuje (`vitulus_hud_log`,
  `vitulus_log_expanded`).
- Změna šířky plochy mapy (dok/skrytí panelu) vyvolá `resize`, plátno 3D
  mapy se přepočítá.

## CSS proměnné rámu (nastavuje vt_frame.js)

| Proměnná | Význam |
|---|---|
| `--vt-frame-top` | spodní hrana pásu menu (px od horní hrany okna) |
| `--vt-frame-notice-b` | spodní hrana pásu hlášek (nebo `--vt-frame-top`, když je prázdný) |
| `--vt-frame-bottom` | výška zóny spodní lišty (od spodní hrany okna) |
| `--vt-frame-left` | šířka obsazená levým panelem v režimu dock/overlay (0 = skrytý) |
| `--vt-frame-dock` | o kolik se zúží mapa (jen `vt-m-dock`) |
| `--vt-frame-rp-w` | šířka pravého panelu v ploše mapy (0 = zavřený / telefon) |
| `--vt-frame-rp-b` | spodní hrana pravého panelu (telefon: sbalený řádek) |
| `--vt-frame-log-h` | výška malého logu, když je zobrazený (jinak 0) |
| `--vt-frame-cleft` / `--vt-frame-cbottom` | levý okraj dutiny (panel / hřbet) / dno dutiny u hřbetu (lišta + malý log, vršek celého logu, vršek sheetu) |
| `--vt-frame-log-left` / `--vt-frame-log-right` | okraje malého logu (hřbet nebo 0 při `vt-log-wide` / šířka joysticku nebo 0) |
| `--vt-frame-ledge` | vršek spodní části rámu (lišta + malý log) |
| `--vt-frame-joy-w` / `--vt-frame-joy-b` / `--vt-frame-joy-r` | šířka joysticku / jeho spodek (lišta, nebo lišta + log) / odsazení zprava (vedle sloupce pravého panelu) |
| `--vt-frame-rp-left` | levá hrana pravého panelu (roh `#vt_c_tr`) |
| `--vt-frame-logfull-r` | pravý okraj celého logu (pravý panel / joystick + 8 px) |
| `--vt-cam-l/t/w/h`, `--vt-cam-cw/ch`, `--vt-cam-ml` | box velké kamery a obraz 4:3 v něm (stream max. 640 px šířky, škáluje CSS) |
| `--rp-cam-*`, `--rp-hole-x/y` (right_dock.js) | slot kamery v pravém panelu; při large v něm leží mapa a panel má na tom místě okno (maska) |

Třídy na `<body>`: `vt-c-rp`, `vt-c-log`, `vt-c-logfull`, `vt-joy-on`,
`vt-joy-on-log`, `vt-joy-beside-rp`, `vt-log-wide`, `vt-cam-large`,
`vt-map-mini`, `vt-cam-paused`. Proměnné i třídy se zapisují jen při změně
(žádná smyčka observerů); poloha výběžků nezávisí na poloze pravého panelu,
takže se vt_frame.js a right_dock.js nemohou honit.

## Požadavky na tokeny (pro U2 / vt_tokens.css)

- `--vt-dock-w-desktop` (dnes 480 px natvrdo jako `--vt-drawer-w`) — šířka
  dokovaného sloupce, ať ji jde ladit spolu se vzhledem.
- `--vt-frame-border` — barva sdílených hran rámu (dnes `--vt-border-strong`).
- `--vt-frame-log-h` výchozí výška malého logu (dnes 106 px / 62 px na nízkém
  okně, natvrdo v index.html a right_dock.css).
