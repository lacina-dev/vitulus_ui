---
id: dock
title: Dok a výjezd z doku
group: Robot
order: 30
icon: la-home
summary: Jak robot vyjíždí z nabíjecího doku a jak ho zase najde — a co dělat, když to nejde.
ui: [map/dock]
related: [localization, safety, troubleshooting]
keywords: [dok, dokování, zajetí do doku, výjezd z doku, vyjet, nabíjení, odrazka, odrazivost, intenzita, bod, zámek doku, dock, undock, charging, reflector, intensity, waypoint, DOCK, UNDOCK, docked, lock]
---
# Dok a výjezd z doku

Dok robot nabíjí. Nabíjecí kontakty má **vzadu**, takže do doku vždy **couvá**. Na doku je
odrazka, podle které lidar dok přesně najde („intenzita“, odrazivost).
Robot je **v doku, když nabíječka dodává proud** (ikona napájení zelená, *ONLINE*).

![Dok shora s očíslovanými částmi: dok, jeho odrazka, usazený robot, body DOCK a UNDOCK, okraj střechy a volné nebe](../img/dock.svg "Zelená čárkovaná = cesta ven (výjezd), azurová = cesta dovnitř (zajetí, couváním).")

1. **Dok** s nabíjecími kontakty na zadní stěně.
2. **Odrazka** — lidar ji vidí jako velmi jasný pruh a podle ní dok najde.
3. **docked** — poloha robota, když sedí v doku (zádí na kontaktech).
4. **DOCK** — příjezdový bod před dokem, otočený od doku; odtud robot zacouvá dovnitř.
5. **UNDOCK** — bod, na který robot vyjede.
6. **Pod okrajem střechy** je GPS špatná — proto výjezd čeká na RTK až na UNDOCK.
7. **Volné nebe** — tady se RTK vrátí.

## Výjezd z doku

![Sekce Ovládání pravého panelu: baterie, motory a tlačítka Dock, Undock a Stop](../img/shot-controls.webp "Pravý panel › Ovládání: 3 Dock · 4 Undock · 5 Stop (přeruší sekvenci)")

**Pravý panel › Ovládání › Undock** spustí uložený *program výjezdu z doku*:

```flow
Motory zapnout | program zapne pojezdové motory
Vycouvat | podle odrazky vyjede 1,25 m z doku
Na UNDOCK | podle mapy místa dojede na bod UNDOCK
warn: Čekat na RTK | oba GPS přijímače RTK a ustálená GPS odometrie 5 s (10 min, po restartu až ~25 min)
ok: Hotovo | motory zůstanou zapnuté
```

- Na motory čeká nejvýš 20 s; když nenaběhnou, výjezd se přeruší.
- Když má mapa místa bod **UNDOCK**, robot na něj nejdřív dojede a na GPS čeká až tam — pod
  okrajem střechy doku bývá fix špatný.
- *Waiting for RTK fix* ve stavovém řádku znamená, že robot stojí a čeká, až obě ikony GPS
  zezelenají (a GPS odometrie se ustálí). Ztráta RTK odpočet 5 s spustí znovu. Každých 30 s
  ukáže displej průběh, např. *Waiting for RTK: main RTK, heading 3DFIX - 4:43 / 19:43*
  (čekám / aktuální limit).
- Limit je 10 minut. Když přijímače postupují (hlavní dosáhne RTK, heading přepne na RTK),
  prodlouží se o 15 minut, nejvýš ale do ~25 minut od naběhnutí GPS — po restartu potřebuje
  heading přijímač ~15–17 minut. Pak se výjezd přeruší s hláškou *RTK not ready in time*.
  V programu sekání robot potom zajede zpátky do doku a program se zkusí později (jako po jiné
  chybě); ruční Undock ho nechá stát.

## Zajetí do doku

**Pravý panel › Ovládání › Dock** spustí uložený *program zajetí do doku*:

```flow
Na DOCK | podle mapy dojede na bod DOCK před dokem
Najít dok | lidarová mapa doku a / nebo odrazka
Zacouvat | dokud nabíječka nedodává proud
ok: Usadit | 15 s dosedá, pak vypne motory
```

> [!IMPORTANT]
> Zajetí do doku motory nikdy nezapne. Když jsou vypnuté, hned selže s hláškou
> *Motors are OFF – turn motors on to dock*. Zapni je v **Nastavení › Motory** a stiskni znovu
> **Dock**.

**Stop** vedle **Dock** / **Undock** sekvenci přeruší (stav na chvíli ukáže *failed* — to je
v pořádku).

## Záložka Dock (Mapa › Dock)

Slouží k nastavení a ručním zkouškám; běžně stačí **Dock** / **Undock** v pravém panelu.

![Záložka Dock panelu Mapa s očíslovanými kartami](../img/shot-dock-tab.webp "Mapa › Dock: 1 dok podle lidarové mapy · 2 dok podle odrazivosti · 3 Aktualizovat bod DOCK · 4 Aktualizovat bod UNDOCK · 5 mapa detektoru doku · 6 počáteční lokalizace · 7 program zajetí do doku · 8 program výjezdu z doku")

| Část | Co dělá |
|---|---|
| Dok podle lidarové mapy | přepínač zapnutí, **Před dok**, **Dock**, **Undock**, **Stop** — jen krok s lidarovou mapou doku |
| Dok podle odrazivosti | přepínač zapnutí, **Dock**, **Undock**, **Stop** — jen krok s odrazkou |
| Body doku / výjezdu | **Navi** dojede na bod DOCK nebo UNDOCK; **Aktualizovat** uloží *současnou* polohu robota jako ten bod |
| Mapa detektoru doku | **Nová mapa**, **Upravit mapu**, **Uložit mapu** — lidarový obraz doku |
| Počáteční lokalizace | poloha *docked*, podle které se robot v doku lokalizuje; když chybí, píše *CHYBÍ bod polohy v doku* |
| Program zajetí do doku / výjezdu z doku | zaškrtni kroky (bod z mapy, trasa z lidarové mapy, akce podle odrazivosti) a dej **Provést** nebo **Uložit** |

Ruční karty obcházejí stavový automat doku — používej je, jen když robot vidíš.

### Body

- **DOCK** — příjezdový bod před dokem, cíl kroku s mapou při zajíždění.
- **UNDOCK** — bod, na který robot vyjede.
- **docked** — poloha robota usazeného v doku; z ní začíná lokalizace v doku. Vznikne sama, když
  dokončíš nahrávání mapy *v doku* ([Mapy](mapping.md)).

Nastavení DOCK nebo UNDOCK: dojeď s robotem přesně na místo (i se správným kurzem) a dej
**Aktualizovat**. Nebo bod posuň v [editoru mapy](map-editor.md).

## Zámek doku (agent)

[Agent Vitulus](agent.md) nesmí sám vyjet z doku ani od něj odjet: **zámek doku** otevírá jen
majitel, v **Agent › Robot › Zámek doku**, a to pro pojmenovaný rozsah. Viz
[Zámek doku](agent.md#zámek-doku). Zámek platí jen pro agenta: program, který spustíš v
**Programy** (**Run** / **Resume**), nebo program spuštěný kalendářem vyjede z doku i bez
něj.

## Když to selže

Automatické opakování není: při timeoutu nebo chybě skončí sekvence jako *aborted*, detektory se
vypnou a navigace se zruší. Motory zůstanou, jak byly.

> [!TIP]
> - *Motors are OFF* → zapni motory a stiskni znovu **Dock**.
> - *Map has no DOCK/UNDOCK point* → nastav bod (viz výše).
> - Visí na *Waiting for RTK fix* → podívej se na ikony GPS a na
>   [stav lokalizace](localization.md); pomůže volné nebe, základnová stanice musí běžet.
> - Odrazka se nenašla → je čistá a vidět, je robot pár metrů od doku a míří k němu? Přijeď
>   joystickem blíž a zkus to znovu.
> - Víc v [Řešení problémů](troubleshooting.md#zajetí-do-doku-selže).
