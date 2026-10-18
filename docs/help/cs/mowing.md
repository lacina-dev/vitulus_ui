---
id: mowing
title: Sekací ústrojí
group: Robot
order: 65
icon: la-cut
summary: Napájení sekačky, nůž, výška sekání a otáčky v Nastavení › Sekačka.
ui: [config/mower]
related: [programs, safety, settings]
keywords: [sekačka, mower, nůž, blade, knife, výška sekání, cut height, výška, height, otáčky, rpm, spustit motor, start motor, zastavit motor, stop motor, příkaz, mower command, print help, zastavení, stop, nečinná, idle, zrušené dokování, docking cancelled]
---
# Sekací ústrojí

Programy si sekačku řídí samy. **Nastavení › Sekačka** slouží ke kontrole a ručnímu ovládání.

> [!CAUTION]
> Nůž je nebezpečný. Ručně ho spouštěj jen s robotem na trávníku, nikdo nesmí být poblíž a druhou
> ruku měj na **STOP**.

![Nastavení › Sekačka s očíslovanými značkami](../img/shot-mower.webp "1 ZAP / VYP (napájení) · 2 směr · 3 výška v mm + Nastavit · 4 otáčky + Nastavit · 5 Domů · 6 SPUSTIT MOTOR / ZASTAVIT MOTOR")

| Ovládání | Co dělá |
|---|---|
| **ZAP / VYP** | napájení sekačky. Řádek ukazuje teplotu a stav: OFF, INIT, HOME, VÝŠKA, READY, RUN, ERR, BLOCKED, TEMP |
| **Směr** | **Vlevo** / **Vpravo** — směr otáčení nože. Současný řadič sekačky ho nepřebírá: hlásí vždy LEFT |
| **Výška** | aktuální / maximum v **mm**; zadej výšku v mm (od minima sekačky, výchozí 25 mm, po maximum, třeba 45) a **Nastavit**. Hodnota mimo rozsah se ignoruje |
| **Otáčky** | aktuální / žádané; zadej hodnotu (500–4000) a **Nastavit** |
| **Domů** | kalibrace výšky — žací ústrojí vyjede nahoru na doraz a vezme ho jako výchozí bod |
| **SPUSTIT MOTOR / ZASTAVIT MOTOR** | roztočí / zastaví nůž |

- Když se sekačka zapne, její řadič začíná od nuly: žací ústrojí vyjede nahoru (**Domů**),
  žádané otáčky jsou výchozí hodnota uložená v řadiči a nůž zůstane stát. Výška ani otáčky
  nastavené ručně vypnutí nepřežijí.
- Programy používají výšku sekání a otáčky zóny nebo programu ([Programy](programs.md)).
- **Výška sekání je vždy v milimetrech** — tady, v zónách ([Editor mapy](map-editor.md)) i
  v programech; robot sám pracuje v mm. 45 mm = 4,5 cm. Maximum je horní poloha žacího ústrojí,
  kam se nůž po sekání zaparkuje.
- Stav **TEMP**: sekačka je moc horká — nůž se vypne (znovu se dá spustit, až vychladne) a běžící
  program se vrátí do doku.

## Zastavení

Zastavení sekačky (z **Programy › Zastavit**, od supervizoru agenta nebo když člověk převezme
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
