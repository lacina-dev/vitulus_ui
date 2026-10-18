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

## Výjezd z doku

**Pravý panel › Ovládání › Vyjet** spustí uložený *program výjezdu z doku*:

```flow
Motory zapnout | program zapne pojezdové motory
Vycouvat | podle odrazky vyjede 1,25 m z doku
Na UNDOCK | podle mapy místa dojede na bod UNDOCK
warn: Čekat na RTK | oba GPS přijímače RTK a ustálená GPS odometrie 5 s (max. 10 min)
ok: Hotovo | motory zůstanou zapnuté
```

- Na motory čeká nejvýš 20 s; když nenaběhnou, výjezd se přeruší.
- Když má mapa místa bod **UNDOCK**, robot na něj nejdřív dojede a na GPS čeká až tam — pod
  okrajem střechy doku bývá fix špatný.
- *Waiting for RTK fix* ve stavovém řádku znamená, že robot stojí a čeká, až obě ikony GPS
  zezelenají (a GPS odometrie se ustálí). Ztráta RTK odpočet 5 s spustí znovu. Po 10 minutách se
  výjezd přeruší s hláškou *Navigation readiness timeout*.

## Zajetí do doku

**Pravý panel › Ovládání › Do doku** spustí uložený *program zajetí do doku*:

```flow
Na DOCK | podle mapy dojede na bod DOCK před dokem
Najít dok | lidarová mapa doku a / nebo odrazka
Zacouvat | dokud nabíječka nedodává proud
ok: Usadit | 15 s dosedá, pak vypne motory
```

> [!IMPORTANT]
> Zajetí do doku motory nikdy nezapne. Když jsou vypnuté, hned selže s hláškou
> *Motors are OFF – turn motors on to dock*. Zapni je v **Nastavení › Motory** a stiskni znovu
> **Do doku**.

**Stop** vedle **Do doku** / **Vyjet** sekvenci přeruší (stav na chvíli ukáže *failed* — to je
v pořádku).

## Záložka Dok (Mapa › Dok)

Slouží k nastavení a ručním zkouškám; běžně stačí **Do doku** / **Vyjet** v pravém panelu.

| Část | Co dělá |
|---|---|
| Dok podle lidarové mapy | přepínač zapnutí, **Před dok**, **Do doku**, **Vyjet**, **Zastavit** — jen krok s lidarovou mapou doku |
| Dok podle odrazivosti | přepínač zapnutí, **Do doku**, **Vyjet**, **Zastavit** — jen krok s odrazkou |
| Body doku / výjezdu | **Jet** dojede na bod DOCK nebo UNDOCK; **Aktualizovat** uloží *současnou* polohu robota jako ten bod |
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
[Zámek doku](agent.md#dock-lock). Zámek platí jen pro agenta: program, který spustíš v
**Programy** (**Spustit** / **Pokračovat**), nebo program spuštěný kalendářem vyjede z doku i bez
něj.

## Když to selže

Automatické opakování není: při timeoutu nebo chybě skončí sekvence jako *aborted*, detektory se
vypnou a navigace se zruší. Motory zůstanou, jak byly.

> [!TIP]
> - *Motors are OFF* → zapni motory a stiskni znovu **Do doku**.
> - *Map has no DOCK/UNDOCK point* → nastav bod (viz výše).
> - Visí na *Waiting for RTK fix* → podívej se na ikony GPS a na
>   [stav lokalizace](localization.md); pomůže volné nebe, základnová stanice musí běžet.
> - Odrazka se nenašla → je čistá a vidět, je robot pár metrů od doku a míří k němu? Přijeď
>   joystickem blíž a zkus to znovu.
> - Víc v [Řešení problémů](troubleshooting.md#docking-fails).
