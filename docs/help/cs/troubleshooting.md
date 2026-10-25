---
id: troubleshooting
title: Řešení problémů
group: When something is wrong
order: 200
icon: la-wrench
summary: Robot nejede, není vidět mapa, GPS nechytá fix, zajetí do doku selže nebo se zruší, FAULT supervisoru, mise nedoběhla, agent po restartu, UI nereaguje, kde jsou logy uzlů.
related: [safety, localization, dock, agent, support]
keywords: [problém, problem, chyba, error, fault, nefunguje, not working, nejede, nehýbe se, does not move, uvízl, stuck, rozbité, broken, oprava, fix, pomoc, help, restart, obnovit, reload, rosbridge, dokování zrušeno, docking cancelled, stop sekačky, mower stop, znovu připojit, reconnect, mise nedoběhla, mission not finished, zpátky v doku, returned to dock, need help, log, logy, log uzlu, node log, stdout, rosout, journal, journalctl]
---
# Řešení problémů

Začni **stavovými ikonami** (svítí něco červeně nebo šedě?), **stavovým řádkem** pod menu a
**logem** (Změny). Pak najdi svůj případ níž. Když nic nepomůže, zeptej se
[agenta](agent.md) nebo [problém nahlas](support.md#nahlásit-problém).

## Robot nejede

![Prstenec jízdy](../img/shot-joystick.webp "Prstenec jízdy to řekne první: okraj páčky je šedý a ikona motoru (6) oranžová — kliknutím je zapneš.")

Projdi v tomhle pořadí:

1. **Vypnuté motory?** Po každém startu, restartu a STOPu jsou pojezdové motory VYPNUTÉ. Ukazuje to
   joystick a log píše *Motors are OFF – turn motors on to move/dock*. →
   oranžová **ikona motoru** v prstenci jízdy (zelená = zapnuté) (nebo **Nastavení › Motory › ON**).
2. **Převzal řízení člověk?** Pohyb páčkou gamepadu (nebo PS / L1 / R1) nebo joystickem v UI
   zruší cíl, zajetí do doku i běžící program a software zůstane zastavený i po puštění
   ([Bezpečnost](safety.md#gamepad-ds4-a-joystick-mají-přednost-před-softwarem)). → pošli cíl
   znovu, znovu **Undock**, nebo u programu **Reset** + **Run**. Zapnutý gamepad s páčkami
   uprostřed nic *neblokuje*.
3. **Program po zastavení?** **Run** se ignoruje, dokud nedáš **Reset**
   ([Programy](programs.md#přerušit-a-pokračovat)).
4. **Úkol agenta?**
   - *Zámek doku* zamčený → mise čeká; odemkni v **Agent › Robot**
     ([Zámek doku](agent.md#zámek-doku)).
   - Pruh *STOP JE ZAJIŠTĚNÝ* → napiš `/stop pokracuj`.
   - Mise čeká na supervisor → viz [FAULT supervisoru](#fault-supervisoru).
   - Podpůrný kit restartuje stack → mise počkají, než skončí.
5. **Žádná aktivní mapa / žádná lokalizace** → [Mapa není vidět](#mapa-není-vidět),
   [stav lokalizace](localization.md#jak-číst-stav-pravý-panel--navi).

## Mapa není vidět

1. Obnov stránku (na telefonu aplikaci zavři a znovu otevři).
2. **Mapa › Mapa**: je nějaká mapa **aktivní**? Po **Deaktivovat** schválně žádná mapa není →
   nějakou **Aktivuj**.
3. Jsou zaškrtnuté vrstvy (**Základ**, **Uložená**)? Je jejich krytí nad nulou (**Zobrazení**)?
4. Hned po restartu stacku přijde mapa až za minutu.
5. Vrstva, která se nekreslí, nemusí znamenat chybějící data — prohlížeč mohl propásnout
   transformaci polohy; obnovení stránky to spraví.

## GPS nechytá fix

1. Dvě ikony GPS a řádek GNSS ([Lokalizace](localization.md#jak-číst-stav-pravý-panel--navi)).
2. V doku nebo hned vedle něj bývá fix často špatný — proto výjezd z doku nejdřív dojede na
   UNDOCK a teprve pak čeká na RTK.
3. Volné nebe, pár minut trpělivosti, běžící základnová stanice.
4. `FIX` bez `GBAS` = žádné korekce RTK.
5. Pořád nic → nahraj *Forenzní záznam GNSS* (**Nastavení › Rosbag**) a nahlas to.
6. V misi agenta čeká agent po nepovedeném výjezdu z doku na RTK sám (nejvýš 10 min, displej
   píše *Agent: waiting RTK*); bez RTK zajede zpátky do doku
   ([Když krok selže](agent.md#když-krok-selže)).

## Zajetí do doku selže

1. *Motors are OFF* → zapni motory a znovu stiskni **Dock** (zajetí do doku je samo nezapne).
2. *Map has no DOCK/UNDOCK point* → nastav body ([Dok](dock.md#body)).
3. Dokovací a výjezdový program musí být uložené (**Mapa › Dock**) a mapa by měla být dokončená
   *v doku*.
4. Odrazka se nenašla → očisti odrazku, dojeď s robotem pár metrů před dok čelem k němu a zkus
   to znovu. **Mapa › Dock › Dok podle odrazivosti** vyzkouší jen tuhle fázi.
5. Nepovedená sekvence se sama neopakuje; stav *failed* = přerušeno, detektory vypnuté, cíl
   zrušený. Mise agenta to ale zkusí znovu: zajede znovu před dok (UNDOCK) a dokuje odtamtud
   ([Když krok selže](agent.md#když-krok-selže)).

## FAULT supervisoru

Chat agenta píše, že supervisor je ve FAULT. Opakovaně zastavuje robota, dokud není zase
bezpečno; sám se uvolní, jakmile robot stojí aspoň 10 s s vypnutými motory i nožem. Zaparkovaná
mise pak většinou pokračuje sama; když řízení převzal člověk, čeká na `pokračuj`. Podrobnosti:
[FAULT supervisoru](agent.md#fault-supervisoru).

## Mise agenta nedoběhla

- *Robot je zpátky v doku, ale úloha nedoběhla*: agent zkusil své jiné možnosti, žádná nevyšla,
  tak robota přivezl domů. Chat napíše příčinu a každý pokus (*Zotavení cestou*). Odstraň příčinu
  (překážka, žádné RTK, bod na špatném místě) a zadej úkol znovu.
- *Need help - see app* na displeji: selhalo i zajetí do doku; robot stojí s vypnutými motory.
  Podívej se na něj, pak napiš `pokračuj` nebo ho domů dovez sám.
- Mise čeká po převzetí, STOPu nebo kvůli noži: tohle agent nikdy sám znovu nezkouší — napiš
  `pokračuj`, až bude bezpečno.

## Dokování se zrušilo bez důvodu

Zajetí do doku skončilo jako *failed*, i když nikdo nic nemačkal, často hned po restartu nebo po
FAULT supervisoru. Starší uzel sekání posílal doku zpožděný stop desítky sekund po stopu sekačky,
i když žádný program neběžel. Teď stop sekačky zruší zajetí do doku jen tehdy, když běží program
sekání, a to hned ([Sekací ústrojí](mowing.md#zastavení)). Když se to přesto stane, nahlas to i s
časem.

## Agent po restartu nevidí robota

Po restartu softwaru robota se agent sám za pár sekund znovu připojí; mise, která na robota
čekala, pokračuje. Když chat víc než minutu dál píše, že robot neodpovídá, zeptej se agenta
*stav robota* nebo to nahlas ([Restart robota během mise](agent.md#restart-robota-během-mise)).

## UI nereaguje

1. Obnov stránku. Šedé ikony, červená tečka vedle loga a *Bez spojení s robotem* v pásu hlášek =
   stránka ztratila spojení s robotem — klikni na tečku a připojí se hned.
2. Když nefunguje žádné tlačítko, spadl websocketový most robota (rosbridge) → restartuj stack
   robota: položka **Restart** v menu navbaru (restartuje službu robota; motory pak budou
   VYPNUTÉ).
3. Stránka se načte, ale po aktualizaci je nějaký panel rozbitý → tvrdé obnovení (Ctrl+Shift+R).
4. Panel agenta hlásí, že agent na tomhle robotu neběží nebo neodpovídá → po pádu se agent
   restartuje sám; počkej minutu. Pořád stejné → nahlas to.
5. Pro správce: webový uzel se restartuje přes `tools/restart_webnode` (nikdy `kill -9`).

## Kde jsou logy uzlů robota

Pro správce a agenta, na robotu (SSH). Každý ROS uzel píše do vlastního souboru v adresáři
aktuálního běhu, `~/.ros/log/latest/`:

- `<uzel>-N-stdout.log` — co uzel vypsal (jeho zprávy INFO, `print`). Jméno podle jmenného
  prostoru a jména uzlu, např. `d435-realsense2_camera_manager-12-stdout.log` nebo
  `mower-node_mower-26-stdout.log`. Sledovat průběžně:
  `tail -f ~/.ros/log/latest/navi_man-*-stdout.log`.
- `rosout.log` — zprávy **všech** uzlů v jednom souboru, u každého řádku jméno uzlu; nejrychlejší
  cesta, jak zjistit, kdo hlásil chybu: `grep -i error ~/.ros/log/latest/rosout.log`.
- `<uzel>-N.log` — vnitřní log Python uzlů; `roslaunch-*.log` — starty, pády a respawny uzlů.
- Journal služby (`journalctl -u vitulus`) je jen pro start stacku; dostane i varování a chyby
  uzlů (stderr), ale bez jmen uzlů — dívej se do souborů výš.
- Starší běh: `ls -t ~/.ros/log/` vypíše adresáře běhů, nejnovější první. Staré běhy se denně
  uklízí (starší než 7 dní, celý adresář pod 500 MB).

## Něco jiného

- Otevři **Nastavení › Diag** — červené řádky pojmenují část.
- Pohled **ROS** v logu s úrovní **Chyba** ukáže surové zprávy.
- Zeptej se agenta v Chatu: *proč robot nejede?* — přečte stav za tebe.
