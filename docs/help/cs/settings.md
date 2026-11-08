---
id: settings
title: Nastavení
group: Using the UI
order: 120
icon: la-cog
summary: Tři skupiny — Robot (Motory, Napájení, Sekačka), Senzory (Navi, Lidar, Kamera, IMU) a Systém (Aplikace, Diag, Rosbag) — k čemu je která záložka.
ui: [config, config/motors#motory, config/navi#navi, config/power#napájení, config/diag#diag, config/rosbag#rosbag, config/imu#imu, config/app#aplikace]
related: [safety, mowing, status-icons]
keywords: [nastavení, skupiny, robot, senzory, systém, settings, aplikace, app, jazyk, language, čeština, angličtina, english, zobrazení, motory, motors, moment, torque, navi, navigace, lidar, napájení, power, baterie, nabíjení, spánek, sleep, diagnostika, diag, rosbag, nahrávání, bag, imu, kalibrace, kamera, d435, camera]
---
# Nastavení

**Nastavení** (⚙ v pásu menu) má v horní řadě tři skupiny; řada pod ní obsahuje záložky
otevřené skupiny:

| Skupina | Záložky |
|---|---|
| **Robot** | Motory · Napájení · Sekačka |
| **Senzory** | Navi · Lidar · Kamera · IMU |
| **Systém** | Aplikace · Diag · Rosbag |

Skupina se otevře na záložce, kterou jsi v ní měl naposledy. **?** v hlavičce panelu skočí na
záložku, kterou máš otevřenou. Přepínač **ON / OFF** ukazuje stav vyplněnou polovinou: zelená =
zapnuto, šedá = vypnuto, červená = porucha (třeba vypnutý lidar).

## Motory

![Nastavení › Motory s očíslovanými značkami](../img/shot-motors.webp "1 ON / OFF · 2 omezení momentu · 3 jedna karta na kolo")

- **ON / OFF** — napájení čtyř pojezdových motorů. **Po každém startu jsou vypnuté**
  ([Bezpečnost](safety.md#po-každém-startu-jsou-motory-vypnuté)); zapni je tady, než budeš jezdit
  ručně nebo dokovat. Vyplněná polovina sleduje skutečný stav motorů.
- **Moment** (0–24 Nm) a **Uložit** — omezení momentu motorů. Prázdné číselné pole ukazuje
  povolený rozsah (tady i v Napájení).
- Jedna karta na kolo (**Přední levý**, **Přední pravý**, **Zadní levý**, **Zadní pravý**): id,
  stav, moment, teplota, rychlost, poloha, napětí, režim (– = od motoru zatím nepřišla data).
  Řádek nad kartami řekne, proč jsou tam pomlčky — motory jsou vypnuté, ještě nic neposlaly,
  nebo přestaly hlásit (pak karty zešednou: stará čísla). Ikony kol v navbaru ukazují jejich
  stav: zelená OK, oranžová teplé, červená horké, šedá vypnuto.

## Navi

Záložka navigace:

- **Rychlost** **SLOW / MODERATE / FAST** — totéž nastavení jako **Slow / Mid /
  Fast** v pravém panelu ([rychlosti](routes.md#rychlost)).
- **Lidar** **ON / OFF**; hlavička karty řekne ON, OFF nebo *stav neznámý*.
- **RtabMap** — **Zdroj senzorů** (**Kamera** / **Lidar** / **Obojí**) a **Dosah senzorů** —
  pro starší lokalizaci RTAB-Map; běžně se nemění. RTAB-Map je hlásí, jen když běží (při tvorbě
  mapy); do té doby to řekne řádek nahoře, *teď* ukazuje – a zdroj, který vybereš, se uloží pro
  jeho příští spuštění (pošle se se vzdáleností pod jezdcem). Jakmile hlásí, jezdec ukazuje
  jeho vzdálenost a zdroj jeho volbu; **Použít** pošle samotnou novou vzdálenost.
- **Pokročilé (plánovač)** — uložená data plánovače a sestavení mapy s filtrem šumu, okrajem
  překážek a tvarem výplně. Přesunuto sem z editoru mapy; běžně se nemění.

## Napájení

- **Zdroj** — **Vstup** z nabíječky (V, A), **Baterie** (V, A, stav nabíjení, %), **Kapacita**,
  **Výstup NUC** (počítač) a **Výstup motorů** a **Výstup sekačky** (ON / OFF slovy).
- **Teplota** — teplota **Deska** a **Venku**, otáčky **Větrák desky** a **Vnější větrák**.
- **Výstupy a limity** — výstup motorů a sekačky **ON / OFF** (vyplněná polovina = skutečný
  stav), nabíjecí a vypínací proudy pro běh a pohotovost, limit teploty desky (PCB) a vnější
  teploty. Měň jen, když víš proč.
- **Tvrdý restart: vypnout vše na N s** — stejná karta jako v [Autonomii](autonomy.md).
- **Pokročilé: přímé ovládání spánku** (sbalené, jen pro servis: robota uspávej v
  [Autonomie › Spánek](autonomy.md#baterie-spánek-poruchy)) — **Doba spánku**, **Uspat teď** (**Na čas** / **Do nabití**), **Prodleva
  pohotovosti**, **Posun po nabití**, **Limit vybíjení**. **Uspat teď** › **Na čas** nejdřív řekne, kolik minut bude spát, a zeptá se znovu: vezme hodnotu, kterou napíšeš, jinak tu, co drží napájecí modul (poslední zapsanou, obvykle od plánovače). Odpojí napájení bez
  vypnutí systému; plánovač systém nejdřív vypne a prodlevu pohotovosti nastaví na 3 minuty
  ([Jak robot spí](waiting.md#jak-robot-spí)).

## Sekačka

Napájení sekačky, nůž (**START MOTOR** zabere, až když ho půl sekundy podržíš), výška sekání
a otáčky — viz [Sekací ústrojí](mowing.md).

## Diag

Živý seznam diagnostiky robota (ROS `/diagnostics`): nahoře souhrn, pod ním skupiny řádků
*tečka · název · zpráva* ve stálém pořadí. Zelená OK, oranžová varování, červená chyba, šedá
zastaralé. Hodí se, když v navbaru něco svítí červeně a chceš vědět, která část to je.

## Rosbag

Nahrávání dat senzorů pro rozbor:

- **Kamera D435 RGB-D** — **REC** / **STOP** a snímková frekvence (FPS, **Nastavit**).
- **Forenzní záznam GNSS** — nahrává kurz z GPS, fix a to, kdo právě určuje polohu (pro problémy
  s lokalizací).
- **Uložené bagy** — seznam, u každého bagu **Stáhnout** a **Smazat** (koš); ↻ seznam obnoví.
  Bag, který se právě nahrává, má **● REC** a zatím nejde stáhnout ani smazat. Bag se štítkem
  **nedokončený** zbyl po nahrávání, které neskončilo (třeba po výpadku proudu), a teď se nic
  nenahrává: stáhnout ho jde, smazat tady ne.

Bagy zabírají hodně místa na disku; mazej, co už nepotřebuješ.

## IMU

Kalibrace inerciálního senzoru, určeno pro servis. Kroky jsou očíslované:

1. **Run** — spustí vlastní kalibraci IMU. Robot sám **nejede**: asi minutu ho malou páčkou pod
   kartou (umí jen otáčet) pomalu otáčej na místě.
2. **Uložit** — uloží výsledek do IMU.

Pod **Servis**: **Reset IMU** restartuje senzor (kalibrace zůstane) a **Odstranit DCD** smaže
uloženou kalibraci. Vpravo kurz podle IMU, navigace, magnetometru, RTK a fúze.

## Kamera

Všechno o hloubkové kameře (D435): jestli běží, jak přesnou má hloubku (**Zkontrolovat**
ji porovná s lidarem), **Kalibrovat…** — průvodce, který kameru zkalibruje proti stěně bez
pohybu robota — nastavení snímače a vrstvy v obraze. Podrobnosti:
[Kamera (D435)](camera.md).

## Aplikace

![Nastavení › Aplikace s očíslovanými čtyřmi kartami](../img/shot-app.webp "Nastavení › Aplikace: 1 Jazyk · 2 Agent · 3 Podpora · 4 Zobrazení")

Nastavení téhle aplikace (UI), ne robota. Nic tady s robotem nehne a nic na něm nemění kromě
uloženého jazyka.

- **Jazyk** — **English** nebo **Čeština**. Přepne se hned, bez načtení stránky, a ukládá se
  **na robota**, takže každý telefon i PC ukáže stejný jazyk (řádek pod tlačítky napíše
  *Uloženo na robotu*). Když ho robot uložit nemůže (restartuje se, nebo stránka běží jako
  `?mock`), zůstane jen v tomto zařízení a řádek to řekne. Nápověda jde s jazykem; téma, které
  ještě není přeložené, se ukáže anglicky s poznámkou. Výchozí je angličtina.
- **Agent** — **Hustota zpráv** (**Vzdušně** / **Úsporně**, totéž co ▤ v panelu agenta),
  **Historie chatu** (**Všechna zařízení** / **Tento prohlížeč**, totéž co přepínač nad chatem)
  a **Agent se otevře na** (záložka panelu agenta).
- **Podpora** — **Tvoje jméno**, kterým se podepisují rozhodnutí v **Čeká na tebe** (audit),
  **Podpora se otevře na** (záložka panelu Podpora) a jestli jsou povolená **Rozhodnutí z UI
  robota**. To poslední se tady jen ukazuje; zapíná se v Support kitu (**Otevřít dashboard
  podpory**).
- **Zobrazení** — co toto zařízení ukáže při příštím startu: **Log při startu** (**Skrytý** /
  **Malý** / **Celá obrazovka**) a **Log ukazuje** (**Změny** / **ROS**), **Kamera při startu**
  (**Malá** / **Velká**), **Joystick při startu**, **Pohled sleduje** (**Mapu** / **Robota**) a
  **Pravý panel na telefonu** (**Jeden řádek** / **Celý**).

Agent, Podpora a Zobrazení se pamatují **v tomto prohlížeči** (každý telefon a PC má svoje)
a sledují, co děláš jinde v UI — tady nastavíš, jak má vypadat příští start.
