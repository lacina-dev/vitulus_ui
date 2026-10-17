# Rám aplikace a rozložení (U1, kolo 5)

Jeden **rám** drží všechny oblasti UI: horní lišta (navbar + pás menu + pás
hlášek), spodní lišta, levý panel (šuplík) a mezi nimi mapa. Pravý stavový
panel, log a joystick žijí uvnitř plochy mapy na pevných místech. Řídí to
`assets/js/vt_frame.js` (režim, CSS proměnné rámu) a sekce „frame“ ve
`assets/css/vt_panel.css`.

## Režimy (třída na `<body>`)

| Režim | Kdy | Levý panel |
|---|---|---|
| `vt-m-dock` | šířka ≥ 1024 px a výška ≥ 500 px (PC, velký tablet) | **dokovaný sloupec** 480 px: mapa se zúží vedle něj, nic nepřekrývá |
| `vt-m-overlay` | 576–1023 px nebo nízké okno (telefon na šířku, malý tablet) | sloupec 480 px (max. 60 % šířky) **přes mapu**, hrany lícují s lištami, mapa se nezužuje |
| `vt-m-sheet` | šířka < 576 px (telefon na výšku) | **sheet** navazující na spodní lištu (60 % výšky; ⤢/tah nahoru = celá výška) |

Stav panelu: **zobrazený** (`vt-panel-open`) / **skrytý** (mapa na celou plochu
mezi lištami). Přepínač: tlačítko ◧ vlevo v pásu menu (`#btn_panel_toggle`),
**Alt+P** na PC, ✕ v hlavičce panelu skryje, na telefonu i tah sheetu dolů.
Znovuotevření vrátí poslední panel (`vitulus_last_panel`); stav otevřeného
panelu přežije reload (`vitulus_open_panel`, beze změny z dřívějška).

## Matice: kde je která oblast

### PC (`vt-m-dock`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | navbar 42 px + pás menu, celá šířka | totéž |
| Hlášky (`#span_status_info`) | vlastní pás pod menu, vycentrovaný nad **mapou** (vpravo od panelu) | vycentrovaný přes celou šířku |
| Levý panel | sloupec 480 px od pásu menu ke spodní liště, sdílené hrany, bez stínu | — |
| Mapa | vpravo od panelu (plátno se zúží) | celá plocha mezi lištami |
| Pravý stavový panel | vpravo nahoře v ploše mapy pod pásem hlášek | totéž |
| Log malý | pruh nad spodní lištou v ploše mapy (od panelu po pravý panel) | od levé hrany po pravý panel |
| Log celý | celá plocha mapy pod hláškami, vlevo končí u panelu, vpravo u pravého panelu | celá šířka po pravý panel |
| Log skrytý | — (tlačítko ≡ ve spodní liště) | — |
| Joystick | vpravo dole v ploše mapy, nad malým logem, vedle pravého panelu | totéž |
| Spodní lišta | celá šířka | totéž |

### Telefon na šířku / malý tablet (`vt-m-overlay`)

| Oblast | Panel zobrazený | Panel skrytý |
|---|---|---|
| Horní lišta | při výšce < 600 px jen pás menu (navbar skrytý, jako dřív) | totéž |
| Hlášky | pás pod menu, vycentrovaný vpravo od panelu | přes celou šířku |
| Levý panel | sloupec přes mapu, max. 60 % šířky, lícuje s lištami, stín vpravo | — |
| Mapa | celá plocha (panel ji částečně kryje) | celá plocha |
| Pravý stavový panel | vpravo; když na něj nezbývá místo, zbyde úchyt | vpravo |
| Log malý | když vpravo od panelu zbývá ≥ 420 px: pruh vpravo od panelu; jinak (typicky telefon na šířku) **přes celou šířku nad spodní lištou a panel končí nad ním** (`vt-log-wide`) | celá šířka po pravý panel |
| Log celý | plocha vpravo od panelu, pod hláškami, nad spodní lištou | celá šířka po pravý panel |
| Joystick | vpravo dole, nad malým logem | totéž |

### Telefon na výšku (`vt-m-sheet`)

| Oblast | Panel zobrazený (sheet) | Panel skrytý |
|---|---|---|
| Horní lišta | navbar + pás menu | totéž |
| Hlášky | pás pod ikonkami, celá šířka | totéž |
| Pravý stavový panel | sbalený řádek pod hláškami (▾ rozbalí) | totéž |
| Levý panel | sheet od spodní lišty, 60 % výšky (celá výška ⤢) | — |
| Mapa | nad sheetem (editor ji rámuje do volné části) | celá plocha |
| Log malý | pruh pod hláškami (nad pravým panelem), celá šířka | totéž |
| Log celý | od hlášek/pravého panelu ke spodní liště; otevřený sheet je nad ním | totéž |
| Joystick | vpravo dole nad spodní lištou | totéž |

## Pravidla

- Hlášky a ovládání (lišty, panel, pravý panel) **nic nepřekrývá** — log ani
  v celé velikosti; vrstvy: lišty a pás menu/hlášek (z 10) > panel (1000,
  ale mimo lišty) > pravý panel (5) / log (8) mimo sebe navzájem.
- Log má 3 stavy: skrytý ↔ malý (≡ ve spodní liště) a malý ↔ celý (úchyt
  „Expand“ / „Collapse“ v liště logu); stav si pamatuje (`vitulus_hud_log`,
  `vitulus_log_expanded`).
- Změna šířky plochy mapy (dok/skrytí panelu) vyvolá `resize`, plátno 3D
  mapy se přepočítá.

## CSS proměnné rámu (nastavuje vt_frame.js)

| Proměnná | Význam |
|---|---|
| `--vt-top-h` | spodní hrana pásu menu (px od horní hrany okna) |
| `--vt-notice-b` | spodní hrana pásu hlášek (nebo `--vt-top-h`, když je prázdný) |
| `--vt-bottom-h` | výška zóny spodní lišty (od spodní hrany okna) |
| `--vt-left-occ` | šířka obsazená levým panelem v režimu dock/overlay (0 = skrytý) |
| `--vt-dock-w` | o kolik se zúží mapa (jen `vt-m-dock`) |
| `--vt-rp-w` | šířka pravého panelu v ploše mapy (0 = zavřený / telefon) |
| `--vt-rp-b` | spodní hrana pravého panelu (telefon: sbalený řádek) |
| `--vt-log-small-h` | výška malého logu, když je zobrazený (jinak 0) |

## Požadavky na tokeny (pro U2 / vt_tokens.css)

- `--vt-dock-w-desktop` (dnes 480 px natvrdo jako `--vt-drawer-w`) — šířka
  dokovaného sloupce, ať ji jde ladit spolu se vzhledem.
- `--vt-frame-border` — barva sdílených hran rámu (dnes `--vt-border-strong`).
- `--vt-log-small-h` výchozí výška malého logu (dnes 106 px / 62 px na nízkém
  okně, natvrdo v index.html a right_dock.css).
