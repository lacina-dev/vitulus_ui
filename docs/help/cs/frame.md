---
id: frame
title: Obrazovka (rám, panely, log, joystick)
group: Using the UI
order: 100
icon: la-columns
summary: Rám C — levý panel, horní a spodní lišta, pravý panel, log, joystick, kamera a její překryvy, telefon vs. PC.
ui: [frame, log#log, drive#ruční-jízda-joystick, camera#kamera]
related: [start, status-icons, settings]
keywords: [rám, rozvržení, panel, skrýt, celá obrazovka, rozbalit, sheet, spodní lišta, pravý panel, log, joystick, klávesnice, wasd, kamera, sledovat, telefon, mobil, počítač, zkratka, alt+p, esc, překryvy, lidar, hloubka, překážky, volno, mračno bodů, průhlednost, frame, layout, overlay, depth, obstacles, follow, mobile, desktop, shortcut]
---
# Obrazovka

UI tvoří jeden rám ve tvaru písmene **C** kolem mapy: horní pás (navbar, lišta agenta, pás menu),
levý panel a spodní lišta jsou jedna plocha. Pravý panel, log a joystick vyrůstají ze stejného
rámu.

![Rám C uživatelského rozhraní](../img/frame.svg)

## Horní lišta

Zleva doprava: logo **VITULUS** s malou **tečkou spojení** — zelená = stránka je spojená
s robotem, oranžová (pulzuje) = připojuje se, červená = bez spojení; po najetí myší ukáže slova,
kliknutím se hned připojí znovu. Když spojení spadne, řekne to i řádek v pásu hlášek pod menu,
dokud se neobnoví. Pak **ikony stavu**, první je **počasí** (klik = radar deště) — viz [Ikony
stavu](status-icons.md). Vpravo **?** nápověda, zvonek (**Čeká na tebe**) a monitor počítače. Na
úzké obrazovce visí ikony stavu pod pásem menu; na telefonu na šířku je navbar skrytý (pás menu
zůstává) a výpadek spojení ukáže jen pás hlášek.

## Levý panel

Pás menu otevírá v levém panelu vždy jeden nástroj: **Značka**, **Nastavení**, **Mapa**,
**Programy**, **Agent**, **Podpora**. Otevřený svítí. Červené číslo na ikoně Agenta počítá
zprávy agenta, které jsi ještě neviděl.

| Co | PC | Telefon |
|---|---|---|
| skrýt / zobrazit panel | **Panel** v pásu menu, **Alt+P**, **✕** | **Panel**, **✕**, stáhnout sheet dolů |
| celá obrazovka | **⤢** v hlavičce | vytáhnout sheet nahoru / ťuknout na úchyt |
| nápověda k němu | **?** v hlavičce | **?** v hlavičce |

Skrytý panel nechá na levém okraji tenký hřbet — klikni na něj a panel se vrátí. UI si pamatuje,
který panel byl otevřený (i po načtení stránky znovu).

**PC** (šířka ≥ 1024 px): panel je sloupec, mapa se vedle něj zúží. **Tablet / telefon na
šířku**: sloupec leží přes mapu. **Telefon na výšku** (< 576 px): panel je sheet vysouvaný zdola
(60 % výšky). Na telefonu (na výšku i na šířku) má panel kompaktní hlavičku: **?** / ⤢ / ✕ (v panelu Agent
i jeho STOP) jsou na konci řádku záložek; na výšku se název přesune do řádku s úchytem.

**Záložky, které se nevejdou** (úzký panel, telefon, delší české popisky), zůstanou v jednom
řádku, který se posouvá do strany: **‹** / **›** na okraji ukazuje, že jich je víc — klikni na ni,
otoč kolečkem myši nad řádkem nebo ho posuň prstem. Vybraná záložka (i ta otevřená, kdykoli se
panel otevře) se celá posune do viditelné části; na klávesnici přepínají záložky **←** / **→**.

![UI na telefonu na výšku, bez otevřeného panelu, s očíslovanými značkami](../img/shot-phone.webp "Telefon, žádný panel: 1 Čeká na tebe · 2 pás menu · 3 ikony stavu · 4 mapa · 5 pravý panel (jeden řádek, ▾ ho rozbalí) · 6 STOP · 7 Log, Sledovat, Joystick") ![UI na telefonu s panelem Mapa otevřeným jako sheet zdola, s očíslovanými značkami](../img/shot-phone-sheet.webp "Telefon, otevřený panel Mapa: 1 název (táhni za úchyt) · 2 záložky · 3 ? nápověda · 4 ⤢ celá obrazovka · 5 ✕ zavřít")

## Spodní lišta

![Spodní lišta: Log, Sledovat a vpravo ouško Joystick](../img/shot-bottom-bar.webp "Spodní lišta na PC zleva doprava: Log · Sledovat · Joystick")

**Log** · **Sledovat** · **Joystick** (na telefonu s volnou mezerou uprostřed pro
systémové gesto). **Joystick** sedí na pravém konci, přímo pod panelem jízdy, který otevírá —
viz [Ruční jízda](#ruční-jízda-joystick). STOP v liště není: jediný velký **STOP** je v pravém
horním rohu (níž), takže spodní lišta, pás jízdy i spodek levého panelu zůstávají volné.
**Sledovat** nechá pohled mapy sledovat robota.

## STOP v pravém horním rohu

![Pravý horní roh na PC: velký STOP v hlavě pravého sloupce](../img/shot-stop.webp "PC: STOP v hlavě pravého sloupce, pravý panel začíná pod ním.")

Velký červený **STOP** stojí v **hlavě pravého sloupce**: na PC, tabletu a telefonu na šířku
v pravém horním rohu, široký jako pravý panel, zapuštěný do horní lišty — pravý panel začíná pod
ním, ikony a menu horní lišty končí před ním. Na telefonu na výšku sedí na pravém konci horní
lišty (cíl velký na palec), takže spodní lišta a pás jízdy zůstávají volné pro palce. Je vidět ve
všech stavech (otevřený panel i přes celou obrazovku, log, velká kamera, editor mapy, nápověda,
agent) a nic nezakrývá. Totéž udělá **Esc**. Je to jediné úplné zastavení
([Bezpečnost](safety.md#stop)); vlastní STOP panelu Agent je jiná věc (zastaví misi agenta).

## Pravý panel

Visí z horního pásu u pravého okraje. Je to **přehledová deska**: na první pohled (barvou) vidíš,
jestli je všechno v pořádku, aktuální čísla máš na jedno kliknutí a úplný detail s vysvětlením je
v levém panelu. **Sekačka**, **Navi** a **GNSS** proto mají tři úrovně:

1. **Řádek s názvem** — barva a pár značek. Najeď myší (na telefonu dlouze podrž) na kteroukoli
   značku: řekne, co to je, a ukáže jedno důležité číslo.
2. **▸ rozbalení na místě** — klikni na název: rychlá aktuální čísla se otevřou hned pod ním.
   Výchozí stav je sbaleno; každá sekce si pamatuje, jak jsi ji nechal.
3. **Ikona detailu** (malý symbol panelu v řádku s názvem, hned před **?**): otevře levý panel
   **Mapa › Loc › Detail lokalizace** rovnou na té části (Navi nebo GNSS).

**Jeden barevný kód všude:** zelená = v pořádku · oranžová (jantarová) = pracuje se na tom /
ještě není přesné · červená = chyba nebo chybí data, která by tu měla být · šedá = vypnuto,
pozastaveno nebo není co ukázat.

- **Ovládání** — v řádku s názvem: ⚡ (zelený = v doku / nabíjí se), baterie v %, `MOT` (motory:
  zelená zapnuté, oranžová vypnuté, šedá neznámo). Pod ním **Dock / Undock / Stop** ([Dok a výjezd](dock.md)).
- **Sekačka** — jen když je sekačka zapnutá. Řádek s názvem: čip stavu (`READY`, `RUN`, `HEIGHT`,
  `ERR`…), tečka nože (zelená = točí se) s otáčkami (`3.2k`), teplota jen když je horko a tlačítka
  nože **▶ Start** / **■ Stop** — totéž co Nastavení › Sekačka › START MOTOR / STOP MOTOR. ▶ je
  zelené jen ve stavu `READY` se stojícím nožem a chce **dvě klepnutí** (první ho na 3 s připraví,
  tlačítko se vyplní zeleně). ■ zčervená, když se nůž točí, a zastaví ho hned. Rozbalení: tři buňky **Nůž** (běží · otáčky / stojí), **Výška** (mm)
  a **Teplota** (°C, vždy: zelená, oranžová od 50 °C, červená od 60 °C) a k tomu běžící program
  a jeho stav ([Sekání](mowing.md)). Vypnutá sekačka tu sekci vůbec nemá.
- **Navi** — v řádku s názvem: kdo drží polohu (`DOCK`, `RTK`, `TRACKER`…), zdroj kurzu
  (`SAT` / `IMU`) a jedna **tečka odometrie** za VO / Li / Wh dohromady (zelená = běží, oranžová =
  jedna je zhoršená, červená = jedna je ztracená, šedá = pozastavené v doku; najetí = každý zdroj).
  Rozbalení: řádek čipů `VO Li Wh FIX PROB ANC` — najetí na čip řekne
  např. *Li — lidarová odometrie: běží, sleduje · kov. 0.010*, *FIX — RTK fix je použitelný:
  nepoužitelný · stáří korekcí 0.5 s*, *ANC — kotva polohy: kotva čerstvá, naposledy posunuta
  před 12 s* — a jeden řádek trackeru (`STANDBY` / `ACTIVE` + poslední korekce); ikona detailu
  v řádku s názvem otevře zbytek ([co znamenají čipy](localization.md#jak-číst-stav-pravý-panel--navi)).
- **GNSS** — řádek s názvem: fix Polohy, fix Kurzu (`RTK`, `FLT` = float, `DGN` = DGNSS, `3D`,
  `NO`), použité satelity (zeleně od 12) a tečka stáří korekcí (zelená < 2 s, oranžová < 10 s,
  červená starší nebo žádné). Rozbalení: dvě malé dlaždice **Poloha | Kurz** jen s rychlými
  čísly — fix, satelity použité / viditelné, přesnost (`acc` v cm, `hdg` ve °) a stáří korekcí —
  a ikona detailu v řádku s názvem otevře celou kartu obou přijímačů
  ([Přijímače GNSS](localization.md#přijímače-gnss-pravý-panel--gnss)).
- **Kamera** — tečka v řádku s názvem (zelená = živý obraz, oranžová = startuje / čeká, šedá =
  vypnuto) a přepínač Off / S / L; viz níže.

Každá sekce se sbalí kliknutím na název (▾ / ▸) a zůstane, jak jsi ji nechal. Sekce se stavem
(Sekačka, GNSS) má jemný barevný nádech. Se sbalenou Sekačkou, Navi a GNSS se všechno nad kamerou
vejde na jednu obrazovku, takže malý obraz kamery je vidět bez posouvání (po rozbalení se panel
může posouvat). Na telefonu (na výšku i na šířku) je pravý panel sbalený do jednoho řádku (mapa,
poloha, GNSS, tečka sekačky, když je zapnutá, baterie, kamera, ▾) — ▾ ho rozbalí.

![Sekce Ovládání pravého panelu s očíslovanými značkami](../img/shot-controls.webp "Ovládání: 1 baterie · 2 MOT (pojezdové motory) · 3 Dock · 4 Undock · 5 Stop (sekvence doku). Rychlost, motory a jízda klávesnicí jsou v prstenci jízdy.") ![Sekce Navi pravého panelu s očíslovanými značkami](../img/shot-navi.webp "Navi rozbalené: 1 kdo drží polohu · 2 zdroj kurzu · 3 tečka odometrie · 4 ikona detailu do Mapa › Loc · 5 čipy odometrie (najetí = co to je + číslo) · 6 řádek trackeru")

![Sekce Sekačka pravého panelu s očíslovanými značkami](../img/shot-rp-mower.webp "Sekačka (jen když je zapnutá) rozbalená: 1 stav · 2 tečka nože a otáčky · 3 ▶ Start / ■ Stop nože · 4 Nůž / Výška / Teplota") ![Sekce GNSS pravého panelu s očíslovanými značkami](../img/shot-rp-gnss.webp "GNSS rozbalené: 1 fix Polohy · 2 fix Kurzu · 3 použité satelity · 4 stáří korekcí · 5 ikona detailu do Mapa › Loc · 6 rychlá čísla Poloha | Kurz")

## Kamera

![Sekce Kamera pravého panelu s otevřenou nabídkou překryvů, očíslované značky](../img/shot-camera-layers.webp "1 Vyp / M / V · 2 tlačítko vrstev · 3 Lidar · 4 Překážky · 5 Volno · 6 Hloubka · 7 Průhlednost")

Přepínač **Vyp / M / V** v hlavičce sekce Kamera: **M** = malý živý obraz v pravém panelu,
**V** = kamera vyplní plochu mapy a mapa se přesune na místo kamery v pravém panelu (kliknutím na
malou mapu se vrátíš). **Alt+C** přepíná M ↔ V. Přenos běží, jen když je kamera na obrazovce. Na
telefonu zapíná a vypíná velkou kameru tlačítko kamery ve sbaleném řádku.

### Překryvy kamery

Tlačítko vrstev v pravém horním rohu obrazu kamery (M i V) otevře překryvy. Každý je přepínač
a zapnout jde libovolná kombinace:

- **Lidar** (azurová) — sken lidaru: řada bodů tam, kde paprsek lidaru ve výšce lidaru na něco
  narazí.
- **Překážky** (červená) — co detekce překážek z hloubkové kamery vidí jako překážku (právě to
  robot objíždí).
- **Volno** (zelená) — zem, kterou stejná detekce vidí jako volnou a sjízdnou.
- **Hloubka** — obraz vzdáleností z hloubkové kamery přes obraz: červená = blízko, žlutá / zelená
  = středně, modrá = daleko (asi 5 m); bez barvy = tam hloubka není (obloha, odlesk, moc daleko).

![Schematický obraz kamery s překryvy: body lidaru, body překážek, body volné země a barvy hloubky](../img/camera-overlays.svg "Schéma: 1 body lidaru tam, kde paprsek narazí na zeď, sloupek a krabici · 2 překážky (krabice) · 3 volná zem · 4 hloubka: červená blízko → žlutá → zelená → modrá daleko · 5 bez barvy = bez hloubky (obloha)")

**Průhlednost** nastaví, jak silně všechny překryvy zakrývají obraz. Body blíž k robotu jsou
větší. Volba se pamatuje v tomto prohlížeči.

Body do obrazu vkládá sám robot (node `camera_overlay` ve `vitulus_ui`): použije kalibraci kamery
a polohu každého senzoru v okamžiku měření, takže bod sedí na věci, kterou změřil, i když se robot
otáčí — jako pohled kamery v RVizu. Pracuje, jen když je zapnutá nějaká vrstva a kamera je vidět;
se všemi vrstvami vypnutými nedělá nic.

- **Vrstva je zapnutá, ale nic není vidět** — zrovna nejsou data (prázdný seznam překážek je na
  otevřeném trávníku normální; lidar je vidět jen tam, kde paprsek v záběru na něco narazí), nebo
  služba překryvů ještě neběží (startuje se softwarem robota).
- **Body jsou kousek vedle hran věcí** — pár pixelů je normální (tolerance uchycení senzorů);
  velký a stálý posun znamená, že polohy senzorů v modelu robota potřebují kalibraci. Změřeno
  18. 10. 2026 (robot v doku): body lidaru sedí asi 10 px vlevo od hran ve 3–4 m, na 1 m do pár
  pixelů — zatím málo na změnu modelu robota; rozhodne kontrola venku před zdí / sloupky (nástroj
  `tools/overlay_extrinsics.py`).
- **Barva hloubky vs. lidar na dálku** — hloubková kamera měří tím víc navíc, čím dál se dívá:
  asi +1 cm na 1 m, +5 cm na 2 m, +18 cm na 4 m (stereo kalibrace kamery, ne model robota).
  Správná je vzdálenost z lidaru; hloubku opraví kalibrace přímo v kameře (RealSense
  self-calibration / tare).

## Ruční jízda (joystick)

**Joystick** na pravém konci spodní lišty je **ouško panelu jízdy**: sedí přímo pod ním, široké
jako pravý sloupec. Zavřené ouško trochu vystupuje z lišty, má úchyt a **▴** — otevře panel nad
sebou; otevřený panel stojí na oušku jako jeden kus (ouško svítí, **▾** panel zavře). Panel je
**prstenec jízdy**: jeden kruhový ovladač v patě pravého sloupce (široký jako pravý panel,
184 px), stojí na spodní liště. Na telefonu na výšku je to pás přes celou šířku na spodní liště —
vlevo krátký text, vpravo pod palcem prstenec (150 px) a hned pod ním ouško Joystick; na
telefonu na šířku má prstenec také 150 px.

![Prstenec jízdy s očíslovanými značkami](../img/shot-joystick.webp "1 kapsle: nejvyšší rychlost a režim · 2 sedm dílků rychlosti · 3 Pomalu / Středně / Rychle = režim robota · 4 páčka · 5 Klávesy (ikona) · 6 Motory (ikona) · 7 ? jak to funguje · 8 − / +")

1. **Kapsle** nad páčkou — nejvyšší rychlost joysticku právě teď v m/s (na okraji páčky jede robot
   takhle rychle, vpřed i vzad) a režim rychlosti robota.
2. **Dílky rychlosti** — horní dvě třetiny prstence: 7 kroků od 0,10 do 0,75 m/s, rozsvícené po
   aktuální (chladná azurová = pomalu → teplá oranžová = rychle), aktuální září. Klikni nebo klepni
   na dílek, táhni po prstenci (krok se vezme, když pustíš), kolečko myši nad ním, šipky, když má
   fokus, nebo **+ / −** na klávesnici, když jsou zapnuté **Klávesy**.
3. **Pomalu / Středně / Rychle** podél dílků — režimy rychlosti robota (`/navi_manager/speed`);
   podle nich jede i navigace ([Rychlost](routes.md#rychlost)). Rozsvícený je režim, který **hlásí
   robot**; klik = ten režim jeho vlastní rychlostí. Krok **uvnitř** současného režimu změní jen
   joystick (hned, nic se neposílá). Krok **jiného** režimu nejdřív požádá robota o ten režim:
   dílek i režim blikají, dokud ho robot nepotvrdí (a pak tou rychlostí jezdí i navigace). Krok si
   pamatuje tento prohlížeč; když režim přepne robot sám (program, jiný prohlížeč), prstenec ho
   následuje.
4. **Páčka** uprostřed — dopředu / dozadu = rychlost, do stran = zatáčení. Její okraj je stav:
   zelená = volno, oranžová = robota drží někdo jiný (program, dokování, agent nebo gamepad;
   objeví se **Převzít**), šedá = motory vypnuté nebo neznámé.
5. **Klávesy** (ikona klávesnice, vlevo dole) — jízda klávesnicí: **azurová = zapnuto**, šedá =
   vypnuto (**W A S D** nebo šipky, **Shift** = poloviční rychlost, **+ / −** = rychlost; nikdy při
   psaní do pole). Na dotykových obrazovkách není — ikona motoru pak zabere celý spodek.
6. **Motory** (ikona ozubeného kola, vpravo dole) — pojezdové motory, totéž co Nastavení › Motory:
   **oranžová = vypnuté**, **zelená = zapnuté**, šedá = neznámo, podle robota; klepnutí přepne a
   bliká do potvrzení. Stránka motory sama nikdy nezapne (po každém startu jsou vypnuté).
7. **?** — krátká karta „Řízení ručně“ (vysvětlí i ikony). Ukáže se i sama, když se prstenec v
   prohlížeči otevře poprvé; **Rozumím** ji schová.
8. **− / +** na švech vedle dílků — o krok pomaleji / rychleji.

Ikony jsou bez textu: co jsou, řekne najetí myší (nebo čtečka obrazovky). Pod prstencem se řádek
objeví, jen když jízdě brání něco, co prstenec neukazuje (robota drží někdo jiný, jede gamepad
DS4, data jsou zastaralá).

Jak se páčka chová:

- Uprostřed malá **mrtvá zóna** (10 % poloměru), pak měkká křivka: malé vychýlení jede jemně
  a pomalu, okraj = plná rychlost kroku.
- Skoro rovně (do ±9°) jede **přesně rovně**, skoro do strany se **otáčí na místě** — zamčená osa
  se rozsvítí barvou směru.
- Povel je vidět: knoflík jde za prstem (nebo klávesami); **vnější oblouk** je rychlost (nahoře =
  vpřed, azurová → zelená podle síly; dole = vzad, oranžová), **vnitřní oblouk** zatáčení (fialový,
  na stranu otáčení) — čím silnější povel, tím delší a tlustší, se září; barevné světlo pod
  knoflíkem ukazuje směr, kolem knoflíku svítí svatozář, šipky ▲▼◀▶ se obarví, stisk udělá vlnku.
  S nezapnutými motory jsou barvy ztlumené.
- **Jantarový okraj** = robota má program sekání, dokování / výjezd z doku, navigační cíl, agent
  nebo gamepad DS4 — páčka je zamčená (najetí řekne kdo) a **Převzít** v páčce ji záměrně odemkne
  (pohyb pak tu úlohu zruší); **šedý** = motory vypnuté (zamčeno) nebo neznámé.
- **Pustíš = stop.** Robot dostane jeden zmírněný povel a do 50 ms nulu; knoflík odpruží zpět.
  Ztráta dotyku, přepnutí záložky nebo okna či výpadek spojení zastaví hned. Dokud držíš, posílá
  20 povelů za sekundu, jinak nic; když se stránka zasekne (povel o víc než 250 ms pozdě), sama
  zastaví.
- Řídí jeden prst; druhý prst na páčce se nevnímá.
- Po kliknutí nebo klepnutí kolem prvku nezůstane rámeček; při pohybu klávesou **Tab** se ukáže
  tenké azurové orámování ve tvaru prvku. Se systémovým *omezením pohybu* prstenec neanimuje.

**Velký STOP** — vpravo nahoře v hlavě pravého sloupce (na telefonu na výšku na pravém konci
horní lišty), nebo **Esc** — je vždy vidět, s joystickem i bez něj, a žádný panel ho nepřekryje.
Je to úplné zastavení ([Bezpečnost](safety.md#stop)); navíc hned pustí páčku.

> [!WARNING]
> Pohyb joystickem převezme řízení od softwaru: **zruší** cíl navigace, dokování i běžící
> program a po puštění robot stojí. Přednost má jen gamepad DS4
> ([Bezpečnost](safety.md#gamepad-ds4-a-joystick-mají-přednost-před-softwarem)).

## Log

![Log rozbalený přes mapu, s lištou nástrojů a očíslovanými značkami](../img/shot-log.webp "Rozbalený log: 1 Změny · 2 ROS · 3 Živě · 4 Vymazat · 5 ▼ Sbalit · 6 ? nápověda")

**Log** vlevo ve spodní liště ukáže log jako pruh nad lištou. **▲** (rozbalit) ho roztáhne přes plochu
mapy, **▼** (sbalit) ho vrátí zpět; další **Log** ho skryje. S otevřeným panelem jízdy končí
malý log vedle něj.

Rozbalený log má lištu nástrojů:

- **Změny** — užitečné události robota: zelená tečka = něco se zlepšilo, oranžová = varování,
  červená = porucha; změny spojení a hlášení agenta.
- **ROS** — surová konzole robota s filtry úrovní, filtrem nodů a hledáním textu.
- **Živě** pozastaví / obnoví posouvání, **Vymazat** vyprázdní log jen v tomto prohlížeči.

## Klávesové zkratky (PC)

| Klávesa | Co dělá |
|---|---|
| **Alt+P** | zobrazit / skrýt levý panel |
| **Esc** | **STOP** — vždy, i při psaní nebo v otevřeném dialogu (nápovědu / obrázek přitom i zavře) |
| **Alt+C** | kamera malá ↔ velká |
| **W A S D**, šipky | jízda (se zapnutými **Klávesami** v prstenci jízdy), **Shift** = poloviční rychlost, **+ / −** = rychlost |
