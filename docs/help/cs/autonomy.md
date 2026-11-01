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

**Spánek** má navíc **Zůstat vzhůru** (na N hodin) a **Uspat teď** (na čas nebo do nabití, klepni
dvakrát). Uspat teď jde jen v doku, když nic neběží. Když je připojený někdo další, nahoře se
objeví odpočet 60 s se **Zrušit**.

## Pokročilé

Málo potřebné časování a **zamčené limity**, které robot hlásí: limity firmwaru a bezpečnosti, třeba
teplota, náklon, STOP a pravidla nože. Jsou vidět se zámkem a důvodem a změnit tu nejdou. Žádné
nastavení tady bezpečnostní limit nepovolí.

## Historie

Deník říká lidsky, co se stalo: vyjel, dokončil, přeskočil, zmeškal, čekal, usnul, probudil se,
změna nastavení. Jde filtrovat podle jízd, čekání, spánku a nastavení. Problémy zůstanou nahoře,
dokud je nesmažeš (**Smazat**).

## Mimo panel

Řádek **Auto** v pravém panelu ukáže další start, nebo stav, když robot čeká nebo někoho potřebuje;
po rozbalení je další start, baterie a déšť, šipka › vede sem. Když je vše v pořádku, je tichý. Když
je potřeba člověk, zežloutne nebo zčervená a horní karta řekne co; na telefonu se objeví tečka
ve sbaleném řádku.
