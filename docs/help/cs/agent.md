---
id: agent
title: Agent Vitulus
group: Robot
order: 80
icon: la-comments-o
summary: Zadej robotovi úkol normální řečí, sleduj jeho mise, schválení, nálezy a zámek doku.
ui: [agent, agent/chat#zadat-úkol, agent/work#práce-schválení-a-úlohy, agent/activity#aktivita, agent/findings#nálezy, agent/robot#robot-a-zámek-doku, agent/models#modely, needs#čeká-na-tebe]
related: [safety, dock, support]
keywords: [stop odvolávám, zruš stop, zrušit stop, zastav, plán agenta, plan agenta, plán na mapě, skica, souřadnice, nejvzdálenější bod, kolem zóny, objeď zónu, operator, operátor, skill, skilly, pípni, beep, zobraz zónu, show zone, počkej na signál, wait for signal, model světa, world model, co agent vidí, what the agent sees, analýza mapy, map analysis, překážka, obstacle, objížďka, detour, dosažitelný, reachable, kde jsi, co je kolem, cesta k, dojedeš, nástroje, tools, vlastní nástroje, own tools, učení, learn, learned, příručka, playbook, zkušenost, experience, naučil, co ses naučil, jak bys to řešil, strategie, strategy, akce, actions, přímé řízení, direct driving, jeď rovně, otoč se, couvni, back up, bod na mapě, goto xy, program sekání, mowing program, posekej, mow, nůž, blade, cmd_vel mux, agent, chat, mise, mission, úkol, úloha, task, zkušební jízda, test drive, volná jízda, free drive, do návratu do doku, until docked, pokračuj, continue, zruš, cancel, schválit, approve, zamítnout, deny, nálezy, findings, čeká na tebe, needs you, zvonek, bell, zámek doku, dock lock, odemknout, unlock, supervisor, fault, stop zajištěný, stop latched, restart, reconnect, ros master, zotavení, recovery, opakování, retry, alternativa, návrat do doku, return to dock, čekání na rtk, rtk wait, nenašel cestu, no path, blokovaná cesta, blocked, displej, display, lcd, nová schopnost, new capability]
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

Mise je očíslovaná úloha (**#N**) z kroků: *vyjet z doku*, *dojet na pojmenovaný bod*, *projet
uloženou trasu* (*po trase ZonaA*, *projeď trasu ZONA_A_Path* — mezery, podtržítka ani koncovka
*_Path* nevadí), *počkat* (*počkej 10 s*, *minutu počkej*, *půl minuty*, nejvýš 10 min), *zajet
do doku*. Plán se zkontroluje dřív, než se cokoli pohne (body a trasy musí být na aktivní mapě).
Chat odpoví **jednou krátkou zprávou** — číslo a plán, např. *Mise #240: 1) vyjet z doku
2) trasa ZONA_A_Path 3) počkat 60 s 4) do doku. Jedu.* — pak jedna věta po každém kroku, a když
stojí, *proč* a co udělat. Cokoli složitějšího (fotky, mapy, podmínky, opakování) jde nejdřív do
jeho plánovače.

Plán obsahuje **jen to, co jsi chtěl**: kroky, které se jen dívají (*změřit stav*, *počkat na
RTK*, *kde jsem*, *shrnutí*…), se vyřadí, pokud o ně zadání nežádá (*zjisti polohu*, *vyfoť*,
*řekni mi*…). RTK, motory a stav robota si agent za jízdy hlídá sám. **Nůž agent nikdy sám nezapne** — mise smí jen spustit
uložený program sekání po tvém odemčení ([Programy sekání](#programy-sekání)).

Návrat rozumí běžným slovům — *zadokuj*, *zadockuj*, *dokuj*, *zaparkuj se do doku*, *vrať se
(do doku / domů)*, *a zpátky* — a ohlášený plán vždycky vypíše všechny kroky včetně zadokování.
Každý plán (jednoduchý i z plánovače) se porovná s tím, co jsi napsal: body ve tvém pořadí, návrat
do doku, čekání, sekání. Plán, který krok vynechá, se naplánuje znovu; když ani to, mise se
nespustí a chat řekne, co nesedí. Slovo, kterému jednoduchá cesta nerozumí, pošle úkol plánovači —
nezahodí se.

```flow
Napíšeš | „dojeď na TEST a zpátky"
Plán + kontrola | body existují, akce jsou povolené
warn: Zámek doku | pohyb povolí majitel
Běh | krok za krokem, po každém hlášení
ok: Hlášení | hotovo, nebo proč ne
```

Nad konverzací filtrují pilulky **Vše / Chat / Hlášení / Úlohy**, co vidíš; ikona lidí na konci
řádku přepíná mezi celou konverzací ze všech zařízení (dva lidé) a jen tímhle prohlížečem (jeden
člověk).

### Pokračovat a zrušit

| Napíšeš | Co se stane |
|---|---|
| `pokračuj` (nebo *jeď dál*, *dokonči to*, *odblokuj*…) | naváže nejnovější zaparkovanou misi; nejnovější zrušenou / selhanou (do 2 h) pustí znovu od kroku, kde skončila |
| `pokračuj v úkolu zóna A` / `pokračuj v misi …` | naváže zastavenou misi, jejíž zadání slova obsahuje (*zóna A* ↔ *ZonaA*, *ZONA_A_Path*); sedí-li dvě, zeptá se kterou |
| `pokračuj na 223` / `pokračuj misi #223` | naváže misi #223; `pokračuj na 223: …` k ní přidá informace |
| `proveď plán z práce #223` / `spusť misi #223` | tatáž mise #223: stojí-li, naváže; běží-li, řekne krok; doběhla-li, řekne *hotovo* |
| `znovu #223` / `zopakuj #223` | doběhlou misi #223 pustí znovu od prvního kroku — tatáž mise, žádná nová |
| `zruš misi #223` (nebo *zrušit job 223*, *stop mise 223*) | zruší #223 hned — běžící krok skončí, robot zastaví, další krok nezačne |
| `zruš to` | zruší právě běžící úlohu |

Pokračovat a rušit jde jen těmito pevnými slovy — nikdy podle odhadu modelu, a **pokračování
nikdy nezaloží novou misi**: když nic nestojí, chat to řekne a jmenuje poslední misi. Mise
zastavená převzetím pokračuje na `pokračuj` od kroku, kde stála (vyjetí se přeskočí, když je
robot už venku); není-li supervisor ještě READY, rozjede se sama, jakmile bude. Hlášení mise,
která čeká na tebe, má jedno tlačítko **Pokračovat** (pošle `pokračuj #N`); karta mise má
**Pokračovat** a **Zrušit**.

### Během mise: zrušit, vstoupit, zeptat se

Když mise běží (nebo čeká), **každá zpráva z chatu patří do ní** — žádná vedle ní nespouští
vlastní akci.

| Napíšeš | Co se stane |
|---|---|
| `zruš to`, `přestaň`, `konec`, `nech toho`, `zruš misi` | zruší misi hned: běžící krok dostane brzdu (*dock.stop*, zrušení trasy / cíle, zastavení přímé jízdy nebo programu sekání) a supervisor robota zastaví |
| `zastav`, `stop`, `stůj` | totéž — **zastaví tuhle misi** (brzda + zrušení) a řekne to jednou větou; agent se **nezamkne**, další pokyn (*vrať se do doku*) udělá hned a *pokračuj* na zastavenou misi naváže |
| `zruš to a vrať se do doku`, `jeď domů`, `jeď rovnou do doku` | zabrzdí krok, zbytek plánu zahodí a zadokuje; mise skončí jako zrušená s robotem v doku |
| `zruš sekání a jeď na TEST` | zruší misi a zbytek věty vezme jako nové zadání |
| cokoli jiného (*najeď na bod UNDOCK a počkej tam na GPS, pak pokračuj*, *čekáš na špatném místě*, *přeskoč čekání*, *co děláš?*) | přečte to model s kontextem mise (zadání, hotové kroky, na co teď čeká, živý stav, akce, které smí použít) a buď odpoví, nebo krok zabrzdí a **vloží kroky před zbytek plánu** — pak mise pokračuje |

Zrušení a *domů* jsou pevná slova a fungují, i když žádný model neodpovídá. Vložené kroky se
kontrolují stejně jako plán (registr, jména waypointů, žádný nůž); když model neodpoví nebo jeho
kroky kontrolou neprojdou, mise jede dál beze změny a chat to řekne. Když krok dlouho čeká uvnitř
robota (po vyjetí čeká dock_smach na RTK u bodu *UNDOCK*), mise po zhruba minutě jednou řekne, na
co čeká, a pak nejvýš každé 3 minuty. Mimo misi je zpráva, která robotovi říká, ať se hýbe
(*jeď*, *dojeď*, *vrať se*, *otoč se*, *posekej*…), vždycky mise — *dojeď do zóny A* projede
trasu té zóny (*ZONA_A_Path*) — nikdy jen odpověď.

### Operátor: model řídí krok po kroku

Zadání, které není čistá rutinní jízda (*vyjet / bod / trasa / počkat / do doku*) — a každý
pokyn typu *pípni 2×*, *zobraz zónu A*, *počkej tam na signál* — vede **operátor**: model
(Sonnet, záložně Haiku), který přečte, co jsi napsal, vybere si **skilly** robota — všechno, co
umí UI a registr akcí agenta — a provádí je **krok po kroku, jako bys to dělal ty v UI**: *jeď na
bod*, *projeď trasu*, *spusť program*, *zobraz zónu na mapě*, *otoč se*, *couvni*, *vyfoť*,
*počkej*, *počkej na RTK*, *počkej na můj signál*, *pípni*, *napiš na displej*. Každý výsledek
ověří, než řekne *hotovo*.

```
jeď po trase ZONA_A_Path, pak počkej na RTK fix a vyfoť to
zobraz zónu A
otoč se 3× doprava a jednou doleva, pak 2× pípni
dej go na bod TEST a počkej tam na signál
```

- **Stejné brány jako každá mise.** Každý krok jde přes registr akcí, podepsaný seznam povolených
  akcí, zámek doku (výjezd potřebuje tvoje odemčení, návrat domů nikdy), supervisor a aktuační
  token. Nůž se točí jen v uloženém programu po tvém odemčení **Mow**. Když krok neprojde, operátor
  jednou větou řekne proč a co můžeš udělat. Skilly, které UI má, ale ještě jsi je nepodepsal, jsou
  vedené jako *čeká na podpis*.
- **Vstoupit můžeš kdykoli.** Každá zpráva během mise jde do **téhož rozhovoru** s modelem: uvidí
  ji ve výsledku aktuálního kroku (jízda dojede, čekání se přeruší hned) a změní postup. *Počkej
  tam na signál* ho nechá stát a čekat — tvoje další zpráva (*jeď*, *hotovo*) je signál. Stejně
  odpovídáš na jeho otázky.
- **Zrušení a návrat domů zůstávají pevná slova** (*zruš to*, *jeď domů*) — vyřeší je jádro bez
  modelu, viz tabulka výše.
- **Říká, co dělá.** Nejdřív očíslovaný plán, pak každý krok, který hýbe robotem, dostane
  jednu větu na začátku (*Krok 2: jedu po trase ZONA_B_Path.*) a jednu na konci (*Trasa
  ZONA_B_Path hotová (70 s).*, nebo co se nepovedlo a proč) — ty věty píše jádro, takže jsou tam,
  i když model mlčí. Před rozhodnutím operátor jednou větou řekne proč (*uložená trasa u zóny B jen
  končí, objedu ji po rozích*) a na konci krátce shrne. Otázka, kterou ti položí, svítí v **Čeká na
  tebe**.
- **Zámek doku bez psaní.** Když krok potřebuje odemčený výjezd, jádro pošle obvyklé hlášení
  *čeká na tvoje odemčení* se správnou předvolbou (*Jen výjezd z doku* pro výjezd, *Sekání* pro
  program) a pod ním tlačítko **Otevřít zámek doku**; mise svítí v **Čeká na tebe**. Jakmile
  odemkneš, chat napíše *Dok je odemčený (ui#N) — vyjíždím z doku.* a tentýž krok se rozjede sám.
- **Zná tvar tvých zón.** Operátor čte zóny, trasy a body z mapy místa (obrys, střed, rozměry,
  nejvzdálenější roh od robota nebo doku, bod kousek uvnitř zóny, okruh kolem ní, které uložené
  trasy vedou podél jejího okraje) a obrázek mapy si umí sám prohlédnout. *Jeď do nejvzdálenější
  části zóny B* nebo *objeď zónu B* proto funguje, i když kolem té zóny žádná uložená trasa nevede.
- **Zobrazení na mapě.** *Zobraz zónu A* / *ukaž bod TEST* / *ukaž trasu …* nakreslí zónu, bod
  nebo trasu na tvoji živou mapu, stejně jako tlačítka **Ukázat**.
- **Rozpočet a bezpečnost.** Nejvýš ~40 volání nástrojů a 15 tahů modelu na misi (a denní strop —
  model jede na předplatném, které sdílíte). Když model neodpoví, selže nebo mu dojde rozpočet,
  robot **stojí**; je-li venku a do 5 minut nenapíšeš, vrátí se do doku. Otázka bez odpovědi do
  15 minut (venku) ho taky pošle domů. Člověk u ovládání vždy vyhrává. Dokud platí **STOP**,
  operátor nikam nejede, ani domů: čeká dál na tvoji odpověď, a když nepřijde, jednou řekne, že
  platí STOP a jak ho zrušit (*stop odvolávám*). *Pokračuj #N* naváže na misi operátora v tomtéž
  rozhovoru — i na takovou, která se zastavila nebo skončila.
- Každý krok se zapisuje (*~/.vitulus/agent/operator/*); karta mise ukazuje kroky, latenci modelu
  a spotřebovaná volání.

### Plán agenta na mapě

Když operátor plánuje jízdu na místo, které není uložený bod ani trasa — *nejvzdálenější část
zóny B*, *kolem zóny A*, *2 m za dok* — souřadnice nehádá. **Podívá se na mapu** (obrázek
s metrovou mřížkou a čísly os, zónami, body, trasami, robotem a dokem), **nakreslí do ní plán**
(body, trasy, plochy, šipky s krátkými popisky jako *b1 cíl*), **ověří každý bod** (volno, nebo
překážka, v jaké zóně, jestli je dosažitelný od robota, jak dlouhá je cesta — bod v překážce
nahradí nejbližším volným) a obrázek ti ukáže v **Chatu**.

Při spuštění se tentýž plán objeví na **tvé živé mapě** jako vrstva **Plán agenta**
(Mapa › Vrstvy, jantarový ◆; varování červeně, pomocné čáry modře). Karta v levém dolním rohu
mapy říká, ke které misi patří: **Ukázat** posune mapu na plán, **Smazat** ho odebere z tvého
zobrazení (agent svůj plán má dál). Čerstvý plán jednou za misi vytáhne mapu dopředu (velký obraz
kamery ustoupí). Když mise skončí, plán zmizí sám.

## Když krok selže

Agent to po prvním nezdaru nevzdá. **Změří, co se pokazilo**, a sám zkusí vhodnou jinou cestu;
ty dostaneš jen krátké hlášení.

```flow
Krok selže | třeba nenašel cestu na TEST
Změřit | hlášky doku, kódy navigace, GPS, supervisor
Vybrat | nejlepší ještě nezkoušenou možnost
Zkusit | a pak krok znovu
warn: Nic nezbývá | robot venku → zpátky do doku
bad: Ani to ne | stop, motory vypnout, ptá se tebe
```

Z čeho vychází: z vlastních hlášek dokovací sekvence (stejné, jaké ukazuje displej robota, např.
*Navigation readiness timeout*, *Intensity timeout*), z výsledkových kódů navigace (*no path
found*, *path blocked*, *robot stuck*, *oscillation*), ze stavu GPS/RTK, z baterie a ze
supervisoru.

| Co se stalo | Co agent zkusí (v tomhle pořadí, nejlepší první) |
|---|---|
| po výjezdu z doku chybí RTK | čeká na RTK nejvýš 10 min (displej *waiting RTK (2/10 min)*), pak pokračuje |
| nenašla se cesta / navigace to vzdala | krátká pauza a nový plán; pak přes jiný pojmenovaný bod (z druhé strany) |
| cesta je zablokovaná | počká 30 s, jestli překážka zmizí; pak přes jiný bod |
| robot uvízl / kmitá | nový plán; přes jiný bod |
| zajetí do doku selhalo (odrazka, jízda podle mapy) | zajede znovu před dok (UNDOCK) a dokuje odtamtud; pustí dokovací program znovu |
| motory jsou vypnuté | zapne motory a zkusí to znovu |
| robot je ještě v doku | nejdřív vyjede z doku |
| překážka těsně před robotem / uvízl | kousek couvne (`nav.backup`), otočí se (`drive.rotate`), pak nový plán |
| žádná pojmenovaná cesta kolem | dojede na bod objížďky, který model světa ověřil jako dosažitelný (`nav.goto_xy`) |
| dokování jedním způsobem opakovaně selhává | zadokuje druhou modalitou (podle mapy / jen podle odrazky, `dock.start_modality`) |

- Bod pro objížďku vybere [model světa](#co-agent-vidí) agenta (pojmenovaný bod, kam opravdu
  dojede); bez něj agent zvolí nejkratší cestu kolem sám.
- Každá možnost má odhad úspěchu; co na tomhle robotu už dřív pomohlo, má přednost (agent si
  pamatuje výsledek každého pokusu, viz [Co se agent naučí](#co-se-agent-naučí)).
- Meze: nejvýš 8 pokusů na misi, 4 na jeden krok, 30 min zkoušení. I každý pokus potřebuje
  supervisor jako kterýkoli jiný pohyb (a zámek doku, jen když robot stojí v doku). Cesta domů
  odemčení nikdy nepotřebuje.
- **Teprve když nic nezbývá** a robot je venku, **zajede zpátky do doku**; mise pak skončí jako
  *nedoběhla* s důvodem. Když selže i zajetí do doku, robot zastaví, motory se vypnou a chat se
  zeptá tebe (`pokračuj`, až to půjde dál).
- **Nikdy se nezkouší znovu:** převzetí člověkem (gamepad, joystick), STOP, nůž a hranice polohy.
  Mise počká na tebe.
- Co robot ještě neumí, založí agent jako **návrh nové schopnosti**; přidá se jen běžnou
  kontrolou, nikdy za jízdy.

### Co ukazuje displej robota

Během mise ukazuje druhý řádek displeje robota, co agent dělá nebo na co čeká — krátce, anglicky,
jen při změně (nejvýš jedna zpráva za pár sekund), například *Agent: driving to TEST*, *Agent:
waiting RTK (2/10 min)*, *Agent: trying another way*, *Agent: returning to dock*, *Agent: waiting:
owner unlock dock*, *Agent: need help - see app*. Totéž česky jde do chatu a do pruhu stavu
agenta.

## Práce (schválení a úlohy)

**Práce** má nahoře připnutá **schválení**, pod nimi *Čeká na tebe* (zaparkované úlohy), úlohy a
kartu *Mise / jízda*. Když agent chce udělat něco, k čemu je potřeba člověk, zeptá se:
**Schválit** / **Zamítnout**. Kdyby se robot pohnul, karta píše
*ROBOT BY SE POHNUL — povolit to smíš jen ty* a tlačítko potřebuje druhé klepnutí.

### Svítí jen to, co potřebuje tebe

Každá karta úlohy jedním řádkem řekne, kdo je na tahu: **Ty:** (svítí, čeká na tebe — odemknout
dok, zaparkovaná mise, chybí nastavení místa, zastavila bezpečnostní vrstva, fyzický zásah),
**Agent:** (doktor ji oživí nebo ji hlídá ovladač — tiše) nebo **Nic se nečeká:** (tiše). Do
**Chce pozornost** a do zvonku jdou jen úlohy *Ty*. **Zrušená** úloha je šedá, nikdy selhání.
Selhání, které pozdější běh téže práce spravil, které převzala pozdější mise nebo jehož výpadek
pominul, agent do pár minut sám přesune do archivu. Sbalená skupina **Vyřešil agent** ukazuje,
co uklidil nebo vyřešil sám, jako *Problém · Zdůvodnění · Řešení* — k nahlédnutí, nic dělat
nemusíš. Hlášení, která jen informují (RTK, dok, „sám jsem si spravil"), zůstanou v chatu, ale
nezvednou odznak, a na Discord přijdou bez upozornění na telefonu.

## Robot a zámek doku

**Robot** ukazuje živý stav, nástroje robota a kartu **Zámek doku**.

### Zámek doku

Agent **sám s robotem z doku nevyjede** — zámek hlídá **jen výjezd z doku**: vyjetí a každý
pohyb, když robot stojí v doku (nebo se stav doku nedá změřit), potřebuje kliknutí majitele tady.
**Návrat do doku je vždy povolený** a když je robot změřeně venku (`is_in_dock` false nebo stav
doku UNDOCKED), jízda na body, místa v mapě, po trasách i přímé řízení už další odemčení
nepotřebují — každý pohyb dál hlídá supervisor. Program sekání potřebuje vlastní odemčení
(**Sekání** nebo **Volná jízda**) i venku. Zastavit jde vždycky.

1. Vyber předvolbu a přečti si její rozsah: *Akce*, *Nepovoleno*, *Platí*, *Použití*,
   *Podepsal*.
   - **Volná jízda — cokoli, dokud se robot nevrátí do doku** (nahoře) — povolí každý pohyb
     včetně přímého řízení a uložených programů sekání (samotný nůž nikdy), bez omezení počtu
     použití. Zamkne se sama, jakmile je robot zpátky v doku
     (nebo nejpozději po 12 h). Když ji odemkneš, zatímco robot stojí v doku, počká, až robot
     vyjede a vrátí se. Karta píše *Odemčeno do návratu do doku*.
   - **Zkušební jízda** — vyjet z doku, jet k bodům, zajet zpět (a zapnout motory, je-li
     potřeba) a k tomu, co potřebuje zotavení mise (couvnout, otočit se, bod objížďky, dokovat
     jinou modalitou); 45 min, nejvýš 12 pohybů; žádné uložené trasy, žádné sekání.
   - **Sekání: spustit uložený program sekání** — spustí nebo obnoví uložený program stejně jako
     **Run** / **Resume** na kartě programu; 60 min na spuštění, nejvýš 3 spuštění. Viz
     [Programy sekání](#programy-sekání).
   - **Jen výjezd z doku, jednou** — 15 min, 1 použití.
   - **Vyjet z doku a zajet zpět** — 30 min, 2 použití.
2. **Odemknout — klepni znovu pro potvrzení**, pak do 6 s **Ano — odemknout dok**.
3. Dokud je otevřeno, karta ukazuje *ODEMČENO*, *Zbývá použití*, *Vyprší za* a **Znovu
   zamknout** — to každé odemčení hned vezme zpět.

Mise, která zámek potřebuje, se sama zaparkuje; její zpráva v chatu řekne, kterou předvolbu
potřebuje (výjezd z doku na bod a zpět = **Jen výjezd z doku, jednou** — zbytek jízdy i cesta
domů odemčení nepotřebují), a má **Otevřít zámek doku**, které tu
předvolbu rovnou otevře. Po odemčení mise pokračuje sama — `pokračuj` psát netřeba (po 2 h čekání
ji znovu rozjede jen `pokračuj`). Počítá se i odemčení z posledních 15 min před zaparkováním mise.

- **Platí vždy nejnovější odemčení.** Když je odemčené něco užšího (např. *Jen výjezd z doku*)
  a mise potřebuje víc, zpráva mise, `pokračuj` i *dok je odemčený* řeknou přesně, co je odemčené
  a co chybí. **Otevřít zámek doku** pak ukáže potřebnou předvolbu s poznámkou *Teď odemčeno: …* —
  jejím odemčením se užší nahradí. Karta s živým odemčením nabízí i širší předvolby.
- Odemčení, kterému zbývá méně použití, než mise spotřebuje v doku, misi nespustí; chat řekne,
  kolik zbývá a kolik je potřeba.
- Na *dok je odemčený* / *odemkl jsem* při čekající misi odpovídá sám zámek: buď se mise rozjede
  (odpověď to řekne, až opravdu jede), nebo řekne, co ještě chybí.

Zámek platí jen pro agenta, ne pro tvoje tlačítka a joystick.

## Co agent smí

Všechno jde přes jeden podepsaný seznam akcí; cesta „pošli cokoli" neexistuje. Agent vybere akci,
zkontroluje její argumenty a stav robota, potřebuje supervisor (a u pohybu zámek doku) a výsledek
pak **změří** — odpověď nikdy netvrdí úspěch bez důkazu.

| Akce | Co dělá | Pojistky |
|---|---|---|
| `dock.undock` / `dock.start` | robotův vlastní uložený program výjezdu / zajetí do doku | výjezd: zámek doku · zajetí: vždy povoleno · supervisor · změřený stav doku |
| `dock.start_modality` | zajetí uloženým programem podle mapy, nebo jen podle odrazky | jako výše |
| `nav.goto_waypoint` / `nav.execute_path` | jízda na uložený bod / po uložené trase | jméno musí existovat · zámek doku jen v doku · supervisor · výsledek navigace |
| `nav.goto_xy` | jízda na místo v mapě (x, y, natočení) | model světa musí nejdřív najít dosažitelnou cestu · zámek doku jen v doku · supervisor |
| `nav.goto_offset` | místo nejvýš 1 m vedle uloženého bodu | jako výše |
| `nav.backup` | couvnout o 5–50 cm | pravidla přímého řízení níže |
| `drive.straight` / `drive.rotate` / `drive.velocity` | jet rovně nejvýš ±2 m, otočit se nejvýš o ±360°, nebo rychlost nejvýš na 5 s | pravidla přímého řízení níže |
| `mower.program_run` / `mower.program_resume` | spustit / obnovit uložený program sekání | zámek doku (Sekání nebo Volná jízda) · supervisor v režimu sekání |
| `mower.program_stop` / `mower.program_reset`, `drive.stop`, `dock.stop`, `nav.cancel_*`, `motor.off` | zastavit | vždycky povoleno |
| `nav.speed`, `nav.clear_costmaps`, `nav.save_waypoint`, `nav.record_path_start` / `_stop`, `map.*` | nastavení, mapové nástroje, nahrávání (jména agenta začínají `agent_`) | sami robotem nehýbou; mapovací relace potřebují zámek doku |

**Nikdy:** samotné roztočení nože (taková akce neexistuje) a nic mimo seznam.

### Přímé řízení

`drive.*` a `nav.backup` řídí kola přímo, jako joystick, vlastním vstupem přepínače priorit na
robotu: **nad navigací, vždycky pod tvým gamepadem DS4 a webovým joystickem**
([Bezpečnost](safety.md#gamepad-ds4-a-joystick-mají-přednost-před-softwarem)). Robot měří
vzdálenost a úhel z odometrie, rychlost rozjíždí a brzdí plynule (nejvýš 0,3 m/s a 0,8 rad/s)
a sám zastaví — akce skončí jako *přerušená* s důvodem — když:

- převezmeš řízení (gamepad nebo joystick) — mise se zaparkuje a počká na tebe,
- zmáčkneš STOP (robota nebo agenta),
- agent přestane posílat udržovací signál nebo supervisor přestane být RUNNING (asi 0,6 s),
- lidar uvidí překážku ve směru jízdy (blíž než 0,3 m plus brzdná dráha; při otáčení cokoli
  v kružnici, kterou robot opisuje) — když tam je už na začátku, akce se odmítne a nic se nepohne,
- vypnou se motory, data z odometrie nebo lidaru zestárnou, nebo se robot nehýbe, ačkoli by měl
  (uvízl).

### Programy sekání

Agent smí spustit jen **uložený program sekání**, stejně jako **Run** / **Resume** na kartě
programu. Program sám vyjede z doku, poseká své zóny a vrátí se do doku. Spuštění a obnovení
potřebuje tvoje odemčení (**Sekání** nebo **Volná jízda**); zastavit a resetovat program jde
vždycky.

Dokud program běží, hlídá ho supervisor jako *běh sekání*: otáčky nože čeká **jen dokud sekací
automat robota hlásí, že běží právě tenhle program**; otáčky v kteroukoli jinou chvíli zastaví
všechno jako dřív. STOP, tvoje převzetí, ztracený heartbeat agenta nebo časový limit robot dál
zastaví — supervisor programu pošle stop a nůž vypne. Nůž agent sám nikdy nezapne.

## STOP agenta

Červený **STOP** v hlavičce panelu agenta (dvě klepnutí) zastaví, co agent spustil — supervisor
robot zastaví zhruba do 1,5 s. **Zůstane zajištěný**: agent odmítá všechny akce a pruh hlásí
*STOP JE ZAJIŠTĚNÝ*, dokud ho neuvolníš. Není to STOP robota — to je červený STOP
vpravo nahoře ([Bezpečnost](safety.md#stop)).

Co se zajistí a co ne:

- **Zajistí se:** červený STOP, `/stop` a holé *stop* / *zastav*, když **žádná** mise neběží (jen
  tak se dosáhne i na jednorázový manévr a práci na pozadí).
- **Nezajistí se:** *zastav* / *stop* / *stůj* **během mise** zastaví jen tu misi (viz tabulka
  výš) — agent dál udělá, co mu řekneš.

Jak ho uvolnit — cokoli z tohohle, s diakritikou i bez:

- ťukni **Zrušit STOP** v červeném pruhu;
- napiš *stop odvolávám*, *zruš stop*, *odvolej stop* nebo `/stop pokracuj`; zbytek věty se hned
  vykoná (*pokračuj, stop odvolávám* naváže na zastavenou misi, *zruš stop a vrať se do doku*
  jede domů);
- napiš *pokračuj* — když STOP platí, uvolní ho a naváže na to, co čekalo;
- napiš *vrať se do doku* (*zadokuj*, *jeď domů*) — **návrat domů je vždy povolený**: STOP uvolní
  a zadokuje. Supervisor, dokový zámek (hlídá jen výjezd) a převzetí ovladačem platí dál. Vlastní
  návrat agenta (mise, které vypršelo čekání) STOP neuvolní — to je tvoje rozhodnutí.

Dokud platí, každá odmítnutá akce to řekne jednou větou: *platí STOP z 23:41 — napiš
„stop odvolávám" (nebo ťukni Zrušit STOP)*.

### FAULT supervisoru

Když mise jede, hlídá ji samostatný supervisor. Přejde do **FAULT** a drží robota zastaveného,
když robot opustí povolenou oblast, ztratí polohu, agent přestane odpovídat, vyprší čas, roztočí
se nůž mimo program sekání nebo **převezme řízení člověk** (joystick, gamepad). Sám se uvolní nejdřív po 10 s, až
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

Stavový pruh rozsvítí jen **PŘEČTI SI** (nálezy, které chtějí tebe); **Nové** (čekají na rozbor
agentem) a vyřešené jsou sbalené.

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
když je to naléhavé nebo by se robot pohnul. Počítá **jen to, co čeká na tebe** — co agenti
vyřeší sami, klidné poznámky a informace ho nerozsvítí. Panel mluví stejně jako úvodní stránka
dashboardu Podpory:

![Čeká na tebe se třemi druhy karet](../img/shot-needs.webp "1 stav jednou větou · 2 druh karty, jak dlouho čeká, issue · 3 doporučená možnost · 4 co bude dál · 5 jeden krok po druhém · 6 co se změní, koho se týká, riziko")


- **Stav jednou větou** nahoře — *Na tobě čekají 3 věci. Agenti řeší 1 věc sami, Mac testuje
  7 oprav.* (zeleně *Nic po tobě nechceme.*, když nic nečeká) — a řádek pro každého robota (ty
  a druhá strana, např. *Má nejnovější vydání, robot na něm jede.*). Verze, časy stacku a podobná
  fakta jsou sbalené v *Podrobnosti pro agenty*.
- **Na tobě** — jeden seznam všeho, co máš udělat; jeho počet je číslo na zvonku:
  - **Upozornění, která vyřeší jen člověk** — token GitHubu vyprší nebo nefunguje, field neběží,
    Signál je vypnutý, druhá strana se neozývá nebo stojí, tenhle robot je pozadu — u každého co
    udělat a cesta tam (např. *Otevřít tokeny GitHubu*). Field je počítá stejně.
  - **Agent robota** — schválení a práce agenta, kterou odblokuje jen člověk (zámek doku,
    zaparkovaná mise, chybí nastavení místa, bezpečnostní stop) — stejná karta jako u fieldu (co,
    **Proč ty**, **Co bude dál**, malý štítek *agent robota*); rozhoduješ je v **Agent › Práce**.
  - **Podpora** — každá karta, na kterou se tě field ptá, je jeden ze **tří druhů**, v jedné
    anatomii: druh · *čeká 2 h* · #N → celý nadpis → **Proč ty** (jedna věta) → tělo → **Co bude
    dál** (co udělá které tlačítko a kdo to udělá) → *Pro agenty: technické podrobnosti* (sbalené). **Detail** (#N) otevře issue v **Podpoře** (níž).
  - **Rozhodnutí** — otázka a 2–3 **možnosti od agenta jako velká tlačítka** (co se stane a pro
    koho; doporučená první a vyplněná). První klik ji připraví (*Opravdu? …*), druhý pošle tvou
    volbu a agent ji provede. Možnost, která **hýbe robotem, nikdy není tlačítko** — ukáže kroky
    a dělá se u robota s rukou na STOP. **Proč doporučeno** a **Žádná nesedí, probrat s agentem**.
  - **Schválení** — **Co se změní · Koho se týká · Riziko**; u vydání i přesně co schvaluješ
    (*13 změn …*) a seznam změn commit po commitu. Nález (*Povolit / Zakázat*) rozhodneš tady;
    akce hlídače, vydání nebo sloučení má své pojistky na dashboardu: **Schválit nebo zamítnout
    v Podpoře** otevře tu kartu.
  - **Úkol s kroky** — **jeden krok po druhém**: *Udělej* a *Měl bys vidět*; **Hotovo** ukáže
    další krok (zařízení si pamatuje, kde jsi), poslední **Hotovo** to řekne fieldu; **Nejde**
    otevře kartu na dashboardu, ať agent naváže; **Zpět**. Bez rozepsaných kroků **Začít
    s agentem**.
  - klidné poznámky (např. *Mac na tebe čeká i u #8*) — sbalené v *Pro informaci (N)*, nepočítají
    se.
- **Agenti teď řeší** — co právě běží (agent opravuje #61 i s časem, hlídač čeká s restartem
  robota, až bude v klidu, agent druhé strany, *Mac testuje 7 oprav u robota*). Nikdy se nepočítá;
  číslo otevře issue v **Podpoře**.
- **Čeká se na ⟨Maca⟩** — sbalené: na čem je druhá strana, ať vidíš, kdo je na tahu. Do zvonku se
  nikdy nepočítá.

Každé tlačítko, které zapisuje, chce **dvě kliknutí do 5 s** a je podepsané tvým jménem (zeptá se
jednou na zařízení); jde přes webový uzel robota do dashboardu s jednorázovým tokenem vázaným na
kartu a text, který jsi viděl. Agentovi odsud jde poslat jen věta, kterou field sám připravil — a
jen když ji kit fieldu z UI robota přijímá (webový uzel se dashboardu ptá každých 10 minut; jinak
**Začít s agentem** a **probrat s agentem** otevřou issue na dashboardu) — a volba, která by pohnula
robotem, se tady nikdy nenabízí. Schválení akce hlídače (např. vydání) zůstává na dashboardu:
**Schválit nebo zamítnout v Podpoře**.
