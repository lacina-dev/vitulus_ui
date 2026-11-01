---
id: mowing
title: Sekací ústrojí
group: Robot
order: 65
icon: la-cut
summary: Napájení sekačky, nůž, výška sekání a otáčky v Nastavení › Sekačka.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [zátěž sekání, zátěž, stopa, teplota, přetížení, minulé běhy, sekačka, mower, nůž, blade, knife, výška sekání, cut height, výška, height, otáčky, rpm, pamatuje, uložená výška, uložené otáčky, po vypnutí, spustit motor, start motor, zastavit motor, stop motor, příkaz, mower command, print help, zastavení, stop, nečinná, idle, zrušené dokování, docking cancelled]
---
# Sekací ústrojí

Programy si sekačku řídí samy. **Nastavení › Sekačka** slouží ke kontrole a ručnímu ovládání.
Když je sekačka zapnutá, pravý panel ukáže pod Ovládáním sekci **Sekačka**: v řádku s názvem čip
stavu, tečku nože s otáčkami, — jen když je horko — teplotu a tlačítka nože **▶ Start** (dvě
klepnutí, jen ve stavu `READY`) / **■ Stop** (červené, když se nůž točí), totéž co START MOTOR /
STOP MOTOR tady; kliknutím na název se rozbalí
**Nůž**, **Výška** a **Teplota** (vždy, oranžová od 50 °C, červená od 60 °C) a běžící program
([Pravý panel](frame.md#pravý-panel)).

> [!CAUTION]
> Nůž je nebezpečný. Ručně ho spouštěj jen s robotem na trávníku, nikdo nesmí být poblíž a druhou
> ruku měj na **STOP**.

![Nastavení › Sekačka s očíslovanými značkami](../img/shot-mower.webp "1 ON / OFF (napájení) · 2 směr · 3 výška v mm + Nastavit · 4 otáčky + Nastavit · 5 Domů · 6 START MOTOR / STOP MOTOR")

| Ovládání | Co dělá |
|---|---|
| **ON / OFF** | napájení sekačky. Řádek ukazuje teplotu a stav: OFF, INIT, HOME, VÝŠKA, READY, RUN, ERR, BLOCKED, TEMP |
| **Směr** | **Vlevo** / **Vpravo** — směr otáčení nože. Současný řadič sekačky ho nepřebírá: hlásí vždy LEFT |
| **Výška** | aktuální / maximum v **mm**; zadej výšku v mm (od minima sekačky, výchozí 25 mm, po maximum, třeba 45) a **Nastavit**. Hodnota mimo rozsah se ignoruje |
| **Otáčky** | aktuální / žádané; zadej hodnotu (500–4000) a **Nastavit** |
| **Domů** | kalibrace výšky — žací ústrojí vyjede nahoru na doraz a vezme ho jako výchozí bod |
| **SPUSTIT MOTOR / ZASTAVIT MOTOR** | roztočí / zastaví nůž |

- **Robot si pamatuje výšku a otáčky, které tu nastavíš** (i joystickem nebo na displeji
  robota), přes vypnutí sekačky i restart robota. Řádek pod otáčkami ukazuje uložené hodnoty —
  i když je sekačka vypnutá nebo neodpovídá.
- Když se sekačka zapne, její řadič začíná od nuly: žací ústrojí vyjede nahoru (**Domů**) a nůž
  zůstane stát. Jakmile sekačka hlásí READY, robot posune žací ústrojí na uloženou výšku a nastaví
  uložené otáčky jako žádané. **Nůž nikdy nespustí** — to dál dělá jen **SPUSTIT MOTOR** nebo
  program. Když běží program, nedělá to.
- Výška a otáčky programu nebo zóny a zaparkování nože na maximum po sekání nebo při zastavení
  platí jen pro tu chvíli — uložené hodnoty nemění.
- Programy používají výšku sekání a otáčky zóny nebo programu ([Programy](programs.md)).
- **Výška sekání je vždy v milimetrech** — tady, v zónách ([Editor mapy](map-editor.md)) i
  v programech; robot sám pracuje v mm. 45 mm = 4,5 cm. Maximum je horní poloha žacího ústrojí,
  kam se nůž po sekání zaparkuje.
- Stav **TEMP**: sekačka je moc horká — nůž se vypne (znovu se dá spustit, až vychladne) a běžící
  program se vrátí do doku.

## Zátěž sekání v mapě

Vrstva **Zátěž sekání** (záložka Mapa, Vrstvy, a panel Vrstvy v editoru) kreslí stopu za robotem, živě
při sekání a později pro kterýkoli z posledních 30 běhů. Zapne se sama, když běží program, dokud si ji
nenastavíš sám; pak platí tvoje volba.

- **Barva** ukazuje vždy jednu věc, vybíráš ji v **Barva ukazuje**: Zátěž, Tah kol, Rychlost, Sklon,
  Teplota, GPS proti lidaru, GPS proti kolům, Stáří RTCM nebo Pokles otáček. Legenda dává skutečné hodnoty.
- **Šířka** říká, co robot dělal. Plný pruh široký jako žací ústrojí: sekání. Užší: rozběh nebo čekání.
  Tenká čára: nůž vypnutý. Fialová: zastaveno pravidlem bez nože. Růžová: zablokováno, bílá: přehřátý
  motor.
- **Zastávky a události** jsou malé ikony: zablokování, přetížení, záchrana, couvnutí, objížďka,
  zastavení na místě, bez postupu, nové okno trasy, varování teploty, výpadek RTCM, ztráta a návrat
  RTK, skok GPS. Když se tlačí, zůstanou ty
  nejhorší; ostatní uvidíš po přiblížení.
- **Klepnutí na stopu** ukáže krátkou kartu: nůž, jízda, poloha, napájení a úloha v tu chvíli. S myší
  stačí najet, ukážou se první čísla.
- **Běh** vybere minulý běh, pod ním jsou součty: čas sekání, přejezdy, zastávky, zátěž, špička
  teploty, energie.

Zátěž 100 % je bod, kdy firmware sekačky vypne motor: proud motoru na limitu (1,54 A) nebo otáčky na
čtvrtině nastavených, co je blíž. Nůž naprázdno ukazuje asi 10 %. Teplota se zapisuje syrově, takže
jediná chybná hodnota zůstane vidět: jeden vzorek v jinak chladném běhu je špička čidla, pomalý růst
je skutečné zahřívání.

- **Tah kol** je součet za všechna čtyři kola, jak těžce pracují, aby robot jel: asi 7 Nm na rovince,
  až 17 v zatáčkách. Každé kolo má limit 20 Nm. Karta přidá nejvíc zatížené kolo.
- **GPS proti lidaru** a **GPS proti kolům** ukazují GPS poctivě. Přesnost hlášená přijímačem říká
  skoro všude 1,4 cm, ať se děje cokoli, proto je jen v kartě. GPS proti lidaru říká, o kolik by sken
  lidaru položený na mapu chtěl posunout polohu GPS: obvykle 10 až 40 cm, a špatná mapa vypadá stejně
  jako špatné GPS. GPS proti kolům porovná krok GPS za sekundu s koly, která skákat neumějí: v RTK fix
  asi 4 cm, víc znamená, že se poloha opravdu pohnula; od 50 cm zůstane v mapě značka. Zatáčky se
  přeskakují.
- **Stáří RTCM** je čas od poslední korekce ze základny. Kmitá mezi 0 a 1 s, 3 s se počítají jako
  výpadek a zůstane po nich značka. Rychlost zpráv, satelity a pDOP jsou v kartě.
- **Pokles otáček** říká, o kolik nůž klesl pod nastavené otáčky. Řízení motoru je drží skoro pořád do
  2 ot./min, takže škála je jemná: ukáže už pár otáček. Skutečnou trávu lépe ukáže Zátěž.

Běhy nahrané dřív, než se tato data zapisovala, je ukážou šedě, bez dat. Tah kol mají i první běhy.

## Zastavení

Zastavení sekačky (z **Programy › Stop**, od supervizoru agenta nebo když člověk převezme
řízení joystickem) zabere **hned**: nůž se *vypne* v okamžiku, kdy pokyn dorazí.

- **Běží program** — zastavení zruší i zajíždění programu do doku a ukončí misi ve stavu
  *Zastaveno*, okamžitě a pokaždé.
- **Žádný program neběží** — vypne se jen nůž. Nic dalšího se nezastaví, takže dokování, které
  spustil agent nebo ty, tím nikdy nezrušíš.
- Několik zastavení po sobě se počítá jako jedno. Supervizor a převzetí joystickem posílají
  zastavení sekačky jen při běžícím programu; nůž stejně vypínají přímo.
- Na sekačku **bez napájení** (vypnutou) se nečeká: zastavení je hotové za okamžik, ne za desítky
  sekund, a uzel sekání jde vždycky zastavit nebo restartovat.

## Příkazy

Karta **Příkazy** posílá textové příkazy rovnou do řadiče sekačky a pod sebou ukazuje odpověď
(**Odeslat**). Seznam vypíše `PRINT HELP`. Určeno pro servis.
