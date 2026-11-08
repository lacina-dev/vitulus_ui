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
blokuje, šedá se teď nekontroluje (GPS se kontroluje až při startu; řádek ukáže živý fix).
**Proč nespí?** ukáže jen to, co robota drží vzhůru; otevřené SSH připojení nebo webové UI je
modré, robota drží vzhůru záměrně. Šipka › u řádku vede tam, kde se to řeší.

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

### Deska sekačky přestane odpovídat

Při sekání robot po 3 s bez zpráv z desky sekačky zastaví. Když deska odpoví do 6 s, jede dál. Když ne,
zastaví nůž a zkusí desku obnovit (svítí to tady i v pravém panelu). Dokud deska mlčí, zůstane sekačka bez
proudu: vrátí se, až když deska odpoví. Když se to nepovede nebo mise mezitím skončí, proud zůstane
vypnutý, robot jede domů bez nože a běh čeká na svém místě. Když sekačku při sekání vypneš sám, robot
jede domů, nechá ji vypnutou a dá vědět. Běh sám nenaváže, spustíš ho, až budeš chtít.

**Mlčící desku sekačky restartovat sám** (Poruchy, výchozí je vypnuto, zapíná se pro každého robota zvlášť): když deska mlčí i v doku na nabíječce a nic
neběží, robot si udělá tvrdý restart sám: ohlásí ho 60 s předem se **Zrušit**, na minutu vypne proud
a po startu běh naváže. Udělá to jednou za běh a nejvýš dvakrát za 24 hodin, pak dá vědět a čeká. Když je
někdo připojený a **Ignorovat přihlášení** / **Ignorovat otevřené UI** jsou vypnuté, neodpojuje: dá
vědět a čeká, až odejde. Terminál použitý v posledních 10 minutách ho zastaví i se zapnutým **Ignorovat
přihlášení**. Zrušení platí pro celý běh. Mimo dok proud nikdy nevypne.

### Start, který dnes nepojede

Jedna položka kalendáře běží jednou denně. Když položka dnes už běžela a má dnes ještě pozdější start,
Plán to řekne, ukáže další start a nabídne **Přesto dnes spustit** (totéž jako položku smazat a přidat
znovu). Přesun položky na jiný čas nic nevyžaduje: počítá se jako nový start.

## Kalendář nebo agent

Kdo rozhoduje, kdy sekat: **kalendář** (tvoje sloty, jako dosud), nebo **agent**. Přepneš to v panelu,
nebo agentovi v chatu: „sekej podle sebe" / „přepni na agenta" a „zpět na kalendář". Po aktualizaci je
nastavený kalendář, nic se nemění, dokud nepřepneš.

V režimu agent se agent dívá na počasí (déšť za poslední dny a předpověď), kdy se která zóna naposled
sekala, co poslední běh nedosekal a jak těžké bylo sečení, a robotu řekne *posekej program X mezi
těmito časy* nebo *nesekej do T*, s důvodem a jistotou. Robot radu provede stejně jako **Spustit
další**: platí všechny kontroly **Mohl by teď vyjet?**. **Výjezd z doku povoluješ dál ty:** radu
„sekej" robot provede jen při odemčeném doku (předvolba **Mow**); bez něj ti agent jednou napíše
do chatu „chci sekat X v …, povol dok" a robot počká. Odemčení se spotřebuje až skutečným výjezdem. Bez čerstvé rady zatím rozhoduje kalendář
(jde to vypnout: pak bez agenta nevyjede nic). Dokud rada platí, o slotech kalendáře rozhoduje agent
a později se nedohánějí. V režimu agent robot spí nejdéle do dalšího rána, aby se agent mohl každý den
podívat.

**Tvrdé limity** drží robot, agent je nepřebije: start jen 8:00–20:00 (rozjetý běh pokračuje do
konce povoleného času sekání, výchozí 21:00), ne do 3 h po dešti, ne pod 5 °C, stejná zóna nejdřív
po 2 dnech (dosečení nedokončeného programu to nezdrží). Bez aktuálního počasí (radar i předpověď
staré) režim agent nevyjede. V režimu agent platí vždy, v režimu kalendář jen když je zapneš. Běh spuštěný
ručně ani **Spustit další** neomezují. Každé rozhodnutí — rada přijata, běh spuštěn, čekání a proč,
přeskočeno, odmítnuto limitem — je v **Historii**.

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
