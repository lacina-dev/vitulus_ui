# Jedno UI: robot + field dashboard + agent — návrh integrace (U2, 2026-10)

Stav: **jen návrh** (Robert 18. 10. 2026: „věci z field integrovat do jednoho UI
s tímhle a propojit to i s agentem — synergický celek. Teď ale UI.“).
Vizuální jazyk: `docs/UI_FIELD_STYLE.md`. Rám aplikace a rozložení: U1,
`docs/UI_LAYOUT.md` (větev `ui-unify-5`).

## 1. Co dnes existuje

| Kde | Co umí | Adresa | Pozn. |
|---|---|---|---|
| UI robota (`vitulus_ui`) | mapa, jízda, programy, nastavení, **agentní panel** (Chat / Work / Findings / Robot / Models), agentní pruh „Needs you“ pod navbarem | `http://<robot>:7779` | rosbridge :9090; agent přes **stejný původ** `/agent/*` (webnode → 127.0.0.1:8088) |
| Field dashboard (`vitulus-dash`) | Velín, **Potřebuje tě**, issues + vydání + kola oprav, Historie, Aktivita, Úkoly, Flotila, Signál, Důvěra, **Nápověda** | `https://<robot>:8790` | vlastní TLS; zápisy jen s tokenem stránky + same-origin + `Sec-Fetch-Site` + Host allow-list; CSP `frame-ancestors 'none'` (nejde do iframe) |
| Agent (v1/v2 jádro, bridge) | chat, joby, schvalování, nálezy (findings), incidenty, doktor | `127.0.0.1:8088` | do prohlížeče jen přes `/agent/*` |

Překryvy, které uživatel dnes vidí dvakrát: „co čeká na mě“ (agentní
schválení × field Potřebuje tě), „co se děje“ (agentní Work × field Aktivita /
„agent pracuje“), nálezy (agent Findings × field findings accept/dismiss),
nápověda (žádná v UI robota × field `#/help`).

## 2. Cíl: informační architektura jednoho UI

Jedna aplikace = UI robota (je to místo, kde člověk u robota stojí). Field
stránky se nestěhují celé — přecházejí **ty části, které člověk potřebuje
při práci s robotem**; zbytek (Důvěra, Flotila do hloubky, údržba kitu) zůstane
na dashboardu a vede tam odkaz.

```
navbar   [logo · Map view · ONLINE]  ······  [● Needs you 3] [agent ●] [?] [⏻]
menu     Marker · Settings · Map · Programs · Agent · Support
                                                     └─ nové (drawer)
drawer   Needs you   — jeden seznam: schválení agenta + field „Potřebuje tě“
         Agent       — Chat · Work · Findings · Activity · Robot · Models
         Support     — Issues & releases · Signal/Fleet (stručně) · → dashboard
         Help        — nápověda robota + field (#/help) v panelu „?“
```

Pravidla:

1. **Needs you je jedno místo.** Badge v navbaru (počet, tón: amber = čeká na
   člověka, red = blokováno) otevře drawer „Needs you“. Karty v jedné anatomii
   (`.vt-card` + `.vt-attn`): co udělat → rozhodující fakt → štítky → velká
   tlačítka → „co se stane potom“. Zdroj karty je štítek (`agent`, `field`).
   Agentní pruh pod navbarem zůstává jako upozornění na *jednu* nejdůležitější
   věc a vede do tohoto panelu.
2. **Aktivita je jedna časová osa.** Záložka Agent › Activity slučuje
   agentní joby/běhy a field feed (`/api/activity`): `.vt-acts > .vt-act`,
   pulzující tečka = běží, čas vpravo, pevná výška řádků.
3. **Nálezy mají jeden život.** Finding z agenta → (přijmout) → issue ve
   fieldu → kolo opravy → vydání → retest. V UI: Findings karta ukáže, kde
   je ve smyčce (štítky `issue #N`, `fix`, `release`, `retest`) a odkaz do
   Support › Issues.
4. **Support je čtení + odkazy.** Issues & releases (seznam, fáze, poslední
   vydání), stručný Signál a Flotila. Cokoli, co zapisuje na GitHub nebo do
   watcheru, se v 1. fázi otevírá na dashboardu (nová karta) — viz § 4.
5. **Help všude stejně.** Tlačítko „?“ v navbaru otevře boční panel s
   nápovědou k aktuálnímu pohledu (robot) a odkazem na field `#/help`;
   nápověda se drží aktuální s každou změnou (pravidlo kitu).
6. Telefon: drawer = bottom sheet (už je), badge Needs you v navbaru vždy
   viditelný, Support a Help přes menu. Žádná funkce jen pro desktop.

## 3. Datové zdroje

| Část UI | Zdroj | Endpoint (GET, není-li řečeno jinak) | Obnova |
|---|---|---|---|
| Needs you (field) | vitulus-dash | `/api/attention`, `/api/attention/ctx` | 30 s + po akci |
| Needs you (agent) | agent | `/agent/api/state` (approvals), `/agent/api/approvals/decide` (POST) | 5 s (dnešní poller) |
| „agent pracuje“ / busy | vitulus-dash | `/api/activity/current` | 5 s, jen viditelná stránka |
| Activity | vitulus-dash + agent | `/api/activity`, `/agent/api/task`, `/agent/api/missions` | 30 s / otevřená záložka |
| Findings | agent + dash | `/agent/api/doctor`, `/agent/api/incidents/…`; dash `/api/findings/accept|dismiss` (POST) | otevřená záložka |
| Issues & releases | vitulus-dash | `/api/issues`, `/api/issue/<N>`, `/api/home` (`velin`) | 60 s |
| Signal / Fleet | vitulus-dash | `/api/phone`, `/api/fleet` | 60 s |
| Help | vitulus-dash | `/api/meta`, help.js obsah | při otevření |
| Robot | rosbridge | topiky (beze změny) | live |

Jeden **sdílený poller** v UI (`window.VTHub`): jedna fronta, pauza při
skryté záložce, backoff při chybě, data do jednoho úložiště, ze kterého čtou
navbar badge i panely — žádné dva pollery na stejný endpoint (agentní panel
dnes polluje sám; převede se na hub).

## 4. Doprava a bezpečnost

- **Čtení:** webnode dostane druhý proxy vstup jako u agenta:
  `GET /field/api/<allow-list>` → `https://127.0.0.1:8790/api/…` (loopback,
  TLS ověřený proti certifikátu kitu). Allow-list jen GET cest z § 3 —
  prohlížeč nikdy nemluví s :8790 napřímo, žádné CORS.
- **Zápisy:** dashboard zápisy chrání tokenem stránky + same-origin; proxy by
  to obcházela, proto **fáze 1 = zápisy jen na dashboardu** (tlačítko
  „Open in Support“ otevře přesnou kartu `https://<robot>:8790/#/attention`).
  Fáze 2 (změna v kitu, schvaluje owner): dash přidá do allow-listu původ UI
  robota a vydá krátkodobý token pro proxy; teprve pak „Approve/Answer“
  přímo v UI robota.
- Iframe ne (CSP `frame-ancestors 'none'` je správně).
- Agent zůstává za `/agent/*`; STOP vždy deterministické jádro.
- `?mock` (vt_mock.js) blokuje i POST na `/field/*` a `/agent/*` — testy
  integrace na živém robotu bez zápisu.

## 5. Propojení s agentem (synergie)

- Z karty Needs you / issue: „Ask the agent“ otevře Chat s kontextem
  (issue #N, poslední kolo, krok) — chat dostane referenci, ne text.
- Z nálezu (Findings): „Report“ = předvyplněný field report (dash
  `/api/report/new`, fáze 2), odkaz se vrátí do karty nálezu.
- Agent ví, co člověk vidí: hub publikuje agentovi `ui_context` (otevřený
  panel, vybraná zóna/program), aby odpovědi mířily na aktuální obrazovku.
- Aktivita ukazuje agentní běhy a field kola v jedné ose → člověk vidí, že
  „agent opravuje #42, vydání 0.9.30 čeká na retest“ bez přepínání aplikací.

## 6. Etapy

| # | Co | Kde | Hotovo když |
|---|---|---|---|
| I0 | proxy `/field/api/*` (GET allow-list), `VTHub` poller | webnode, nový `vt_hub.js` | badge v navbaru čte `/api/attention` přes proxy, 0 požadavků na :8790 z prohlížeče |
| I1 | drawer **Needs you** (agent + field), badge | `vt_field.css` komponenty už jsou | jedna fronta, karty v anatomii, „Open in Support“ |
| I2 | Agent › **Activity** (sloučená osa) | agent_blocks.js | řádky `.vt-act`, žádné poskakování |
| I3 | **Support** drawer: issues, vydání, signál | nový panel | fáze smyčky čitelné na telefonu |
| I4 | **Help** panel „?“ | navbar + help obsah | nápověda ke každému panelu |
| I5 | zápisy z UI robota (approve, answer, findings) | změna kitu (dash) + UI | owner schválí změnu bezpečnostního modelu |
| I6 | agent ↔ field odkazy (Ask the agent, Report, ui_context) | agent + UI | jeden klik z nálezu do issue a zpět |

## 7. Joystick v rozložení (vstup pro layout matici U1)

Komponenta je hotová (`vt_joy.js/css`), umístění patří rámu. Rozměry:
šířka = `--vt-joy-size` + 24 px; výška ≈ size + 80 px (se stavovým řádkem a
čísly), na nízké obrazovce (≤ 500 px výšky) size 120 a bez čísel ≈ size + 44.
`--vt-joy-size`: 132 px myš, 156 px dotyk, 120 px nízká obrazovka.
Třída `.vt-joy-live` je na `#joy_view`, dokud se řídí (rám může ztlumit jiné
plovoucí prvky). Joystick nikdy sám neposouvá nic jiného.

Návrh umístění:

| Poloha | Kde | Proč |
|---|---|---|
| PC ≥ 992 px | vpravo dole nad spodní lištou, vlevo od otevřeného pravého panelu; **nad horní hranou logu**, ne přes log (dnes překrývá kompaktní log) | myš, mapa zůstává volná uprostřed |
| Telefon na výšku | vpravo dole nad spodní lištou (pravý palec), 156 px; s otevřeným bottom sheetem nad jeho horní hranou, když se vejde (≥ 240 px), jinak schovat (= stop) a v liště nechat aktivní ikonu | dnes ho pravý panel odsouvá vlevo — panel je na telefonu přes celou šířku, tak se joystick nemá řídit jeho šířkou |
| Telefon na šířku | vpravo, svisle uprostřed mapové plochy mezi lištami, kompaktní; pravý panel se při zobrazení joysticku sbalí na úchyt | výška 390 px nestačí na panel i joystick nad sebou |
| Tablet | jako PC, velikost dotyková | — |
| Volitelně | předvolba „joystick vlevo“ (leváci), pamatovat v localStorage | pravidlo „pamatovat rozkliknuté“ |

Do té doby drží `vt_joy.css` pojistku: joystick nikdy neopustí obrazovku
(clamp odsazení od pravého panelu).
