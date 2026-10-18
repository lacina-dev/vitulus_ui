---
id: localization
title: Lokalizace a GPS
group: Robot
order: 40
icon: la-crosshairs
summary: Jak robot ví, kde je — RTK, mapa, dok — a co znamenají jednotlivé stavy.
ui: [right/state, map/gloc#záložka-loc-globální-lokalizace-lidarem]
related: [mapping, dock, troubleshooting, status-icons]
keywords: [lokalizace, poloha, kurz, gps, gnss, rtk, fix, float, odhad, tracker, odometrie, relokalizace, lidar, gloc, pose, dead reckoning, heading, localize, relocalize]
---
# Lokalizace a GPS

Robot skládá jednu polohu (*pose*) z několika zdrojů:

- **RTK GPS** — dva přijímače na robotu a základnová stanice dávají centimetrovou přesnost
  i kurz. Nejlíp pod volným nebem.
- **Dok** — když robot sedí v doku, ví přesně, kde je.
- **Lidarový tracker** — porovnává sken lidaru s mapou místa; funguje i v noci a pod stromy.
- **Odometrie** — kola, lidar (Li) a kamera (VO) měří, jak se robot pohybuje; sama o sobě ujíždí.

![Čtyři zdroje dávají jednu polohu; čip Poloha říká, který ji teď určuje](../img/localization.svg "1 RTK GPS (satelity, základnová stanice, dvě antény) · 2 dok · 3 lidarový tracker (sken proti mapě) · 4 odometrie (kola, IMU) · 5 jedna poloha · 6 čip Poloha: zelená = ukotveno, oranžová = podle mapy, červená = ujíždí")

## Jak číst stav (pravý panel › Navi)

![Sekce Navi pravého panelu s očíslovanými značkami](../img/shot-navi.webp "Pravý panel › Navi: 1 čip Poloha · 2 zdroj kurzu (kurz) · 3 čipy odometrie VO / Li / Wh / FIX / PROB · 4 GNSS fix · 5 satelity · 6 přesnost polohy · 7 přesnost kurzu")

První čip (1) říká, **kdo teď určuje polohu**:

| Čip | Barva | Význam |
|---|---|---|
| `RTK` | green | Polohu určuje GPS. Fix se nejdřív musí osvědčit: zhruba 1 m jízdy, nebo asi 10 s stání s ustáleným fixem a dobrým kurzem. |
| `DOK` | green | Ukotveno dokem. |
| `TRACKER` | orange | Sken lidaru sedí na mapu místa. |
| `RTABMAP` | orange | Lokalizace v mapě z kamery / lidaru (starší mapy). |
| `EXT` | orange | Vnější nebo starší zdroj. |
| `ODHAD` / `DR (…)` | red | Žádná pevná kotva — poloha ujíždí (v závorce je, která odometrie ji nese, např. `DR (LICP)`). Jezdi opatrně, delší mise zastav. |

Malé čipy vedle: **VO / Li / Wh** = vizuální, lidarová a kolová odometrie (zelená = použitelná,
orámovaná = právě používaná), **FIX** = použitelný surový RTK fix, **PROB** = GPS fix se osvědčil
(viz `RTK` výše), **Δ** = o kolik se odhad můstku liší od živé polohy, **kurz SAT / IMU** = kurz ze dvou antén GPS, nebo náhradně z IMU.

Řádek **GNSS**:

| Ukazuje | Význam |
|---|---|
| `GBAS` | RTK fixed — dobrý stav |
| `FIX` | běžný fix (i RTK float) — ne na centimetry |
| `SBAS` | fix se satelitní korekcí |
| `BEZ FIXU` | GPS nedává polohu |
| `fix —` | žádná data |
| `sat. N` | počet použitých satelitů |
| `pol. ±cm` | přesnost polohy: zelená ≤ 5 cm, oranžová ≤ 50 cm, červená víc |
| `kurz ±°` | přesnost kurzu: zelená ≤ 2°, oranžová ≤ 6°, červená víc; `—` = bez RTK kurzu |

Dvě ikony GPS v navbaru ([Ikony stavu](status-icons.md)) říkají totéž jednou barvou:
zelená = RTK, oranžová = 3D fix bez RTK (nebo float), červená = špatně, šedá = žádná data.
**Výjezd z doku čeká, až budou obě zelené** (zajetí do doku jen tehdy, když musí nejdřív nahrát
venkovní mapu doku).

## Když GPS nechytá fix

1. Je robot pod střechou, pod stromy nebo u zdi? Popojeď s ním pár metrů pod volné nebe.
2. Počkej — po startu může RTK trvat i několik minut.
3. Zkontroluj základnovou stanici (napájení, její vlastní spojení) — bez ní RTK není.
4. Když svítí `FIX`, ale ne `GBAS`, chybí korekce nebo jsou špatné.
5. Robot i tak může jezdit po mapě s lidarovým trackerem (`TRACKER`), jen méně přesně; dlouhé
   mise by měly na RTK počkat.

Viz také [Řešení problémů › GPS](troubleshooting.md#gps-nechytá-fix).

## Záložka Loc (globální lokalizace lidarem)

**Mapa › Loc** se ptá: *kam na nahranou mapu nejlíp sedí současný sken lidaru?* Použij ji,
když se robot ztratí (`ODHAD`, nebo je robot na mapě zjevně jinde, než ve skutečnosti stojí).

![Záložka Loc panelu Mapa s očíslovanými tlačítky](../img/shot-loc-tab.webp "Mapa › Loc: 1 Lokalizovat · 2 auto 5 s · 3 Použít → robot · 4 Vynutit")

1. **Lokalizovat** (nebo zaškrtni **auto 5 s**) — spočítá kandidáty. Samotný výpočet robotem
   nikdy nepohne.
2. Přečti výsledek: nejlepší polohu, skóre a **odstup**:
   *✓ jednoznačné*, *⚠ NEJEDNOZNAČNÉ* nebo *⚠ NESEDÍ KURZ (zrcadlová záměna?)*. Tepelná mapa
   ukazuje shodu (žlutá = lepší, modrý křížek = nejlepší, červený křížek = kde si robot myslí, že
   je).
3. **Použít → robot** pošle nejlepší polohu do lokalizace. Jde stisknout jen u jednoznačného
   výsledku; u doku ji robot i tak může odmítnout (dok má přednost).
4. **Vynutit** ji použije i tak — jen pro záchranu, když si jsi jistý.

> [!TIP]
> Poloha, která poskočí hned po výjezdu z doku, se obvykle ustálí, jakmile se RTK osvědčí (zhruba
> 1 m jízdy nebo krátké zastavení pod volným nebem). Když je robot hodně mimo, zastav, použij
> Loc a pak pokračuj.
