---
id: agent
title: Agent Vitulus
group: Robot
order: 80
icon: la-comments-o
summary: Zadej robotovi úkol normální řečí, sleduj jeho mise, schválení, nálezy a zámek doku.
ui: [agent, agent/chat#zadat-úkol, agent/work#práce-schválení-a-úlohy, agent/activity#aktivita, agent/findings#nálezy, agent/robot#robot-a-zámek-doku, agent/models#modely, needs#čeká-na-tebe]
related: [safety, dock, support]
keywords: [model světa, world model, co agent vidí, what the agent sees, analýza mapy, map analysis, překážka, obstacle, objížďka, detour, dosažitelný, reachable, kde jsi, co je kolem, cesta k, dojedeš, nástroje, tools, vlastní nástroje, own tools, učení, learn, learned, příručka, playbook, zkušenost, experience, naučil, co ses naučil, jak bys to řešil, strategie, strategy, agent, chat, mise, mission, úkol, úloha, task, zkušební jízda, test drive, volná jízda, free drive, do návratu do doku, until docked, pokračuj, continue, zruš, cancel, schválit, approve, zamítnout, deny, nálezy, findings, čeká na tebe, needs you, zvonek, bell, zámek doku, dock lock, odemknout, unlock, supervisor, fault, stop zajištěný, stop latched, restart, reconnect, ros master]
---
# Agent Vitulus

Agent je pomocník na robotu. Čte stav robota, odpovídá na otázky, hlídá problémy a — v přísných
mezích — za tebe s robotem jezdí. Otevři **Agent** v pásu menu. Piš mu česky nebo anglicky;
odpovídá většinou česky.

Záložky: **Chat** · **Práce** · **Aktivita** · **Nálezy** · **Robot** · **Modely**.

![Panel Agent s očíslovanými značkami](../img/shot-agent.webp "1 čipy stavu robota · 2 STOP agenta · 3 záložky · 4 napiš úkol nebo otázku · 5 rychlé příkazy")

## Zadat úkol

Napiš do **Chatu** normální řečí, co chceš. Jednoduchá jízda se hned stane **misí**, třeba:

```
udělej undock, dojeď na TEST, počkej 10 s a vrať se do doku
```

Mise je očíslovaná úloha (**#N**) z kroků: *vyjet z doku*, *dojet na pojmenovaný bod*, *počkat*
(nejvýš 10 min), *zajet do doku*. Plán se zkontroluje dřív, než se cokoli pohne (body musí být na
aktivní mapě), a agent se pak ozve po každém kroku. Cokoli složitějšího (fotky, mapy, trasy,
podmínky) jde nejdřív do jeho plánovače. **Sekačka a nůž nikdy nejsou součástí mise.**

```flow
Napíšeš | „dojeď na TEST a zpátky"
Plán + kontrola | body existují, akce jsou povolené
warn: Zámek doku | pohyb povolí majitel
Běh | krok za krokem, po každém hlášení
ok: Hlášení | hotovo, nebo proč ne
```

### Pokračovat a zrušit

| Napíšeš | Co se stane |
|---|---|
| `pokračuj` (nebo *jeď dál*, *dokonči to*, *odblokuj*…) | naváže nejnovější zaparkovanou misi; nejnovější zrušenou / selhanou (do 2 h) pustí znovu od kroku, kde skončila |
| `pokračuj na 223` / `pokračuj misi #223` | naváže misi #223; `pokračuj na 223: …` k ní přidá informace |
| `zruš misi #223` (nebo *zrušit job 223*, *stop mise 223*) | zruší #223 hned — běžící krok skončí, robot zastaví, další krok nezačne |
| `zruš to` | zruší právě běžící úlohu |

Pokračovat a rušit jde jen těmito pevnými slovy — nikdy podle odhadu modelu. Karta mise má totéž
jako tlačítka (**Pokračovat**, **Zrušit**) a **Navázat** předvyplní `pokračuj na N: `.

## Práce (schválení a úlohy)

**Práce** má nahoře připnutá **schválení**, pod nimi *Čeká na tebe* (zaparkované úlohy), úlohy a
kartu *Mise / jízda*. Když agent chce udělat něco, k čemu je potřeba člověk, zeptá se:
**Schválit** / **Zamítnout**. Kdyby se robot pohnul, karta píše
*ROBOT BY SE POHNUL — povolit to smíš jen ty* a tlačítko potřebuje druhé klepnutí.

## Robot a zámek doku

**Robot** ukazuje živý stav, nástroje robota a kartu **Zámek doku**.

### Zámek doku

Agent **sám s robotem z doku nevyjede** — každá akce s pohybem (vyjet z doku, zajet do doku,
dojet na bod, projet trasu) potřebuje kliknutí majitele tady. Zastavit jde vždycky.

1. Vyber předvolbu a přečti si její rozsah: *Akce*, *Nepovoleno*, *Platí*, *Použití*,
   *Podepsal*.
   - **Volná jízda — cokoli, dokud se robot nevrátí do doku** (nahoře) — povolí každý pohyb
     (ne sekačku) bez omezení počtu použití. Zamkne se sama, jakmile je robot zpátky v doku
     (nebo nejpozději po 12 h). Když ji odemkneš, zatímco robot stojí v doku, počká, až robot
     vyjede a vrátí se. Karta píše *Odemčeno do návratu do doku*.
   - **Zkušební jízda** — vyjet z doku, jet k bodům, zajet zpět (a zapnout motory, je-li
     potřeba); 30 min, nejvýš 8 pohybů; žádné uložené trasy, žádná sekačka.
   - **Jen výjezd z doku, jednou** — 15 min, 1 použití.
   - **Vyjet z doku a zajet zpět** — 30 min, 2 použití.
2. **Odemknout — klepni znovu pro potvrzení**, pak do 6 s **Ano — odemknout dok**.
3. Dokud je otevřeno, karta ukazuje *ODEMČENO*, *Zbývá použití*, *Vyprší za* a **Znovu
   zamknout** — to každé odemčení hned vezme zpět.

Mise, která zámek potřebuje, se sama zaparkuje; její zpráva v chatu má **Otevřít zámek doku**.
Po odemčení mise pokračuje sama (po 2 h čekání ji znovu rozjede jen `pokračuj`). Zámek platí jen
pro agenta, ne pro tvoje tlačítka a joystick.

## STOP agenta

Červený **STOP** v hlavičce panelu agenta (dvě klepnutí) zastaví, co agent spustil — supervisor
robot zastaví zhruba do 1,5 s. **Zůstane zajištěný**: agent odmítá všechny akce a pruh hlásí
*STOP JE ZAJIŠTĚNÝ*, dokud nenapíšeš `/stop pokracuj`. Není to STOP robota — to je červený STOP
vlevo dole ([Bezpečnost](safety.md#stop)).

### FAULT supervisoru

Když mise jede, hlídá ji samostatný supervisor. Přejde do **FAULT** a drží robota zastaveného,
když robot opustí povolenou oblast, ztratí polohu, agent přestane odpovídat, vyprší čas, roztočí
se nůž nebo **převezme řízení člověk** (joystick, gamepad). Sám se uvolní nejdřív po 10 s, až
robot stojí a motory i nůž jsou vypnuté — po uvolnění se nic nerozjede. Zaparkovaná mise pak
pokračuje sama (nejvýš dvakrát za misi, a jen když se supervisor uvolní do 30 min); po převzetí,
kvůli noži nebo hranici polohy čeká na `pokračuj`.

Stop ze supervisoru vypne nůž přímo; stop sekačky pošle jen tehdy, když běží program sekání, takže
FAULT během zkušební jízdy nikdy nezruší zajetí do doku, které po něm následuje.

### Restart robota během mise

Když se software robota restartuje (dělá to podpůrný kit po aktualizaci), agent běží dál a sám se
k restartovanému robotu za pár sekund znovu připojí — mise robota zase vidí a pokračuje.
Zaparkovaná mise naváže, jakmile je supervisor READY, a to podle toho, co robot doopravdy dělá
(výjezd z doku, který už proběhl, se neopakuje). Když se kvůli tomu musel restartovat i agent
sám, mise taky pokračuje sama; po jakémkoli jiném restartu agenta (tvém, po pádu) čeká na
`pokračuj`.

## Aktivita

Jedna časová osa toho, co agent a podpůrný kit udělali — hlášení, rozhodnutí, nasazení — s
filtry. Rozhodnutí z UI jsou podepsaná tvým jménem a objeví se tady.

## Nálezy

Co si agent všiml v logech a ve zdraví robota. Každý nález sám roztřídí: skutečný problém
(podívá se hlouběji a opraví ho, smí-li), očekávané, šum (oboje se zavře), nebo nejisté (zeptá se
tě jednou otázkou). Na kartě: **Vzít na vědomí**, **Prošetřit** (vrátí verdikt: opravit hned /
později / sledovat / ignorovat), **Vyřešit**, **Zrušit ignorování** a u plánu opravy
**Schválit plán** / **Zamítnout**.

Sám opravuje jen vlastní kód agenta, nikdy jízdu, sekání ani bezpečnost (ty jen navrhne), a nikdy,
když běží mise. Dostaneš krátkou zprávu *Problém · Zdůvodnění · Řešení · Ověření* s volbami
*Vrátit zpět* a *Příště ignorovat*.

## Co se agent naučí

Každou misi si agent uloží jako **epizodu**: úkol, mapu, bod, denní dobu a světlo, déšť, RTK,
baterii, zátěž CPU a verzi kódu, každý krok, který selhal (s třídou selhání a původním důvodem),
co zkusil potom a jestli to pomohlo, jak dlouho který krok trval a jak to skončilo. Z toho
počítá — jednoduše a přehledně, žádná černá skříňka:

- **které zotavení pomáhá** na které selhání, jako vyhlazenou úspěšnost i s počty, ze kterých
  vychází (*přes bod X pomohlo tady 3/3, u téhle akce 4/5*); zotavení, které třikrát nepomohlo,
  dostane značku *neopakovat*;
- **jak dlouho kroky doopravdy trvají** (*výjezd z doku po mapě: medián 150 s, max 170 s — limit
  kroku nech aspoň 255 s*);
- **poučení** ze svého zpětného rozboru — všechna, i ta, která se mu už nevejdou do krátké
  paměti.

Kromě jednotlivých zotavení si drží celé **strategie**: které nástroje a kroky vyřešily určitý
druh situace, který z nich rozhodl, které byly k ničemu, jak dlouho to trvalo a kolik to stálo
(volání modelu, CPU). Vybavuje si je podle toho, jak **podobná** je situace — lokalizace, GPS,
překážka, světlo, terén; místo je jen jeden z rysů — takže cesta, která zabrala na jedné mapě, se
zkusí i na jiné, a strategie, která opakovaně selhává, přestane mít přednost. Napiš
`jak bys to řešil` (klidně i s problémem, třeba *…když je ztracená lokalizace*) a uvidíš, co by
udělal a proč.

Výsledkem je **příručka** agenta (playbook): čte ji plánovač i ten, kdo o misi rozhoduje, a
můžeš i ty — napiš do **Chatu** `co ses naučil` nebo `/naucil` (celá příručka je v souboru
`~/.vitulus/agent/playbook.md`).

Když se stejné selhání pořád vrací a nic, co agent zná, nepomáhá, založí si na něj sám **nález**
(**Nálezy**) a dál jde obvyklá cesta: rozbor a oprava přes testy — nikdy, když běží mise.

## Co agent vidí

Než cokoli rozhodne, poskládá agent jeden **model světa** ze všech senzorů a dat robota: lidar a
detektor pohyblivých objektů, mračna překážek a země i hloubku z kamery, IMU, GNSS (RTK fix,
kurz, satelity, přesnost), odometrii z kol, vizuální a lidarovou, kvalitu lokalizace, dok
(kontakty, odrazky, poloha), motory, baterii, déšť, sekačku, supervisor a to, kdo řídí. Každá
hodnota nese své stáří a míru důvěry a zdroje se **navzájem kontrolují**: kola se točí, ale
kamera ani lidar nevidí pohyb = prokluz nebo uvíznutí; bez RTK, ale lidar pořád sedí na mapu =
*věř lidaru*; překážka, kterou vidí lidar i kamera, je jistá. Co agent neví, uvede jako *nejisté*
— nehádá.

Na mapě najde robota (mapa i UTM, nejbližší body, zóna), překážky kolem něj (**nové**, které
v uložené mapě nejsou, oproti známým zdem, pohyblivé objekty), volné směry, jestli je robot
zablokovaný ze všech stran a jestli se dá k bodu dojet — cestu si naplánuje sám na costmapě
(robotu se nic neposílá), najde nejužší místo a když je cesta zablokovaná, **objížďku** přes jiný
bod. Zeptej se v **Chatu** *kde jsi?*, *co je kolem?*, *dojedeš k TEST?* nebo *ukaž mapu
k TEST* — odpověď přijde s obrázkem mapy, kde je robot, překážky a naplánovaná trasa.

Když na to, co potřebuje, žádný nástroj neodpoví, **postaví si agent vlastní nástroj jen pro
čtení** (kód + test) a ten musí projít branou: testy v izolaci, žádný pohyb, žádný zápis mimo
jeho vlastní data. Schválený nástroj se objeví mezi ostatními a v podobných situacích se nabídne
znovu; nástroje, které by robotem pohnuly, se nikdy nestaví — jen se ti navrhnou.

## Modely

Který AI model co pro agenta dělá (chat, plánování, rozbor) — jen pro informaci.

## Čeká na tebe

**Zvonek** v navbaru je tichý, když nic nečeká, oranžový s počtem, když něco čeká, a červený,
když je to naléhavé nebo by se robot pohnul. Otevře jeden seznam všeho, co čeká na člověka:

- **Agent robota** — schválení a zaparkované úlohy; rozhoduješ je v **Agent › Práce**.
- **Podpora** — na co čeká podpůrný kit. Ty jde rozhodnout přímo v seznamu: **Hotovo**, volba
  z karty, **Skrýt na 24 h**, **Připomenout**, **Přijmout / Zamítnout** nález. Dvě kliknutí do
  5 s; každé rozhodnutí je podepsané tvým jménem. Volba, která by pohnula robotem, se tady nikdy
  nenabízí.
