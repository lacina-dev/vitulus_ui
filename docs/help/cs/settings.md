---
id: settings
title: Nastavení
group: Using the UI
order: 120
icon: la-cog
summary: Motory, Navigace, Napájení, Sekačka, Diagnostika, Rosbag, IMU a Aplikace (jazyk, agent, podpora, zobrazení) — k čemu je která záložka.
ui: [config, config/motors#motory, config/lidar#navigace, config/power#napájení, config/diag#diagnostika, config/rosbag#rosbag, config/imu#imu, config/app#aplikace]
related: [safety, mowing, status-icons]
keywords: [nastavení, aplikace, jazyk, čeština, angličtina, english, zobrazení, motory, moment, navigace, lidar, napájení, baterie, nabíjení, spánek, diagnostika, diag, rosbag, nahrávání, bag, imu, kalibrace]
---
# Nastavení

**Nastavení** (⚙ v pásu menu) má jednu záložku pro každou část robota a **Aplikace** pro samotnou
tuto aplikaci. **?** v hlavičce panelu skočí na záložku, kterou máš otevřenou.

## Motory

- **ON / OFF** — napájení čtyř pojezdových motorů. **Po každém startu jsou vypnuté**
  ([Bezpečnost](safety.md#motors-are-off-after-every-start)); zapni je tady, než budeš jezdit
  ručně nebo dokovat. Barva tlačítka sleduje skutečný stav motorů.
- **Torque** (0–24 Nm) a **Save** — omezení momentu motorů.
- Jedna karta na kolo (přední / zadní, levé / pravé): id, stav, moment, teplota, rychlost,
  poloha, napětí, režim. Ikony kol v navbaru zrcadlí jejich stav: zelená OK, oranžová teplé,
  červená horké, šedá vypnuto.

## Navigace

- **Speed** SLOW / MODERATE / FAST — totéž nastavení jako Slow / Mid / Fast v pravém panelu
  ([rychlosti](routes.md#speed)).
- **Lidar** ON / OFF.
- **RtabMap** zdroj senzoru (Camera / Lidar / Both) a vzdálenost — pro starší lokalizaci
  RTAB-Map; běžně se nemění.

## Napájení

- **Supply** — vstup nabíječky (V, A), baterie (V, A, stav nabíjení, %), kapacita, výstup
  počítače (NUC) a zda jsou zapnuté výstupy motorů a sekačky.
- **Temperature** — teplota desky a venkovní teplota a otáčky ventilátorů.
- **Outputs & limits** — výstup motorů a sekačky ON / OFF, nabíjecí a vypínací proudy pro běh
  a standby, teplotní limity desky a venkovní. Měň jen, když víš proč.
- **Sleep control** — doba spánku, **Sleep now** (Timed / Until charged), zpoždění standby,
  posun po nabití, timeout vybíjení. Plánovač spánek používá, když čeká
  ([Proč robot čeká](waiting.md)).

## Sekačka

Napájení sekačky, nůž, výška sekání a otáčky — viz [Sekací ústrojí](mowing.md).

## Diagnostika

Živý seznam diagnostiky robota (ROS `/diagnostics`): nahoře souhrn, pod ním skupiny řádků
*tečka · název · zpráva* ve stálém pořadí. Zelená OK, oranžová varování, červená chyba, šedá
zastaralé. Hodí se, když v navbaru něco svítí červeně a chceš vědět, která část.

## Rosbag

Nahrávání dat senzorů pro rozbor:

- **D435 RGB-D camera** — REC / STOP a snímková frekvence (FPS, **Set**).
- **GNSS forensics** — nahrává GPS heading, fix a vlastnictví pózy (pro problémy s lokalizací).
- **Stored bags** — seznam s **Download** a **Delete** (↻ obnoví).

Bagy zabírají hodně místa na disku; mazej, co už nepotřebuješ.

## IMU

Kalibrace inerciálního senzoru: **Remove DCD**, **Reset IMU**, **Run**, **Save** a stav IMU,
navigace, magnetometru, RTK a fúze. Malá páčka nechá robota během kalibrace jen otáčet na místě.
Určeno pro servis.

## Aplikace

Nastavení této aplikace (UI), ne robota. Nic tady s robotem nehne a nic na něm nemění kromě
uloženého jazyka.

- **Jazyk** — **English** nebo **Čeština**. Přepne se hned, bez načtení stránky, a ukládá se
  **na robota**, takže každý telefon i PC ukáže stejný jazyk (řádek pod tlačítky říká
  *Uloženo na robotu*). Když ho robot uložit nemůže (restartuje se, nebo stránka běží jako
  `?mock`), zůstane jen v tomto zařízení a řádek to řekne. Nápověda jde s jazykem; téma, které
  ještě není přeložené, se ukáže anglicky s poznámkou. Výchozí je angličtina.
- **Agent** — *Hustota zpráv* (Vzdušně / Úsporně, totéž co ▤ v panelu agenta), *Historie chatu*
  (Všechna zařízení / Tento prohlížeč, totéž co přepínač all / mine nad chatem) a záložka, na
  které se panel agenta *otevře*.
- **Podpora** — *Tvoje jméno*, kterým se podepisují rozhodnutí v **Needs you** (audit), záložka,
  na které se panel Podpora *otevře*, a zda jsou *rozhodnutí z UI robota* povolena. To poslední
  se tady jen ukazuje; zapíná se v Support kitu (**Otevřít dashboard podpory**).
- **Zobrazení** — co toto zařízení ukáže při příštím startu: log (Skrytý / Malý / Celá
  obrazovka) a co ukazuje (Změny / ROS), kameru malou nebo velkou, joystick, zda pohled sleduje
  mapu nebo robota, a pravý panel na telefonu (jeden řádek nebo celý).

Agent, Podpora a Zobrazení se pamatují **v tomto prohlížeči** (každý telefon a PC má svoje)
a sledují, co děláš jinde v UI — tady nastavíš, jak má vypadat příští start.
