---
id: autonomy
title: Autonomie
group: Robot
order: 65
icon: la-calendar-check-o
summary: Co robot dělá sám a proč a všechna pravidla pro to — automatické sekání, Hold, plán, počasí, baterie, spánek, poruchy.
ui: [autonomy]
related: [programs, waiting, settings]
keywords: [autonomie, autonomy, automatika, hold, pauza, plán, kalendář, počasí, déšť, ignorovat déšť, baterie, spánek, zůstat vzhůru, poruchy, pokusy, historie, zamčené, limity]
---
# Autonomie

**Autonomie** v menu je jedno místo, které říká, co robot dělá sám a proč. Horní karta jednou větou
řekne, co dělá teď a co přijde dál. Pod ní má každá sekce hlavičku s barvou a krátkými štítky;
po rozbalení jsou čísla a ovládání. Co rozbalíš, zůstane rozbalené.

![Horní část Autonomie s očíslovanými značkami](../img/shot-autonomy.webp "1 štítek stavu · 2 co dělá teď, pod tím co dál · 3 Automatické sekání · 4 Pauza (Hold) · 5 mohl by vyjet · 6 proč nespí")

## Dva vypínače

- **Automatické sekání** je hlavní vypínač: spouštění z kalendáře, spánek a navazování. Vypnuté =
  nic se nespustí samo a robot sám neusne ([víc](programs.md#automatika-zapnutá--vypnutá)).
- **Pauza (Hold)** zastaví **jen nové starty**. Běžící mise doběhne; ukončí ji **Stop**
  ([víc](programs.md#pozdržet)).

## Teď

**Mohl by teď vyjet?** ukáže každou podmínku startu: zelená je v pořádku, jantarová čeká, červená
blokuje. **Proč nespí?** ukáže jen to, co robota drží vzhůru. Šipka › u řádku vede tam, kde se to řeší.

## Plán

![Plán s očíslovanými značkami](../img/shot-autonomy-plan.webp "1 dalších 7 dní: povolený čas (modře), starty (značky, čas pod nimi), očekávaný spánek (šedě) · 2 Přeskočit další · 3 Dnes nesekat · 4 Spustit další plánovaný teď")

Tady je kalendář a [povolený čas sekání](programs.md#povolený-čas-sekání). Časová osa ukazuje
7 dní dopředu: starty, povolený čas a očekávaný spánek. **Přeskočit další** přeskočí jeden start,
**Dnes nesekat** vynechá dnešek, **Spustit další plánovaný teď** spustí další program hned (klepni
dvakrát). Přeskočený start je na ose přeškrtnutý a stejné tlačítko to vrátí. Formulář události,
opakování a pravidla dohánění jsou v [Programy a kalendář](programs.md#kalendář).

## Počasí

![Počasí s očíslovanými značkami](../img/shot-autonomy-rain.webp "1 radar teď a dalších 30 minut · 2 co dělá déšť")

Jedna volba rozhoduje, co dělá déšť:

| Volba | Co déšť udělá |
|---|---|
| **Vždy** | zastaví každý start, z kalendáře i ruční |
| **Jen kalendář** | zastaví kalendář; jízda, kterou spustíš sám, pojede |
| **Ignorovat** | nezastaví nic; robot seká i v dešti |

Pod tím: jak dlouho čekat po dešti, jak daleko dopředu platí předpověď, kdy zkusit znovu a jestli
sekající robot při dešti jede domů. Snímky zůstávají v [Mapa › Déšť](waiting.md#počasí-mapa--déšť). Když by déšť odmítl **Run**, dialog nabídne **Tentokrát déšť
ignorovat**: platí jen pro tuhle jízdu.

## Baterie, Spánek, Poruchy

Každé nastavení má popisek, jednu větu a výchozí hodnotu, a **Reset**, když se od ní liší. Změna
platí hned a řádek napíše *Uloženo*. Odmítnutá hodnota řekne proč a zůstane ta stará.

### Spánek

Věta pod **Spánek** je plán: kdy usne, na jak dlouho, kdy se vzbudí, nebo co ho drží vzhůru. Stejná
věta je nahoře na stránce a **Zrušit** je nad mapou, v pravém panelu i nahoře, dokud se spánek
odpočítává. Podle časování robota se napájení vypne 3 minuty po začátku a robot se vzbudí v uvedený
čas; doba *vypnuto* je o ty 3 minuty kratší, než kolik zadáš.

- **Usínat samočinně** je spánek, o kterém rozhoduje robot. **Uspat teď** funguje vždy.
- **Ignorovat přihlášení** a **Ignorovat otevřené UI**: vypnuté znamená, že terminál nebo otevřená
  stránka drží robota vzhůru. Zapnuté znamená, že usne i s tebou připojeným, vypne napájení a stránka
  i každý terminál ho ztratí, dokud se nevzbudí. Zapnutí může spánek spustit hned, proto nejdřív řekne
  délku a čas probuzení a zeptá se.
- **Zrušit** odloží samočinný spánek o 30 minut a řekne do kdy, potom přijde odpočet znovu. Na déle
  použij **Zůstat vzhůru** (N hodin).
- **Uspat teď**: pole bere to, co robot přijme, dnes od 16 minut (mez 15 a rezerva hodin), a řádek pod
  ním řekne, co se stane. Start uvnitř spánku je volba: vstát na něj (spánek se zkrátí), nebo ho
  přeskočit. Přihlášený terminál Uspat teď odmítne, pokud není zapnuté Ignorovat přihlášení. Když se
  spánek odpočítává, nejdřív ho zruš. S otevřenou stránkou nejdřív běží 60 s odpočet. Když se to potom
  nepovede, stránka to řekne.

Některé limity zatím nejsou nastavení. **Pokročilé** je ukazuje s hodnotami: nejkratší spánek, čekání
před vypnutím napájení, nejdelší kus spánku, odpočet a dobu, na kterou Zrušit odloží spánek.

### Tvrdý restart

**Tvrdý restart: vypnout vše na N s** (i v Nastavení › Napájení) není spánek. Napájení počítače, motorů
a sečky se na N sekund vypne, výchozí je 60, zůstane jen napájecí modul. Jde to v doku na nabíječce,
když nic neběží. Řekne, co se stane, a zeptá se, napájení pak jde pryč za 20 s a do té doby je **Zrušit**.
Je to tvrdé odpojení bez čistého vypnutí a vypne se i tahle stránka a Claude sessions; robot je zpět asi
za 2 minuty. Plánovač o tom neví. Stránka, která restart spustila, se znovu připojí, řekne, jak to
dopadlo, a vrátí časy napájecího modulu.

### Start, který dnes nepojede

Jedna položka kalendáře běží jednou denně. Když položka dnes už běžela a má dnes ještě pozdější start,
Plán to řekne, ukáže další start a nabídne **Přesto dnes spustit** (totéž jako položku smazat a přidat
znovu). Přesun položky na jiný čas nic nevyžaduje: počítá se jako nový start.

## Pokročilé

Málo potřebné časování a **zamčené limity**, které robot hlásí: limity firmwaru a bezpečnosti, třeba
teplota, náklon, STOP a pravidla nože. Jsou vidět se zámkem a důvodem a změnit tu nejdou. Žádné
nastavení tady bezpečnostní limit nepovolí.

## Historie

Deník říká lidsky, co se stalo: vyjel, dokončil, přeskočil, zmeškal, čekal, usnul, probudil se,
změna nastavení. Jde filtrovat podle jízd, čekání, spánku a nastavení. Problémy zůstanou nahoře,
dokud je nesmažeš (**Smazat**).

## Řádek nad mapou

Jeden řádek říká, co robot dělá a co přijde: spánek předem („Za 5 min se uspím na 11 h 55 min"), když
je to známé, odpočet se **Zrušit**, *Spánek zrušen*, *Vyjíždím: Bigger*, *Čekám na RTK*, *Sekání
dokončeno*. STOP a chyby jdou první a drží se, dokud neskončí. Běžné hlášky robota čekají ve frontě,
každá zůstane aspoň 2,5 sekundy a všechny zůstávají v **Logu**. Na telefonu je řádek kratší, celá věta
je v panelu.

## Mimo panel

Řádek **Auto** v pravém panelu ukáže další start, nebo stav, když robot čeká nebo někoho potřebuje;
po rozbalení je další start, baterie a déšť, šipka › vede sem. Když je vše v pořádku, je tichý. Když
je potřeba člověk, zežloutne nebo zčervená a horní karta řekne co; na telefonu se objeví tečka
ve sbaleném řádku.
