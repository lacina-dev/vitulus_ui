---
id: routes
title: Trasy, body a značka
group: Robot
order: 58
icon: la-map-signs
summary: Pošli robota někam — značkou, uloženým bodem nebo uloženou trasou.
ui: [marker, map/path#trasy, map/point#body]
related: [map-editor, frame, safety]
keywords: [značka, cíl, odeslat cíl, zrušit navigaci, trasa, bod, jet, jízda, nahrát trasu, rychlost, marker, goal, send goal, cancel navigation, path, point, waypoint, go, drive, record path, speed]
---
# Trasy, body a značka

Ve všech těchto případech jede robot sám po aktivní mapě — pojezdové motory musí být zapnuté
a robota nebo obraz z kamery bys měl vidět. **Zrušit navigaci** nebo **STOP** jízdu ukončí.

## Cíl pomocí značky

![Panel Značka vedle mapy, s očíslovanými značkami](../img/shot-marker.webp "1 Kurz · 2 Odeslat cíl · 3 Zrušit navigaci — samotná značka cíle je na mapě vedle robota")

1. V pásu menu otevři **Značka**. Na mapě se objeví značka cíle.
2. Klikni nebo ťukni do mapy tam, kam má robot jet (nebo značku přetáhni).
3. Posuvníkem **Kurz** ji natoč tím směrem, kterým má robot nakonec stát.
4. Stiskni **Odeslat cíl**.

Když plánovač nenajde cestu, zkusí to až třikrát; když selže samotná jízda, smaže si paměť
překážek a naplánuje znovu, než to vzdá.
**Zrušit navigaci** jízdu zastaví (v logu je *Goal canceled*; motory zůstanou zapnuté).

## Rychlost

![Panel jízdy](../img/shot-joystick.webp "1 nejvyšší rychlost joysticku · 2 − / + a sloupce · 3 Pomalu / Středně / Rychle = režim robota")

Robot má tři **režimy rychlosti** — Pomalu, Středně, Rychle (`/navi_manager/speed`). Režim určuje
rychlost navigace (trasy, body, programy) a robot si ho pamatuje i přes restart. Přepíná se v
**panelu jízdy** (Joystick ve spodní liště): **Pomalu / Středně / Rychle** pod sloupci rychlosti —
rozsvícený je režim, který hlásí robot, klik ho přepne. Navigace:

| | vpřed | vzad | otáčení |
|---|---|---|---|
| Pomalu | 0,25 m/s | 0,25 m/s | 0,9 rad/s |
| Středně | 0,4 m/s | 0,25 m/s | 0,9 rad/s |
| Rychle | 0,75 m/s | 0,5 m/s | 1,5 rad/s |

Joystick má uvnitř režimů 7 jemnějších kroků (sloupce; horní řádek ukazuje krok v m/s):

| krok | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| nejvyšší rychlost (m/s, i vzad) | 0,10 | 0,18 | **0,25** | 0,32 | **0,40** | 0,55 | **0,75** |
| otáčení (rad/s) | 0,4 | 0,5 | 0,6 | 1,0 | 1,3 | 1,4 | 1,5 |
| režim | Pomalu | Pomalu | Pomalu | Středně | Středně | Rychle | Rychle |

**Tučný** krok je vlastní krok režimu (= jeho rychlost navigace); použije se, když režim přepne
někdo zvenku (program, jiný prohlížeč). Samotná kola jsou omezená na 1,4 m/s a 1,75 rad/s
(`mobile_base_controller`); UI nikdy nechce víc než 0,75 m/s.

## Body

![Mapa › záložka Bod s očíslovanými značkami](../img/shot-point-tab.webp "Mapa › Bod: 1 název · 2 Přidat · 3 Smazat body") ![Mapa › záložka Trasa s očíslovanými značkami](../img/shot-path-tab.webp "Mapa › Trasa: 1 název · 2 Nová · 3 Nová auto · 4 Stop auto · 5 Smazat trasy")

**Mapa › Bod** ukazuje uložené body: tlačítko se značkou na začátku řádku na bod dojede,
**Ukázat** ho ukáže na mapě, **✕** ho odebere. Napiš název a stiskni **Přidat** — uloží se
současná poloha robota jako nový bod; **Smazat body** smaže všechny body mapy. **Zrušit navigaci**
jízdu zastaví.

## Trasy

**Mapa › Trasa** ukazuje uložené trasy: tlačítko se šipkou na začátku řádku trasu projede,
**Přidat** k ní přidá současnou polohu robota jako další bod, **Ukázat** ji ukáže, **✕** ji odebere.
Nahrání nové: napiš název a pak **Nová** (začne v současné poloze, body přidáváš za jízdy) nebo
**Nová auto** (nahrává sama za jízdy; **Stop auto** ji ukončí). **Smazat trasy** smaže všechny
trasy mapy. **Zrušit navigaci** jízdu zastaví.

Trasy a body jde nakreslit i v [editoru mapy](map-editor.md).
