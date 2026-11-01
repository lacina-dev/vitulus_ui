---
id: map-editor
title: Editor mapy
group: Robot
order: 55
icon: la-pencil
summary: Výběr, úprava tvaru a pojmenování bodů, tras, překážek, bariér a zón sekání na aktivní mapě.
ui: [editor]
related: [mapping, programs, routes]
keywords: [editor, editor mapy, map editor, zóna, zóny, zone, bod, body, waypoint, trasa, path, překážka, obstacle, bariéra, barrier, volno, free, geofence, plot, polygon, tvar, vrchol, vybrat, zpět, přejmenovat, výška sekání, cut height, otáčky, rpm, rozestup, spacing]
---
# Editor mapy

**Mapa › Mapa › Upravit mapu** (ikona vedle aktivní mapy) otevře editor: mapu shora, nástroje
v mřížce a seznamy toho, co už existuje (**Úpravy mapy**, **Body**, **Trasy**, **Zóny**). Robotem
můžeš během úprav dál jezdit joystickem. Tlačítko rozbalení editor zvětší; **Zavřít editor** nebo **✕** tě
vrátí do panelu Mapa.

![Editor mapy s očíslovanými značkami](../img/shot-editor.webp "1 nástroje · 2 Zobrazit (vrstvy editoru) · 3 vybraný objekt a co nástroj potřebuje · 4 seznamy: úpravy, body, trasy, zóny · 5 Zavřít editor · 6 mapa, do které kreslíš")

## Nástroje

| Nástroj | Jak |
|---|---|
| **Vybrat** | klepni na objekt v mapě nebo v seznamu. Tažení posouvá mapu, sevření nebo kolečko přibližuje |
| **Bod** | klepni, kam ho dát, napiš název a kurz (0–359,5°, oranžová šipka), **Uložit** |
| **Trasa** | naklikej body a pak **Dokončit** |
| **Zóna** | nová zóna sekání, viz [Zóny](#zóny-co-sekat) |
| **Překážka (plocha)** | aspoň 3 body, **Dokončit** — tam robot nepojede |
| **Volné místo (vyčistit)** | označí plochu jako sjízdnou (odstraní falešnou překážku) |
| **Bariéra (čára)** | virtuální čára, kterou robot nesmí přejet; šířka 0,02–2 m (výchozí 0,10) |
| **Smazat** | klepnutím na úpravu (překážku, volno, bariéru) ji rovnou odstraníš, bez ptaní |
| **Geofence** | naklikej obvod a pak **Odeslat návrh** — viz níž |

**Zobrazit:** zapíná a vypíná vrstvy editoru: body, trasy, úpravy, zóny. Skrytá vrstva v mapě
nejde vybrat. Uložené úpravy se do mapy a do tras zón promítnou během několika sekund.

Při kreslení **Zpět** vrátí poslední bod. Vrcholy se chovají jako v další části.

Na telefonu se panel při práci v mapě zmenší na to nejnutnější. Tlačítko **^** vpravo nahoře v něm
vrátí nástroje, seznamy a podrobnosti.

## Výběr a úprava tvaru

Klepni na cokoli, co vidíš: zónu, překážku, volné místo, bariéru, trasu nebo bod. Objekt se vybere
v mapě i v seznamu zároveň a karta v panelu ukáže jeho název, velikost a akce. Výběr ze seznamu
navíc objekt přivede do záběru. Kde se objekty překrývají, dalším klepnutím přejdeš na další.

Vrcholy vybraného objektu se objeví hned:

| Chceš | Udělej |
|---|---|
| přesunout vrchol | táhni ho |
| přidat vrchol | klepni na bílou tečku na hraně, nebo ji rovnou přetáhni, kam vrchol patří |
| smazat vrchol | klepni na vrchol (zežloutne) a dej **Smazat vrchol**. Myší i Shift+klik nebo klávesa Delete |
| přesunout bod | táhni ho a v kartě nastav **Kurz** |
| změnit šířku bariéry | **Šířka bariéry** v kartě |

K robotu nejde nic, dokud nedáš **Uložit**, které se objeví s první změnou. **Zpět** vrací po krocích
(z klávesnice Ctrl+Z), **Zrušit** vrátí uložený tvar. Dokud je změna otevřená, ostatní objekty
a nástroje čekají, až ji uložíš nebo zrušíš. Zavření editoru s neuloženou změnou chce druhé
stisknutí a změnu pak zahodí.

Obrys, který se kříží sám se sebou, uložit nejde. Plocha má aspoň 3 vrcholy, čára 2.
**Smazat** v kartě odstraní celý objekt: stiskni ho dvakrát.

## Názvy

Každý objekt má název: překážka, volné místo, bariéra, bod, trasa i zóna. Nový objekt ho dostane
sám (**Překážka 1**, **Volné místo 2**, **Bod 1**…) a před uložením ho můžeš přepsat. Později ho
změníš tužkou ✎ v kartě vybraného objektu, u všech typů stejně.

- Název musí být v rámci typu jedinečný, nejvýš 60 znaků. Mezery a diakritika nevadí.
- Přejmenovaná zóna zůstává ve svých programech. Nejde přejmenovat, dokud běží mise, která ji používá.
- **DOCK**, **UNDOCK** a **docked** své názvy nemění.
- Agent objekty zná podle těchto názvů, takže dobrý název (*Bazén*, *Plot u sousedů*) pak používáš
  ty i agent.

## Body DOCK a UNDOCK

DOCK a UNDOCK jsou obyčejné pojmenované body — můžeš je tady přesunout jako každý jiný. Co
znamenají, popisuje [Dok a výjezd z doku](dock.md#body). Nejpřesněji je ale nastavíš tak, že
robotem dojedeš na místo a v **Mapa › Dock** stiskneš **Aktualizovat**.

## Zóny (co sekat)

1. Nástroj **Zóna** (nebo **Zóny › Nová zóna**), naklikej polygon v mapě. První, modrý vrchol je
   místo, kde sekání začíná.
2. Nastav **Název** a v **Nastavení sekání**: **Výška sekání** (mm, 20–65, výchozí 45), **Otáčky** (600–4000, výchozí
   3300), *Trasy kolem překážek* (2), *Úhel pokrytí* (160°), *Rozestup tras* (0,2 m)
   a *Zjednodušení* (0,1 m).
3. **Dokončit** — plánovač spočítá trasy sekání a potvrdí to; stav ukáže, až je hotovo.

Existující zónu vybereš jako každý jiný objekt a uvidíš její trasy sekání. **Nastavení sekání** je
v kartě. Karta také říká, které programy zónu používají.

Uložení nového tvaru přepočítá trasy sekání a promítne se do všech [programů](programs.md), které
zónu používají, takže dál fungují. Plánovač uložení odmítne a nechá starou zónu, když zónu používá
běžící program, když se programy mapy ještě načítají, nebo když po novém tvaru nezbude žádná trasa
sekání. Karta ukáže důvod a tvoje změna zůstane otevřená.

Zóny se po úpravách mapy přepočítají samy. Které zóny se sekají, pak určí
[program](programs.md).

## Geofence

Geofence (plot) je pevná hranice pro mise agenta. Editor ho jen **navrhne**: návrh se uloží
nepodepsaný a aktivním plotem se stane, až ho člověk podepíše na robotu (v příkazové řádce).
Prstenec, který vede nezmapovaným prostorem, robot odmítne; nejmenší plocha jsou 4 m². Geofence
se používá, jen když o tom rozhodne vlastník.
