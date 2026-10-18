---
id: mowing
title: Sekací ústrojí
group: Robot
order: 65
icon: la-cut
summary: Napájení sekačky, nůž, výška sekání a otáčky v Nastavení › Sekačka.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [sekačka, mower, nůž, blade, knife, výška sekání, cut height, výška, height, otáčky, rpm, pamatuje, uložená výška, uložené otáčky, po vypnutí, spustit motor, start motor, zastavit motor, stop motor, příkaz, mower command, print help, zastavení, stop, nečinná, idle, zrušené dokování, docking cancelled]
---
# Sekací ústrojí

Programy si sekačku řídí samy. **Nastavení › Sekačka** slouží ke kontrole a ručnímu ovládání.
Když je sekačka zapnutá, pravý panel ukáže pod Ovládáním sekci **Sekačka**: stav, otáčky nože,
výšku sekání a teplotu na první pohled ([Pravý panel](frame.md#pravý-panel)).

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
