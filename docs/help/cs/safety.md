---
id: safety
title: Bezpečnost
group: Start here
order: 20
icon: la-shield
summary: STOP, gamepad a joystick s předností před softwarem, nůž, vypínač a proč jsou motory po startu vypnuté.
ui: [stop]
related: [dock, mowing, frame]
keywords: [stop, nouzové zastavení, nůž, gamepad, ds4, joystick, převzetí, přednost, mux, motory vypnuté, nebezpečí, vypínač, náklon, mock, emergency, blade, knife, takeover, priority, motors off, danger]
---
# Bezpečnost

Vitulus je těžký robot s ostrým a rychlým nožem. Pohybuje se sám, když mu to řekne program, mise
agenta nebo cíl navigace.

> [!CAUTION]
> Dokud je sekačka pod napětím, nedávej ruce ani nohy pod robota. Nikdy robota nezvedej ani
> nenakláněj s běžícím nožem. Děti a zvířata nesmí být u sekajícího robota.

## STOP

![Spodní lišta s červeným STOP vlevo](../img/shot-bottom-bar.webp "STOP je červené tlačítko na levém konci spodní lišty — na PC i na telefonu.")

Červené tlačítko **STOP**, vždy vlevo dole (na každé obrazovce stejné místo i velikost), udělá
najednou všechno tohle:

1. zruší cíl navigace,
2. **vypne** pojezdové motory,
3. zastaví běžící program sekání,
4. zastaví nůž,
5. zastaví zajíždění do doku nebo výjezd z doku,
6. rozpojí spínač motorů v napájecím modulu.

Po STOP se nic nerozjede, dokud někdo motory znovu nezapne (**Nastavení › Motory › ZAP**, nebo
**Vyjet**, které je zapne samo). STOP se pošle jednou — nic nezamyká, takže nový příkaz (výjezd,
displej robota) motory zase zapnout může.

> [!NOTE]
> Panel agenta má ve své hlavičce vlastní červený **STOP**. Ten zastaví misi agenta a odpovídá na
> něj jádro robota, nikdy model.

## Po každém startu jsou motory vypnuté

Po zapnutí robota, restartu softwaru robota nebo restartu ovladače podvozku jsou **pojezdové
motory VYPNUTÉ**. Robot se nepohne, dokud je někdo nezapne:

- **Nastavení › Motory › ZAP**, nebo
- **Vyjet** (program výjezdu je zapne), nebo
- tlačítkem na displeji robota.

Bezpečnostní node vypne motory sám (s alarmem), když motor hlásí poruchu, přestane se hlásit nebo
se při zapnutém napájení zahřeje nad 70 °C.

## Gamepad (DS4) a joystick mají přednost před softwarem

Každý příkaz k jízdě prochází na robotu jedním přepínačem priorit (*cmd_vel mux*):

![Kdo řídí: gamepad má přednost před joystickem v UI, joystick před softwarem; převzetí zruší úkol softwaru](../img/takeover.svg "1 gamepad DS4 · 2 joystick v UI (i jízda klávesnicí) · 3 software (navigace, programy, zajíždění do doku, mise agenta) · 4 přepínač priorit na robotu · 5 kola · 6 převzetí zruší, co software dělal")

| Pořadí | Kdo | Vyhraje, když |
|---|---|---|
| 1 | **Gamepad DS4** | se pohne páčkou (nebo stiskneš PS / L1 / R1) |
| 2 | **Joystick v UI** (i jízda klávesnicí) | se s ním hýbe |
| 3 | **Software** — navigace, program, zajíždění do doku / výjezd, mise agenta | nikdo neřídí ručně |

Spárovaný gamepad PlayStation DS4 komunikuje s robotem přímo (bez webového UI, bez Wi-Fi).

**Převzetí:** pohni páčkou (nebo stiskni **PS**, **L1** či **R1** a převezmeš řízení bez
pohybu). V tu chvíli robot

1. hned poslouchá tvoji páčku — příkazy softwaru se zahazují,
2. **zruší**, co dělal software: cíl navigace, zajíždění do doku / výjezd a běžící program sekání
   (ten přejde do *Zastaveno* a zastaví nůž, stejně jako **Zastavit** v Programech),
3. oznámí běžící misi agenta, že řízení převzal člověk (mise skončí, viz
   [Agent](agent.md#supervisor-fault)).

```flow
Řídí software | cíl, program, zajíždění do doku nebo mise agenta
warn: Převezmeš řízení | pohneš páčkou (nebo PS / L1 / R1), nebo zatlačíš webový joystick
err: Úkol softwaru se zruší | cíl, zajíždění do doku, program → Zastaveno, nůž vypnutý
Řídíš ty | robot poslouchá jen tvou páčku
off: Pustíš | robot zastaví a stojí
ok: Znovu spustit | nový cíl, Vyjet, nebo Reset + Spustit / Pokračovat
```

**Puštění:** robot zastaví a **stojí**. Software sám nepokračuje — je potřeba nový cíl, **Vyjet**
nebo **Reset** + **Spustit** programu. Node, který po zrušení dál posílá příkazy, zůstane
zablokovaný, dokud na 1 s neztichne.

**Zapnutý gamepad s páčkami uprostřed nedělá nic.** Robota nedrží a program nezastaví — klidně
ho nech zapnutý během autonomního sekání a chop se ho, až bude potřeba.

- Pravá páčka dopředu / dozadu, levá páčka zatáčí.
- Trojúhelník / křížek = napájení sekačky zap / vyp, kolečko / čtverec = nůž zap / vyp,
  šipky nahoru / dolů = výška sekání, vlevo / vpravo = otáčky nože. Tato tlačítka řízení
  **nepřevezmou**.

> [!WARNING]
> - Převzetí pojezdové motory **nevypne** — robot stojí, protože ho držíš ty. Pro tvrdé zastavení
>   stiskni **STOP** (vypne i motory).
> - S vypnutými motory robotem nepohne ani gamepad, ani joystick.
> - Stránka otevřená před touto změnou jezdí ještě se starou (nižší) prioritou — načti ji znovu.

## Fyzické tlačítko

Podržení vypínače na robotu **4 sekundy nebo déle** odpojí napájení motorů, výstup baterie
i počítač (nejtvrdší zastavení; zmizí i UI). Podržení jen 2–4 s je pohotovost, kterou software
může vrátit.

## Nůž

![Kde je nůž: pod středem těla (číslo 4)](../img/robot.svg "Nůž (4) se točí pod středem robota; nabíjecí kontakty (6) jsou vzadu.")

- Nůž má vlastní spínač: **Nastavení › Sekačka › SPUSTIT MOTOR / ZASTAVIT MOTOR**
  ([Sekání](mowing.md)). Programy ho spouštějí a zastavují samy.
- Zapnutí **napájení** sekačky nůž nespustí; jen znovu nastaví poslední výšku a otáčky.
- **STOP** vždy zastaví i nůž.
- Bezpečnostní node sekačku vypne sám (nůž i napájení sekačky), když se robot nakloní o víc než
  30° nebo se motor sekačky zahřeje nad 70 °C.

## Zkoušení bez pohybu robota

Otevři UI s `?mock` na konci adresy (například `http://192.168.0.1:7779/?mock`). Stránka pak
všechno živě **čte**, ale robotu **nic neposílá**: malý odznak *MOCK* počítá, co bylo
zablokováno. Hodí se na učení UI a na zkoušení rozvržení.
