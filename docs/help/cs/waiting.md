---
id: waiting
title: Proč robot čeká
group: Robot
order: 70
icon: la-hourglass-half
summary: Baterie, déšť, teplota, noční okno a další důvody, proč se nic nespouští.
ui: [map/rain]
related: [programs, mowing, troubleshooting]
keywords: [čeká, čekání, spánek, déšť, počasí, baterie, teplota, noc, předpověď, radar, nečinný, nespustí se, pozdržet, wait, waiting, sleep, rain, weather, battery, temperature, night, forecast, idle, does not start]
---
# Proč robot čeká

Často robot nic nedělá schválně. Proč, říká stavový řádek kalendáře
([Programy › Kalendář](programs.md#the-calendar)) a log.

## Než program začne

Plánovač nic nespustí, dokud:

- je automatika vypnutá, nebo je zapnuté **Pozdržet**;
- robot **není v doku**;
- od startu softwaru robota uběhlo méně než 5 minut, nebo ještě nejsou načtené programy;
- mise není připravená (např. po zastavení čeká na **Reset**);
- je mimo **denní okno 07:00–21:00** — robot spí, dokud se okno neotevře;
- naplánovaný program není na aktivní mapě (ten den se přeskočí).

Program se také odmítne spustit, když:

- je **baterie pod 40 %**;
- **právě prší**, pršelo v posledních 60 minutách, nebo je déšť v předpovědi do 30 minut
  (pokud nejsou kontroly deště vypnuté — viz [níž](#kontrola-deště-zap--vyp)).

Program z kalendáře odmítnutý kvůli baterii počká ve spánku, než se robot nabije; odmítnutý kvůli
dešti spí 4 h — pak to robot zkusí znovu.

### Kontrola deště zap / vyp

`weather_rain_bypass` zapíná a vypíná kontroly deště — tu před startem i tu během sekání:

- `false` (běžně): déšť start zablokuje a běžící program pošle domů, jak je popsáno tady;
- `true`: všechny kontroly deště se přeskočí — robot vyjede a seká i v dešti. Je to pro
  testování nebo vědomé obejití.

Jak to poznáš: s vypnutými kontrolami ukáže **Log** při startu programu varování
*Rain check BYPASSED by config* a program se spustí, i když v navbaru svítí výstraha deště.

Kde to změnit: `weather_rain_bypass` ve `vitulus_navi/config/mower_smach.yaml` (načte se při startu
softwaru robota). Mise hodnotu čte při každé kontrole, takže jde změnit i za běhu
`rosparam set /node_mower_smach/weather_rain_bypass false` — do příštího restartu, pak zase platí
soubor.

## Během sekání

| Důvod | Co se stane |
|---|---|
| Baterie ≤ 25 % | vrátí se do doku, nabije se a pak **pokračuje** |
| Déšť (2 ze 3 kroků předpovědi hlásí RAIN) | vrátí se, spí 4 h a pak to zkusí znovu |
| Přehřátá sekačka (TEMP) | vrátí se, spí 1 h |
| Kritická chyba | spí 30 min |
| Fatální chyba | čeká 20 min, provede reset a pak spí 8 h |
| Zastavil to člověk | nic automaticky — spusť to znovu sám |

Pokračování potřebuje aspoň 40 % baterie a týká se programů, které spustil kalendář; program, který
jsi spustil sám, nepokračuje (jen po kritické chybě se i tak spí). Spánky po přerušení se zkrátí
tak, aby byl robot vzhůru na další naplánovaný program. Když program skončí mimo dok, čeká se
20 minut, jestli se robot vrátí; pak robot přejde do nouzového spánku.

## Počasí (Mapa › Déšť)

Ikony mraků v navbaru ukazují výstrahu deště: v pořádku, déšť se čeká, právě prší (kliknutím
obnovíš). **Mapa › Déšť** má **Zprávu o počasí** (stav, výstraha, aktuální déšť, místo, čas
a časovou osu minulých a předpovězených kroků: OK / WARN / ALERT / RAIN / UNAVAILABLE), radarový
snímek **Déšť teď** a **Předpověď** (+10 / 20 / 30 min). Snímky se obnovují každých 30 s.

## Teplota

Ikony teploty (deska, venku) a ikony motorů zoranžoví, když je teplo, a zčervenají, když je
horko. Napájecí modul má vlastní teplotní limity (**Nastavení › Napájení**); bezpečnostní uzel
vypne pojezdové motory, když má některý z nich přes 70 °C, a stejně tak motor sekačky.
