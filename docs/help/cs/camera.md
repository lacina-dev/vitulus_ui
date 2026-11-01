---
id: camera
title: Kamera (D435) — přesnost a kalibrace
group: Robot
order: 70
icon: la-camera
summary: Nastavení › Kamera — kontrola hloubky proti lidaru, kalibrace kamery jedním tlačítkem s průvodcem, nastavení snímače, co je překážka a co volno, a vrstvy v obraze.
ui: [config/camera]
related: [settings, frame, mapping, troubleshooting]
keywords: [obstacles, free, rest, ground, segmentation, max_depth, obstacle detection, detekce překážek, /dev/video, uvcvideo, secure boot, librealsense2-dkms, předání, obnovit kameru, usb, reset ovladače, kamera, d435, realsense, hloubka, přesnost, kalibrace, kalibrovat, tare, on-chip, lidar, překážky daleko, vzdálenost, chyba, emitor, laser, expozice, vyvážení bílé, vrstvy, vrátit, tovární, camera, depth, calibration]
---
# Kamera (D435)

**Nastavení › Kamera** obsahuje všechno o hloubkové kameře robota (Intel RealSense D435): jestli
běží, jak přesnou má hloubku, její kalibraci, nastavení snímače, co se počítá jako překážka, a
vrstvy kreslené přes obraz.

## Proč na přesnosti záleží

Kamera vidí překážky, které lidar nevidí (nízké věci, věci nad rovinou lidaru). Ty jdou do
costmapy a do mapy **tam, kde je kamera naměří**. Kamera s nepřesnou hloubkou nakreslí překážku
*za* její skutečné místo — a chyba rychle roste se vzdáleností: u stereo kamery roste s **druhou
mocninou** vzdálenosti (dvakrát dál = čtyřikrát větší chyba).

Lidar měří stěny zhruba na centimetr, takže ho robot používá jako metr: bez RealSense Vieweru
a bez člověka s metrem.

## Kontrola

Stiskni **Zkontrolovat** v kartě **Přesnost hloubky**. Robot pár sekund porovnává hloubku kamery
s lidarem všude, kde oba vidí stejnou plochu; kamera přitom běží dál. Uvidíš:

| Řádek | Význam |
|---|---|
| Chyba na 1 / 2 / 3 m | o kolik dál (+) nebo blíž (−) kamera vidí věci, než skutečně jsou |
| Kontrola | kdy |
| body, rozsah | kolik bodů lidaru sedělo a jak daleko byly |

| Verdikt | Chyba na 2 m | |
|---|---|---|
| green | přesná | ≤ 5 cm |
| orange | mírně mimo | ≤ 12 cm — kalibrace pomůže |
| red | potřebuje kalibraci | > 12 cm |
| grey | bez dat / jen blízké stěny | natoč robota ke stěnám nebo sloupkům 1–4 m daleko a zkontroluj znovu |

> [!TIP]
> Kontrola potřebuje něco, co vidí lidar i kamera: stěny, sloupky, zárubně, plot. Na otevřeném
> trávníku data nejsou.

## Kalibrace (průvodce)

**Kalibrovat…** otevře průvodce přímo v kartě. Robotem nikdy nehýbe; kamera se asi na minutu
pozastaví (mezitím žádné překážky z kamery).

```flow
Připrav scénu | rovná stěna 0,6–2 m před kamerou, všechny řádky zelené
Kalibrace | záloha, on-chip, tare, kontrola — asi minuta
ok: Výsledek | uloženo do kamery, nebo zůstává předchozí kalibrace
```

1. **Připrav scénu.** Postav robota čelem k rovné stěně, vratům garáže nebo plotové desce,
   **0,6–2 m** daleko (nejlíp 1–1,5 m). Živý obraz ukazuje **rámeček uprostřed** — na této
   oblasti se kamera kalibruje; stěna ho musí vyplnit. Nejlépe fungují povrchy se strukturou
   (cihla, dřevo, omítka); ne sklo, zrcadla ani stěna na ostrém slunci. Robota posuneš tak, že
   zapneš motory a popojedeš joystickem, nebo ho s vypnutými motory přetlačíš rukou. Kontrolní
   seznam pod obrazem zezelená řádek po řádku a u červeného řádku řekne, co udělat:

   | Červený řádek | Co udělat |
   |---|---|
   | Robot se hýbe | nech ho stát |
   | Běží program sekání | nejdřív ho zastav |
   | Před kamerou není stěna | natoč robota ke stěně |
   | Moc blízko / moc daleko | 0,6–2 m |
   | Pod úhlem | natoč robota kolmo ke stěně (nejvýš 30°) |
   | Stěna není v rámečku | přijeď blíž; ne sklo, zrcadla, tmavé plochy |
   | Nerovný povrch / zem v rámečku | vyber hladkou stěnu, která zakryje střed obrazu |

   **Změřeno metrem** (volitelné): vzdálenost od předního skla kamery ke stěně, kolmo ke stěně.
   Když zůstane prázdné, změří ji lidar (doporučeno).
2. **Spustit kalibraci.** Robot zazálohuje kalibraci kamery, spustí **on-chip** kalibraci (šum
   hloubky) a **tare** (absolutní vzdálenost, na vzdálenost stěny z lidaru) a výsledek znovu
   porovná s lidarem. **Zrušit** funguje, dokud se kamera nevrátí; pak se nic nezmění.
3. **Výsledek.** Když se chyba zmenšila, nová kalibrace se **uloží do kamery** (zůstane tam i po
   restartu a používá ji všechno, co čte kameru). Jinak zůstává předchozí kalibrace — do paměti
   kamery se nic nezapsalo. Karta ukáže chybu na 2 m a u stěny předtím a potom.

## Kamera během kalibrace (předání)

Kameru používají dva: ROS ovladač, který ji streamuje robotu, a kalibrace, která s kamerou mluví
napřímo. Předání je pevná posloupnost; průvodce ukazuje každý krok s jeho stavem (čeká / běží /
ok / chyba) a časem a **každý krok ověří svůj výsledek, než začne další**:

```flow
Připraveno | ROS kamera běží, USB se nepřipojuje dokola, nikdo jiný ji nedrží, nic není pozastavené, ovladač kamery pro /dev/video je načtený
Pauza | ROS kamera pozastavená, USB zařízení kamery 2 s ustálená
Relace | jedna kalibrační relace: záloha, on-chip, tare, zápis do kamery, zpětné čtení
Uvolněno | kalibrace už z kamery nic nedrží
Zpět | reset kamery načte novou kalibraci; ROS kamera zase běží (15 Hz)
ok: Potom | stěna uprostřed obrazu a kontrola lidarem, porovnané se stavem předtím
```

Když je výsledek horší než předtím, stejné čtyři kroky proběhnou ještě jednou (řádky *Vrácení: …*)
a zapíšou zpět zálohu, zpětně přečtenou a ověřenou.

- **Připraveno** je i součástí kroku 1 průvodce (*Předání kamery*). Červený řádek tam blokuje
  **Spustit**; u *USB se připojuje dokola*, *bez hloubky* a *pozastavená z dřívějška* se ukáže
  **Obnovit kameru** (reset ovladače kamery a čekání, až zase poteče hloubka — asi 20–40 s).
- **/dev/video**: ROS kamera mluví s kamerou napřímo přes USB, kalibrace přes systémový ovladač
  kamery (`uvcvideo`, zařízení `/dev/video`). Dokud ROS kamera běží, `/dev/video` neexistuje — to
  je v pořádku; zařízení se objeví, když se ROS kamera pozastaví. Když se ovladač nemůže načíst
  vůbec, svítí červeně řádek *Kalibrace nemá přístup ke kameře přes /dev/video*, řekne proč
  a ukáže **jeden příkaz, který to opraví** — průvodce pak kameru vůbec nepozastaví. Obvyklá
  příčina je **Secure Boot** spolu s balíkem `librealsense2-dkms`: jeho ovladač není podepsaný
  klíčem, kterému počítač věří, Secure Boot ho nepustí, a protože nahrazuje systémový ovladač,
  nenačte se žádný. Oprava ten balík odebere; pak se načte systémový podepsaný ovladač (umí
  hloubkové formáty D435 i kalibrační příkazy) a ROS kamery se to netýká:

  ```
  sudo apt-get remove -y librealsense2-dkms && sudo modprobe uvcvideo
  ```

  Pak průvodce zavři a otevři znovu; řádek zezelená.
- **Zpět**: když se obraz do 20 s nevrátí, robot sám resetuje ovladač kamery a čeká až 40 s.
  Teprve pak hlásí, že se kamera nevrátila.
- Firmware kamery neumí kalibraci vyzkoušet před uložením: nová kalibrace začne platit až po
  **zápisu do kamery a resetu kamery**. Robot ji proto zapíše, ověří, že paměť kamery vrací
  přesně to, co se zapsalo, kameru resetuje a teprve pak měří. Když se chyba u stěny nebo
  kontrola lidarem zhoršila, zapíše sám zpět zálohu.
- **Knihovna pro kalibraci** (pyrealsense2) musí odpovídat firmwaru kamery (FW 05.14 → 2.53.1).
  Robot si správnou nainstaluje sám do vlastní složky; řádek v *Předání kamery* řekne, když chybí
  nebo nesedí, s tlačítkem **Nainstalovat knihovnu pro kalibraci** (potřebuje internet).
  S neodpovídající knihovnou kamera měří stejně, ale kalibraci do ní nejde zapsat.
- Robot mění jen to, co je potřeba: **on-chip** jen když health říká, že kalibraci jde zlepšit
  (|health| ≥ 0,25), **tare** jen když vzdálenost u stěny nesedí o víc než 1,5 cm (nebo 1 %).
  Když není potřeba ani jedno, výsledek je *Kamera je přesná — není co měnit* a nic se nezapíše.
  Když je potřeba obojí u kamery bez náhledu v RAM, tare běží ve vlastní relaci až po zápisu
  a načtení výsledku on-chip (řádky *Tare: …*).
- Každý konec průvodce řekne, kde kamera je (*zpět a běží* / *neběží*) a jestli se do kamery
  něco zapsalo.

**Test předání kamery** (v *Podrobnostech a historii*) projde přesně tuto posloupnost s 3 s
streamem a nic nezapíše — rychlé ověření, že předání na tomhle robotu funguje.

## Když to nejde

- **Tlačítko Spustit zůstává šedé** — v seznamu je červený řádek; text říká proč.
- **„Neproběhla on-chip ani tare kalibrace"** — scéna kameře nestačila (málo struktury, moc
  tma, moc světla). Zkus jinou stěnu.
- **„Pořád moc mimo"** — zkus jinou stěnu, blíž (asi 1 m), mimo přímé slunce.
- **„Kamera se nevrátila ani po resetu ovladače"** — stiskni **Obnovit kameru**; když obraz
  zůstane černý, restartuj stack.
- **„Po pozastavení se kamera dál znovu připojovala na USB"** — kamera je vrácená; počkej minutu
  (řádek *Kamera je na USB stabilní* zezelená) a zkus to znovu. Když se to opakuje, zkontroluj
  USB kabel a konektor kamery.
- **„Po pozastavení se kamera vůbec neobjevila jako /dev/video"** — chybí ovladač kamery;
  krok 1 průvodce (řádek *… přes /dev/video*) řekne proč a jak to opravit.
- **„Kameru nešlo použít pro kalibraci"** — malý řádek *Detail* říká, co hlásila knihovna
  kamery; nic se nezapsalo. **Test předání kamery** ukáže, který krok selhává.
- **Chybí knihovna pro kalibraci** — kontrola funguje, kalibrace potřebuje na robotu
  `pyrealsense2`.

## Vrátit a tovární

**Podrobnosti a historie** ukazuje poslední kalibrace. **Vrátit předchozí** zapíše kalibraci
z doby před poslední uloženou; **Tovární kalibrace** zapíše tu, se kterou kamera přišla z výroby.
Obojí chce dvě kliknutí a pozastaví kameru na pár sekund. Každý zápis si nejdřív schová kopii
toho, co v kameře bylo (na robotu v `~/.vitulus/camera/calib/`).

## Karta Kamera

Model, sériové číslo, firmware, USB a snímková frekvence hloubky a barvy. Zelená = běží,
modrá = pozastavená kvůli kalibraci, červená = bez obrazu.

## Snímač

Živá nastavení kamery: **IR projektor** (vzor, který pomáhá hloubce na hladkých plochách),
**Výkon laseru**, **Auto expozice hloubky**, **Auto expozice barvy**, **Auto vyvážení bílé**.
Změna platí hned a robot si ji pamatuje — nastaví se znovu při každém startu kamery. **•** značí
nastavení změněné proti výchozímu; **Výchozí** vrátí všechno zpět.

## Detekce překážek

Hloubkový obraz kamery se rozdělí na tři skupiny bodů: **volno** (zem), **překážky** a **zbytek**
(ani jedno, ani druhé). Karta **Detekce překážek** určuje jak, a to za běhu robota: změna platí od
dalšího snímku kamery, bez restartu a bez výpadku, a robot si ji pamatuje (na robotu v
`~/.vitulus/depth_obstacles/settings.json`, přežije restart).

- **Navigace / Mapování** — dvě nezávislé sady. **Navigace** je to, co robot vidí za jízdy.
  **Mapování** se používá jen při nahrávání mapy a patří do [profilu mapování](mapping.md#profil-mapování)
  tohoto místa: změna zůstane u tohoto místa, řádky se porovnávají s profilem a šipka i **Zpět na
  profil mapování** se k němu vrací. Patří k němu i **Překážky do mapy** a **Volná zem do mapy**.
- **Ukázat dosah na mapě** zapne vrstvu v pohledu vybrané sady.
- Výšku, dosah a shluky do mapy rozhoduje jen tahle karta: mapování vezme, co karta pustí, a nic už
  znovu nefiltruje.
- Posuvník nebo číslo, vedle jednotka. U každého řádku je *výchozí* nebo *změněno · výchozí …*;
  šipka vrátí tu jednu hodnotu, **Výchozí pro tento profil** (dvě kliknutí) všechny.
- **Body volno / překážky / zbytek** a **Čas na snímek** jsou živé, průměr za poslední dvě sekundy
  a za vybraný profil. Čas je proti limitu (50 ms; kamera dává snímek každých 66 ms). Zapni vrstvy
  Překážky, Volno a Zbytek a výsledek uvidíš přímo v obraze.
- Profil, který nikdo nepoužívá, nic nepočítá (Mapování, když se nenahrává): čísla ukazují — a
  změna začne platit, až se rozběhne.

> [!WARNING]
> **Navigace mění to, co robot vidí za jízdy.** Proto robot změnu, po které by oslepl, odmítne
> a řekne proč:
>
> - přísnější meze než Mapování: vždy vidí aspoň 1,5 m dopředu, výšky nejde vypnout, zem nesmí
>   spolknout stěny;
> - po každé změně protáhne novým nastavením **referenční scénu**: rovnou zem a krabici 30 cm
>   vysokou 1,3 m před sebou. Když by krabici neviděl, nebo by zem nebral jako volnou, změnu
>   odmítne a nic se nezmění;
> - odmítne i změnu, po které by oba profily dohromady trvaly na snímek déle, než je limit.
>
> Referenční scéna je jednoduchá. Tenké nebo tmavé věci mohou zmizet, i když projde: po změně
> Navigace se dívej na vrstvy a nejdřív to zkus na místě.

Ovladač kamery uřezává hloubku na 5 m (`clip_distance` v `d435.launch`), dál **Nejvzdálenější
hloubka** nic nepřidá. Přesnost stereo hloubky s dálkou prudce klesá.

Costmapa má vlastní meze: z `/obstacles_cloud` bere 3,5 m a výšku 0,05–0,5 m
(`global_costmap_params.yaml`). Větší **Nejvzdálenější hloubka** nebo **Nejvyšší překážka** v Navigaci
je vidět v obraze, ale do costmapy nedojde.

### Co které nastavení dělá

| Sekce | Nastavení | Co dělá | Navigace | Mapování |
|---|---|---|---|---|
| Vzdálenost | Nejbližší hloubka | body blíž ke kameře se zahodí hned na začátku | 0–0,6 m | 0–2 m |
| Vzdálenost | Nejvzdálenější hloubka | jak daleko kamera vidí; dál = dřívější varování, víc šumu | 1,5–6 m | 0,5–6 m |
| Vzdálenost | Nejbližší vzdálenost | jako *Nejbližší hloubka*, ale vzdušnou čarou od kamery, těsně před dělením | 0–0,6 m | 0–2 m |
| Vzdálenost | Nejvzdálenější vzdálenost | jako *Nejvzdálenější hloubka*, vzdušnou čarou; platí kratší z obou | 1,5–6 m | 0,5–6 m |
| Výška | Nejnižší bod | body níž (díry, odrazy) se zahodí, Zbytek | −1 až −0,05 m nebo vyp. | −1 až 0,3 m nebo vyp. |
| Výška | Výška země | kam až může sahat zem; nad ní začínají překážky | 0,05–0,3 m | 0,02–0,6 m nebo vyp. |
| Výška | Spodek překážek | vyp. = překážky začínají na výšce země; hodnota nad ní ignoruje všechno nižší | 0–0,3 m nebo vyp. | 0–1 m nebo vyp. |
| Výška | Nejvyšší překážka | body nad ní (větve) nejsou překážka, Zbytek | 0,3–1,5 m | 0,2–4 m nebo vyp. |
| Úhly a podlaha | Největší sklon země | plocha nakloněná víc není zem; moc = stěny vypadají jako zem | 10–50° | 5–85° |
| Úhly a podlaha | Zem podle sklonu | zem podle sklonu ploch; vyp. = jen podle výšky (rychlejší, na svahu horší) | zap. / vyp. | zap. / vyp. |
| Úhly a podlaha | Body na sklon | sousední body, které určí sklon; víc = klidnější, pomalejší | 5–50 | 3–100 |
| Úhly a podlaha | Otáčet normály nahoru | 0 = vyp.; nad 0 se plocha pod kamerou mířící dolů otočí nahoru (zašuměná zem v dálce) | 0–0,95 | 0–0,95 |
| Úhly a podlaha | Ploché překážky | plochá věc nad zemí je překážka; rozhoduje jen při vypnuté výšce země | zap. / vyp. | zap. / vyp. |
| Filtrování šumu | Mřížka bodů | body se proředí na jeden v buňce; menší = víc detailů, víc času | 0,02–0,15 m | 0,01–0,3 m nebo vyp. |
| Filtrování šumu | Mřížka dělení | totéž v rámu robota, před dělením na zem a překážky | 0,02–0,15 m | 0,01–0,3 m |
| Filtrování šumu | Mřížka před dělením | vyp. = mřížka výše se přeskočí; pomalejší, málokdy lepší | zap. / vyp. | zap. / vyp. |
| Filtrování šumu | Dosah filtru šumu | bod musí mít sousedy v této vzdálenosti, jinak je to šum | 0,05–0,5 m nebo vyp. | 0,02–1 m nebo vyp. |
| Filtrování šumu | Sousedé filtru šumu | kolik sousedů; víc = méně šumu, tenké věci zmizí | 1–15 | 1–50 |
| Shluky | Dosah shluku | body blíž jsou jeden předmět; větší než mřížka | 0,05–0,5 m | 0,02–1 m |
| Shluky | Nejmenší shluk | menší skupina není překážka, Zbytek; víc = méně falešných překážek, malé věci zmizí | 1–30 | 1–500 |
| Výkon | Každý n-tý pixel | 1, 2, 4, 8 nebo 16; menší = víc detailů, mnohem víc času | stejné | stejné |
| Výkon | Vlákna | vlákna na sklon; výsledek stejný, liší se jen čas | 1–4 | 1–4 |

Mezemi jsou i vztahy: *nejbližší* pod *nejvzdálenější*, zem pod překážkami, dosah shluku nad
mřížkou. Změna, která některý poruší, se odmítne celá, s důvodem pod čísly.

**Typické případy** — *trávník se ukazuje jako překážky*: trochu zvedni **Výšku země** nebo
**Nejmenší shluk**. *Nízké věci se nevidí*: sniž **Výšku země**. *Jednotlivé falešné body*: zvedni
**Sousedy filtru šumu** nebo **Nejmenší shluk**. *Svah se ukazuje jako překážka*: zvedni **Největší
sklon země**.

## Vrstvy v obraze

Překryvy kreslené přes obraz kamery v pravém panelu — Lidar, Překážky, Volno, Hloubka — a jejich
průhlednost; stejná volba jako menu vrstev na obrazu ([Obrazovka](frame.md#kamera)). Překážky, Volno
a Zbytek jsou ze sady vybrané v Detekci překážek: Navigace, nebo Mapování. Nahrávání
kamery je v **Nastavení › Rosbag** ([Nastavení](settings.md#rosbag)).
