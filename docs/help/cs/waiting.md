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
([Programy › Kalendář](programs.md#kalendář)) a log.

## Než program začne

```flow
Čas události v kalendáři | automatika zapnutá, Pozdržet vypnuté
V doku? | a software běží 5 min, programy načtené
Robot volný? | žádný program, dokování, ruční jízda ani agent; nečeká na Reset
warn: Denní okno? | 07:00–21:00 a zbývá z něj 30 min, jinak spí, dokud nezačne
warn: Baterie ≥ 40 %? | a neprší teď, v posledních 60 min ani do 30 min
ok: Start | robot vyjede z doku a seká; na RTK čeká až venku na undock bodě
```

Plánovač nic nespustí, dokud:

- je automatika vypnutá, nebo je zapnuté **Pozdržet**;
- robot **není v doku**;
- od startu softwaru robota uběhlo méně než 5 minut, nebo ještě nejsou načtené programy;
- mise není připravená (po zastavení nebo chybě čeká na **Reset**: říká to karta kalendáře), nebo
  robota používá program, dokování, ruční jízda či agent;
- je mimo **denní okno 07:00–21:00**, nebo z něj zbývá méně než 30 minut — robot spí, dokud se okno
  neotevře;
- naplánovaný program není na aktivní mapě (zkouší se každých 5 minut, pak se nahlásí).

Nic z toho nečeká na GPS: robot startuje v doku, kde je RTK slabé nebo žádné, vyjede a na RTK čeká
na undock bodě. Když tam RTK nepřijde, vrátí se a zkusí to znovu, nejvýš třikrát.

Program se také odmítne spustit, když:

- je **baterie pod 40 %**;
- **právě prší**, pršelo v posledních 60 minutách, nebo je déšť v předpovědi do 30 minut
  (pokud nejsou kontroly deště vypnuté — viz [níž](#kontrola-deště-zap--vyp)).

Program z kalendáře odmítnutý kvůli baterii se nabije na 80 %, odmítnutý kvůli dešti počká 2 h — pak
to robot zkusí znovu. Odmítnutí událost nespotřebuje.

Chybějící data o počasí (bez internetu, radar nejede, data starší než 30 minut) kalendář nezastaví:
robot seká a log napíše *No current weather data, starting anyway*. Mokrá tráva po dešti nemá vlastní
nastavení: tou rezervou je těch 60 minut po posledním dešti.

### Kontrola deště zap / vyp

`weather_rain_bypass` zapíná a vypíná kontroly deště u programů spuštěných ručně — před startem
i během sekání. Program, který spustil **kalendář**, déšť poslechne vždycky, ať je tu cokoli:
nikdo se na něj nedívá.

- `false`: déšť zablokuje start a běžící program pošle domů, jak je popsáno tady;
- `true`: u ručních spuštění se kontroly přeskočí — robot vyjede a seká i v dešti.

Jak to poznáš: s vypnutými kontrolami ukáže **Log** při startu programu varování
*Rain check BYPASSED by config* a program se spustí, i když v navbaru svítí výstraha deště.

Kde to změnit: `weather_rain_bypass` ve `vitulus_navi/config/mower_smach.yaml` (načte se při startu
softwaru robota). Mise hodnotu čte při každé kontrole, takže jde změnit i za běhu
`rosparam set /node_mower_smach/weather_rain_bypass false` — do příštího restartu, pak zase platí
soubor.

## Během sekání

| Důvod | Co se stane |
|---|---|
| Baterie ≤ 25 % | vrátí se do doku, nabije se na 80 % a **naváže**, kde skončil |
| Prší, nebo 2 ze 3 kroků předpovědi hlásí RAIN | vrátí se, každé 2 h to zkouší a **naváže**, kde skončil |
| Přehřátá sekačka (TEMP) | vrátí se, počká 1 h a **naváže** |
| Zavře se okno (21:00) | dokončí rozjetou dráhu, vrátí se a po otevření okna **naváže** další dráhou |
| Kritická chyba | vrátí se, počká 30 min a **naváže**; po 3 chybách jednoho běhu to vzdá a nahlásí |
| RTK není připravené | vrátí se, zůstane vzhůru a za 5 min to zkusí znovu; počítá se jako chyba výše |
| Fatální chyba v doku (nevyjel) | čeká 20 min, provede reset a zkusí znovu; počítá se jako chyba výše |
| Fatální chyba mimo dok | stojí a pípá; v kalendáři **Chce Reset** |
| Zastavil to člověk | nic automaticky — spusť to znovu sám |

**Naváže** znamená stejná zóna a dráha, od začátku 6m úseku, na kterém robot byl, a tolikrát, kolikrát
je potřeba. Program to vzdá s hlášením (zůstane v kartě kalendáře a **Resume** v Programech pořád
naváže) po 3 chybách, po 3 přerušeních za sebou bez posunu, po 12 přerušeních nebo po 48 hodinách.
Cestou domů se ztratí nejvýš ten jeden úsek.

Týká se to programů, které spustil kalendář; program spuštěný ručně sám nenaváže, použij **Resume**.
Restart stacku uprostřed nic nemění: robot ví, co je nedokončené, a naváže, až bude v doku (mimo dok
karta kalendáře řekne, že ho je potřeba přivézt). Událost, která mezitím přijde, na něj počká. Spánky
se zkrátí tak, aby byl robot vzhůru na další naplánovaný program.

## Jak robot spí

Spánek znamená, že je **počítač vypnutý** a v doku ho v nastavený čas probudí power modul. Děje se
to jen se [zapnutou automatikou](programs.md#automatika-zapnutá--vypnutá), nikdy při Hold, a robot zůstane
vzhůru, dokud ho někdo používá: program, přesun v doku, řízení, mise agenta, přihlášený terminál
nebo otevřené webové UI.

1. Power modul potvrdí čas probuzení. Když nepotvrdí, nestane se nic a robot zůstane vzhůru.
2. Systém se čistě vypne. Tři minuty po příkazu power modul odpojí napájení. Než vypínání začne,
   spánek zruší Hold nebo vypnutí automatiky.
3. Robot se probudí v doku asi 12 minut před programem. Spánek trvá nejvýš 12 hodin; po delší
   pauze se robot jen probudí, zkontroluje a znovu usne. V doku se na GPS nečeká, signál se řeší
   až na bodě po vydokování.

Nabíjení se prospí podle odhadu, nejvýš 6 hodin, pak robot zkontroluje baterii a případně usne
znovu, takže ztracený kontakt ho nenechá spát navždy. Když se nenabíjí, nebo dvě nabíjení nic
nepřidala, zůstane vzhůru a řekne ti to.

**Tlačítko power modulu spícího robota neprobudí**, tak teď power modul funguje.

Když program skončí mimo dok, čeká se 20 minut, jestli se robot vrátí. **Mimo dok robot nikdy
neusne**: potom to ohlásí, a pokud ho venku nechala automatika, jednou ho pošle domů. Robot, kterého
jsi zastavil, zůstane stát.

## Počasí (Mapa › Déšť)

Ikona mráčku (první ikona stavu v navbaru) ukazuje výstrahu deště: v pořádku, déšť se čeká,
právě prší (kliknutím obnovíš radar a otevřeš tuhle záložku). **Mapa › Déšť** má **Zprávu o počasí** (stav, výstraha, aktuální déšť, místo, čas
a časovou osu minulých a předpovězených kroků: OK / WARN / ALERT / RAIN / UNAVAILABLE), radarový
snímek **Déšť teď** a **Předpověď** (+10 / 20 / 30 min). Snímky se obnovují každých 30 s.

## Teplota

Ikony teploty (deska, venku) a ikony motorů zoranžoví, když je teplo, a zčervenají, když je
horko. Napájecí modul má vlastní teplotní limity (**Nastavení › Napájení**); bezpečnostní uzel
vypne pojezdové motory, když má některý z nich přes 70 °C, a stejně tak motor sekačky.
