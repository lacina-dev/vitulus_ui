---
id: map-editor
title: Editor mapy
group: Robot
order: 55
icon: la-pencil
summary: Body, trasy, překážky, bariéry a zóny sekání na aktivní mapě.
ui: [editor]
related: [mapping, programs, routes]
keywords: [editor, editor mapy, map editor, zóna, zóny, zone, bod, body, waypoint, trasa, path, překážka, obstacle, bariéra, barrier, volno, free, geofence, plot, polygon, výška sekání, cut height, otáčky, rpm, rozestup, spacing]
---
# Editor mapy

**Mapa › Mapa › Upravit mapu** (ikona vedle aktivní mapy) otevře editor: mapu shora, nástroje
v mřížce a seznamy toho, co už existuje (**Úpravy mapy**, **Body**, **Trasy**, **Zóny**). Robotem
můžeš během úprav dál jezdit. Tlačítko rozbalení editor zvětší; **Zavřít editor** nebo **✕** tě
vrátí do panelu Mapa.

![Editor mapy s očíslovanými značkami](../img/shot-editor.webp "1 nástroje · 2 Zobrazit (vrstvy editoru) · 3 co vybraný nástroj potřebuje · 4 seznamy: úpravy, body, trasy, zóny · 5 Zavřít editor · 6 mapa, do které kreslíš")

## Nástroje

| Nástroj | Jak |
|---|---|
| **Posun** | táhni a přibližuj mapu |
| **Bod** | klikni, kam ho dát, napiš název a kurz (0–359,5°, oranžová šipka), **Uložit**. Kliknutím na existující tečku ji vybereš a pak ji přesuneš nebo smažeš |
| **Trasa** | naklikej body a pak **Dokončit**. Kliknutím na existující trasu ji upravíš nebo smažeš |
| **Překážka (plocha)** | aspoň 3 body, **Dokončit** — tam robot nepojede |
| **Volno (vyčistit)** | označí plochu jako sjízdnou (odstraní falešnou překážku) |
| **Bariéra (čára)** | virtuální čára, kterou robot nesmí přejet; šířka 0,02–2 m (výchozí 0,10) |
| **Smazat** | kliknutím na úpravu (překážku, volno, bariéru) ji odstraníš |
| **Geofence** | naklikej obvod a pak **Odeslat návrh** — viz níž |

**Zobrazit:** zapíná a vypíná vrstvy editoru: body, trasy, úpravy, zóny. Uložené úpravy se do
mapy a do tras zón promítnou během několika sekund.

## Body DOCK a UNDOCK

DOCK a UNDOCK jsou obyčejné pojmenované body — můžeš je tady přesunout jako každý jiný. Co
znamenají, popisuje [Dok a výjezd z doku](dock.md#body). Nejpřesněji je ale nastavíš tak, že
robotem dojedeš na místo a v **Mapa › Dock** stiskneš **Aktualizovat**.

## Zóny (co sekat)

1. **Zóny › Nová zóna**, nakresli na mapě polygon.
2. Nastav **Název**, **Výška sekání** (mm, 20–65, výchozí 45), **Otáčky** (600–4000, výchozí
   3300), *Trasy kolem překážek* (2), *Úhel pokrytí* (160°), *Rozestup tras* (0,2 m)
   a *Zjednodušení* (0,1 m).
3. **Uložit** — plánovač spočítá trasy sekání a potvrdí to; stav ukáže, až je hotovo.

Zóny se po úpravách mapy přepočítají samy. Které zóny se sekají, pak určí
[program](programs.md).

## Geofence

Geofence (plot) je pevná hranice pro mise agenta. Editor ho jen **navrhne**: návrh se uloží
nepodepsaný a aktivním plotem se stane, až ho člověk podepíše na robotu (v příkazové řádce).
Prstenec, který vede nezmapovaným prostorem, robot odmítne; nejmenší plocha jsou 4 m². Geofence
se používá, jen když o tom rozhodne vlastník.
