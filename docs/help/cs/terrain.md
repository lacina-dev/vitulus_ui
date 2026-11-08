---
id: terrain
title: Terén
group: Robot
order: 55
icon: la-area-chart
summary: Uzel terénu živě, trvalá mapa terénu (zapnout, pozastavit, složit znovu, smazat), vrstvy terénu a kandidáti zákazů.
related: [mapping, map-editor, localization]
keywords: [terén, průjezdnost, terén sečené plochy, import, záloha, traversability, uzel terénu, trvalá mapa, mapa terénu, záznamník terénu, terrain recorder, brána, RTK, schod, svah, překážka, zákaz, nogo, kandidáti, mozaika, sečená plocha, smazat mapu, složit znovu, pozastavit, výška, důvod]
---
# Terén

**Mapa › Terén** (sekce záložky Mapa, pod *Nahrávání mapy*) ukazuje, co robot ví o povrchu, a ovládá
**trvalou mapu terénu**. Nic tady nehýbe robotem ani nožem. `?` v hlavičce sekce otevře tuhle stránku.

Sekce se robota ptá jen tehdy, když je rozbalená a panel Mapa je zobrazený.

## Trvalá mapa terénu

Když robot jede s dobrou polohou, záznamník terénu přidává to, co vidí uzel terénu, do mapy celého
místa, která zůstává (výšky, schody, svahy, kolikrát bylo místo viděno). Dělá z ní i obraz pro vrstvu
*Terén sečené plochy*. Karta ukazuje:

- stav v hlavičce: **zapnuto** (mapa se skládá), **brána zavřená** (zapnuto, ale teď se nic
  nepřidává), **pozastaveno**, **vypnuto**, **bez mapy** (není obsluhovaná mapa, do které skládat)
  nebo **neběží** (záznamník neodpovídá: běží jen tehdy, když je trvalá mapa terénu v robotu
  nainstalovaná a povolená);
- **Brána** — do mapy se přidává jen při dost dobré poloze: RTK fix, lokalizace z GPS, ustálený kurz.
  Když je brána *zavřená*, řádek pod stavem říká proč (třeba *není RTK fix*, *robot je v doku*).
  V doku je zavřená brána normální;
- **Plocha** uložené mapy, **Poslední zápis**, **Místo** (obsluhovaná mapa), ke kterému patří.

Tlačítka:

- **Skládat mapu** (přepínač) — zapnout nebo vypnout. Robot si volbu pamatuje; po instalaci je
  vypnuto. Vypnutím uložené nezmizí.
- **Pozastavit / Pokračovat** — chvíli nepřidávat, bez vypnutí (do *Pokračovat* nebo restartu
  záznamníku).
- **Znovu z jízdy…** — vloží do mapy mozaiku terénu složenou z jízdy při sečení. Vyber mozaiku, kterou
  má robot připravenou (**Obnovit seznam** se ho zeptá znovu), a jak:
  - **Přidat do mapy** — doplní se jen místa, která mapa ještě nezná; jednou se zeptá a přidá;
  - **Nahradit mapu** — současná mapa jde do zálohy a mozaika nastoupí na její místo; robot se ještě
    zeptá a provede to až druhé tlačítko **Nahradit mapu**.

  Vše importované platí jako viděné jednou, nikdy jako zákaz. Skládání přímo z nahrávky jízdy v této
  verzi ještě není.
- **Smazat mapu…** — první stisk nic nemaže: robot řekne, co by zmizelo (místo, plocha, dlaždice),
  a že mapu přesune do zálohy v robotu. Smaže ji až druhé tlačítko **Smazat mapu**; mapa
  pak začne prázdná. Otázka se po minutě sama zavře, nebo **Zrušit**.
- **Udělat obraz znovu** — jen když se obraz pro vrstvu nepodařilo udělat.

Každé tlačítko pošle záznamníku jeden příkaz a jeho odpověď ukáže pod tlačítky; dlouhý příkaz (import,
mazání) píše *Pracuje se…*, dokud neskončí — může to trvat minutu a záznamník mezitím mlčí.
*Zatím neodpověděl* znamená, že není známo, že by se něco změnilo; pozdní odpověď se ještě ukáže.
Než to zkusíš znovu, podívej se na stav.

## Uzel terénu

Uzel terénu se kamerou dívá na povrch 6 × 6 m kolem robota. Karta ukazuje, jestli běží (hlásí se
každých 5 s), a:

- **Procesor**, který bere, **Výpočet** jednoho obrazu, **Snímky kamery** za sekundu;
- **Neumístěné snímky** za posledních 5 s (snímky, které nedokázal umístit, protože včas nevěděl,
  kde robot je);
- **Zóna doku** — *použitá*, když uzel ví, kde dok je (jinak *nevím, kde je dok*); v ní se povrch
  nikdy neoznačí jako nesjízdný;
- **Skoky polohy** — kolikrát poloha robota skočila (znovu se našel); *ustaluje se* znamená, že uzel
  chvíli čeká, než povrchu zase věří.

Varování uzlu (kamera nedává obraz, výpočet nestíhá…) jsou pod čísly.
**Parametry (jen čtení)** ukazují nastavení uzlu, jak je teď používá; hodnoty změněné proti výchozím
jsou modře. Tady se nemění.

## V mapě

Rychlé přepínače vrstev terénu, stejných jako v tlačítku vrstev na mapě
(viz [Mapy a mapování](mapping.md#tlačítko-vrstev-na-mapě)):

- **Průjezdnost (živě)** — okno uzlu terénu kolem robota, zhruba dvakrát za sekundu;
- **Terén sečené plochy** — mapa terénu celé posečené plochy (přednostně obraz trvalé mapy, jinak
  mozaika složená z jízd při sečení).

Každá vrstva má vlastní **Krytí** (u živé se k němu ještě přidává společné *Krytí map* z Mapa ›
Zobrazení). Když má robot víc map terénu (svou trvalou mapu, mozaiky jednotlivých sečení), vybereš
v **Která mapa terénu**, kterou *Terén sečené plochy* ukazuje; s jednou mapou se ukáže její název. **Pohled** (pro zapnuté vrstvy): *Průjezdnost* (zelená
volno → oranžová obtížnější → červená nesjízdné), *Důvod* (schod, svah, překážka, sráz viděný jednou,
zóna doku) nebo *Výška* (jen když ji vrstva má). Legenda pod ním patří k pohledu.
**Všechny vrstvy…** otevře kartu tlačítka vrstev.

## Kandidáti zákazů

Místa, která trvalá mapa našla nesjízdná (schod nebo příliš prudké), s velikostí a polohou (x, y
v mapě). **Ukázat v mapě** posune mapu na místo a na pár sekund ho
zakroužkuje.

Zatím jsou jen k prohlédnutí: schválení kandidáta jako zákazu přijde později a z tohoto seznamu se
nic nezapisuje.
