---
id: localization
title: Lokalizace a GPS
group: Robot
order: 40
icon: la-crosshairs
summary: Jak robot ví, kde je — RTK, mapa, dok — a co znamenají jednotlivé stavy.
ui: [right/state, right/gnss#přijímače-gnss-pravý-panel--gnss, map/gloc#záložka-loc-globální-lokalizace-lidarem]
related: [mapping, dock, troubleshooting, status-icons]
keywords: [lokalizace, poloha, kurz, gps, gnss, rtk, fix, float, odhad, tracker, odometrie, relokalizace, lidar, gloc, pose, dead reckoning, heading, localize, relocalize, utm, datum, konvergence, skutečný sever, odchylka, mřížka]
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

![Sekce Navi pravého panelu s očíslovanými značkami](../img/shot-navi.webp "Pravý panel › Navi rozbalené: 1 čip Poloha · 2 zdroj kurzu · 3 tečka odometrie · 4 ikona detailu · 5 čipy odometrie VO / Li / Wh / FIX / PROB / ANC · 6 řádek trackeru")

Řádek s názvem Navi nese dva nejdůležitější čipy — kdo drží polohu (1) a zdroj kurzu (2) — a jednu
tečku odometrie (3): zelená = VO / Li / Wh běží, oranžová = jedna je zhoršená, červená = jedna je
ztracená, šedá = pozastavené v doku. Kliknutí na název rozbalí čipy odometrie (5) a jeden řádek
trackeru (6). Zprávou je barva (zelená v pořádku, oranžová ještě nepřesné, červená
špatně, šedá vypnuto); najetí myší nebo dlouhý stisk čipu řekne, co to je, a jeho číslo (kovarianci
odometrie, stáří korekcí za `FIX`, stáří kotvy). Malá ikona detailu v řádku s názvem (4, hned
před **?**) otevře levý panel **Mapa › Loc › Detail lokalizace**: poloha a odometrie
(každý čip slovy, využitý rozpočet driftu, poslední změny toho, kdo držel polohu), řádky
lidarového trackeru, RtabMap a oba přijímače GNSS.

První čip (1) říká, **kdo teď určuje polohu**:

| Čip | Barva | Význam |
|---|---|---|
| `RTK` | green | Polohu určuje GPS. Fix se nejdřív musí osvědčit: zhruba 1 m jízdy, nebo asi 10 s stání s ustáleným fixem a dobrým kurzem. |
| `DOK` | green | Ukotveno dokem. |
| `TRACKER` | orange | Sken lidaru sedí na mapu místa. |
| `RTABMAP` | orange | Lokalizace v mapě z kamery / lidaru (starší mapy). |
| `EXT` | orange | Vnější nebo starší zdroj. |
| `ODHAD` / `DR (…)` | red | Žádná pevná kotva — poloha ujíždí (v závorce je, která odometrie ji nese, např. `DR (LICP)`). Jezdi opatrně, delší mise zastav. |

Malé čipy vedle:

| Čip | Význam |
|---|---|
| `VO` / `Li` / `Wh` | odometrie z kamery, lidaru a kol — to, co skládá navigační filtr. Zelená = běží a sleduje; oranžová (`Li`) = běží, ale je ztracená; šedá = pozastavená v doku (rozběhne se hned, jak začne výjezd) — u `VO` také „kamera nesleduje", což je ve tmě normální; červená (`Li`, `Wh`) = déle než ~2 s žádná zpráva. Důvod ukáže najetí myší / dlouhé podržení. |
| `FIX` | použitelný surový RTK fix (bez ohledu na to, kdo drží polohu) |
| `PROB` | GPS fix se osvědčil (viz `RTK` výše) |
| `ANC` | kotva polohy: zelená = čerstvá, oranžová = zamrzlá (poloha jede na odometrii kol od poslední kotvy; i když zamrzne kotva kurzu); stáří ukáže tooltip |
| `SAT / IMU` (2) | kurz ze dvou antén GPS, nebo náhradně z IMU; oranžový `SAT` = antény hlásí kurz, kterému robot zatím nevěří |

### Řádek lidarového trackeru (`Trk`, levý panel › Mapa › Loc)

Lidarový tracker porovnává každý sken s mapou místa. **Čeká, dokud polohu drží GPS**, a převezme
ji až po zhruba 5 s bez použitelného fixu (aby krátké zablikání RTK polohu nepřehazovalo).

| Ukazuje | Význam |
|---|---|
| `ČEKÁ` · *polohu drží GPS · převezme po 5 s bez fixu* | běžný stav pod otevřeným nebem |
| `ČEKÁ` · *fix ztracen · převezme za N s* (oranžová) | fix právě vypadl; tracker vyčkává ochrannou dobu |
| `ČEKÁ` · *polohu drží dok* / *polohu drží RTAB-Map* | přednost má jiná kotva |
| `AKTIVNÍ` (zelená) · *opravuje* / *sedí* / *stojí* | tracker drží polohu na mapě; *shoda N cm* = jak dobře sken sedí |
| `AKTIVNÍ` (oranžová) · důvod | tracker běží, ale opravu zadržel, např. *mapa tady už nesedí*, *špatná shoda s mapou*, *jednostranná geometrie (chodba/zeď)* |
| `AKTIVNÍ` (červená) · *ztracen N s* | dlouho žádná dobrá shoda — zkusí úplnou relokalizaci |

Druhý řádek je **poslední oprava**: *odeslána 0.07 m / 1.2° · před 12 s*, *odmítnuta — polohu drží
dok* (dokud robota kotví dok, opravy trackeru ignoruje), nebo *zadrženo: důvod (×N)*; *odesláno N*
počítá všechny opravy od startu trackeru. Dokud drží polohu GPS, řádek ukazuje i *odchylku od
mapy N cm* — o kolik by tracker robota právě posunul; pár centimetrů znamená, že mapa pořád sedí.

Dvě ikony GPS v navbaru ([Ikony stavu](status-icons.md)) říkají totéž jednou barvou:
zelená = RTK, oranžová = 3D fix bez RTK (nebo float), červená = špatně, šedá = žádná data.
**Výjezd z doku čeká, až budou obě zelené** (zajetí do doku jen tehdy, když musí nejdřív nahrát
venkovní mapu doku).

## Přijímače GNSS (pravý panel › GNSS)

Robot má **dva** přijímače GPS. Řádek **GNSS** v pravém panelu to řekne značkami: fix Polohy,
fix Kurzu (`RTK` / `FLT` float / `DGN` DGNSS / `3D` / `NO`, barvy jako níže), satelity použité
pozičním přijímačem (zeleně od 12) a tečka stáří jeho korekcí — zelená < 2 s, oranžová < 10 s,
červená starší nebo žádné; čísla jsou v popiscích a nádech řádku je podle horšího přijímače.
Kliknutí na název rozbalí dvě dlaždice **Poloha | Kurz** s rychlými čísly (fix, satelity použité
/ viditelné, přesnost, stáří korekcí); ikona detailu v řádku s názvem (před **?**) otevře celou kartu — oba přijímače
vedle sebe — v levém panelu, **Mapa › Loc › Detail lokalizace › Přijímače GNSS**:

- **Poloha** — RTK rover. Korekce (RTCM) dostává ze **základnové stanice**.
- **Kurz** — druhá anténa. Korekce dostává z **pozičního přijímače** (*moving base*) a měří
  směr spojnice obou antén.

Každý sloupec má jemný nádech podle stavu: zelená = `RTK`, oranžová = `FLOAT` / `DGNSS` / `3D`
(fix, ale ještě ne na centimetry), červená = bez fixu, šedá = žádná data (`VYP`). U přijímače
kurzu znamená `RTK` pevné (fixed) řešení s platným kurzem.

| Řádek | Význam |
|---|---|
| `sat.` | satelity použité / viditelné; oranžově pod 12 |
| `přesn.` (Poloha) | vodorovná přesnost hlášená přijímačem: zelená ≤ 3 cm, oranžová ≤ 50 cm |
| `kurz` (Kurz) | přesnost kurzu: zelená ≤ 0,5°, oranžová ≤ 2° |
| `kor.` | stáří poslední korekce: zelená ≤ 3 s, oranžová starší nebo nepoužitá, červená > 10 s nebo `žádné` |
| `běží` | doba od startu přijímače |
| `RTK` | za jak dlouho po startu dosáhl RTK; `… 11:32` = ještě čeká (zatím); `ano` = RTK měl už předtím, než ho robot začal sledovat |

Když přijímač **nemá RTK**, řádek pod sloupci řekne, jak dlouho čeká, a **pravděpodobný důvod**:

| Důvod | Co dělat |
|---|---|
| *žádné korekce ze základnové stanice* | zkontroluj základnu (napájení, rádiové spojení) |
| *žádný moving-base proud* / *moving-base proud neúplný* | poziční přijímač nekrmí přijímač kurzu — po rebootu se to obvykle srovná samo; když trvá, restartuj GNSS |
| *korekce jsou staré* / *nepoužívá je* | spojení ztrácí zprávy — zkontroluj rádio |
| *málo satelitů* | popojeď pod volné nebe |
| *float — poziční přijímač ještě nemá RTK* | počkej, až zezelená Poloha |
| *float — korekce OK, řeší ambiguity* | normální zahřívání; stačí čekat |

*po startu obvykle ~N min* je medián doby do RTK z dřívějších startů toho přijímače (po rebootu
potřebuje přijímač kurzu často ~15 min).

**Klepni na kartu** pro podrobnosti: satelity po systémech (G = GPS, E = Galileo, C = BeiDou,
R = GLONASS), satelity s fázovou korekcí, každý typ RTCM zprávy s četností (`!` = některé nebyly
použity), vzdálenost k základně nebo délka základny antén a kdy po startu přišel první fix, float
a RTK. Dalším klepnutím je schováš.

## Když GPS nechytá fix

1. Je robot pod střechou, pod stromy nebo u zdi? Popojeď s ním pár metrů pod volné nebe.
2. Počkej — po startu může RTK trvat i několik minut.
3. Zkontroluj základnovou stanici (napájení, její vlastní spojení) — bez ní RTK není.
4. Když svítí `FIX`, ale ne `GBAS`, chybí korekce nebo jsou špatné.
5. Robot i tak může jezdit po mapě s lidarovým trackerem (`TRACKER`), jen méně přesně; dlouhé
   mise by měly na RTK počkat.

Viz také [Řešení problémů › GPS](troubleshooting.md#gps-nechytá-fix).

## Rámec UTM a mapa vs GPS (Mapa › Loc › Rámec UTM)

GPS dává polohu v **síti UTM** (zóna, východní a severní souřadnice v metrech). Mapa místa je
v této síti ukotvená svým **datumem**: bod 0,0 mapy v UTM a natočení mapy v síti. Mapa sama (i
odometrie) míří na **skutečný sever**; síť UTM je vůči skutečnému severu pootočená o
**konvergenci poledníků** — u středního poledníku zóny skoro nic (15° v. d. v zóně 33: −0,07°
na 14,9° v. d.), na okraji zóny asi 2°. Karta **Rámec UTM** v **Mapa › Loc** (hned pod Detail
lokalizace) ukazuje:

| Řádek | Význam |
|---|---|
| Zóna | zóna UTM + šířkový pás, např. `33U (33N)` |
| Počátek mapy | bod 0,0 mapy v UTM (E / N, metry) |
| Natočení mapy v síti | natočení mapy vůči síti UTM podle datumu |
| Konvergence poledníků | o kolik je samotná síť v počátku mapy pootočená vůči skutečnému severu |
| Mapa vs skutečný sever | natočení minus konvergence — má být ~0; oranžově, když není (zkontrolujte datum mapy) |

Věta pod tím to říká slovy i s tím, co by natočení stálo bez korekce (robot přes něj převádí GPS
od vydání field-2026.10.25): start 20 m od doku by posunul mapu o `2 · sin(|natočení| / 2) · 20 m`
(2,6 cm při −0,07°, 0,7 m při 2°).

**Mapa vs GPS** je živá odchylka mezi anténou GPS robota na mapě a polohou z GPS převedenou do
mapy přes datum: zelená ≤ 5 cm, oranžová ≤ 15 cm, výš červená. Měří se jen, když polohu drží GPS
(RTK fix, prověřený); jinak karta řekne proč — *v doku* (polohu drží dok, normální stav), *GPS
bez fixu*, *GPS bez RTK fixu*, *GPS zatím polohu nedrží*. Stejné číslo je řádek **Mapa–GPS**
v rozbalení pravého panelu › Navi (klik otevře kartu).

Na mapě:

- **Kompas** (levý horní roh mapy, jen u mapy s datumem): oranžová šipka = skutečný sever,
  čárkované **G** = sever sítě UTM; číslo je úhel mezi nimi. Otáčí se s pohledem.
- Vrstva **Mřížka UTM** (Mapa › Vrstvy): čáry UTM po 10 m (po 100 m výraznější) nakreslené do
  mapy — natočení mapy v síti je vidět na čarách. Pamatuje si ji každé zařízení zvlášť.
- Když odchylka přeroste oranžovou mez, poloha z GPS se ukáže jako kroužek vedle robota
  s čárkovanou spojnicí k anténě.

## Záložka Loc (globální lokalizace lidarem)

**Mapa › Loc** se ptá: *kam na nahranou mapu nejlíp sedí současný sken lidaru?* Použij ji,
když se robot ztratí (`ODHAD`, nebo je robot na mapě zjevně jinde, než ve skutečnosti stojí).

![Záložka Loc panelu Mapa s očíslovanými tlačítky](../img/shot-loc-tab.webp "Mapa › Loc: 1 Lokalizovat · 2 auto 5 s · 3 Použít → robot · 4 Vynutit · 5 karta Detail lokalizace (poloha a odometrie, lidarový tracker, RtabMap, přijímače GNSS — klepnutím na přijímače víc) · 6 řádek lidarového trackeru")

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
