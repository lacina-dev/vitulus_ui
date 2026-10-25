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

### Stav etap (větev `ui-field-hub`)

- **I0 hotovo:** `webnode` `GET /field/api/<cesta>` jen pro allow-list
  (`attention`, `attention/ctx`, `activity`, `activity/current`, `home`,
  `issues`, `issue/<N>`, `meta`, `version`, `phone`, `fleet`, `task/list`),
  upstream napevno loopback, TLS ověřený proti CA kitu
  (`~/.local/share/vitulus-support/tls/ca.crt`), jiné cesty 404, POST 405,
  dashboard neběží = 503 `{ok:false}`. `assets/js/vt_hub.js` = jeden poller na
  zdroj (pauza ve skryté záložce, backoff), `VTHub.put/get/on/poll/refresh`.
  Agentní schválení do hubu dává `agent_chat.js` ze svého jediného polleru
  (U44 — žádný druhý dotaz na `/api/approvals`).
- **I1 hotovo (jen čtení):** `assets/js/vt_needs.js` — zvonek v navbaru
  (vlevo od menu; na nízkém okně, kde navbar není, na konci pásu menu),
  tón off/warn/err + počet; panel „Needs you“ ve sdíleném drawers: skupiny
  *Robot agent* (→ Agent › Work) a *Support* (→ „Open in Support“ na
  dashboardu). Na telefonu do 440 px uvolní titulek „Map view“ místo
  zvonku, aby navbar zůstal na jeden řádek.

- **I2 hotovo (jen čtení, větev `ui-field-activity`):** Agent › **Activity**
  (`assets/js/vt_activity.js`, šestá záložka agentního panelu mezi Work a
  Findings). Nahoře řádek „teď“ z `/field/api/activity/current` (pulzuje, když
  něco běží), filtry All · Agent · Support · Problems (pamatuje se), pod nimi
  jedna osa po dnech: události kitu za 24 h (`/field/api/activity`, anglický
  text `text_en`) + agentní joby a nálezy (`/agent/api/v2/jobs`: založení a
  uzavření s výsledkem). Zdroje se rozjedou při prvním otevření panelu, hub
  drží jeden poller na zdroj (teď 15 s, seznamy 60 s).

- **I3 + I4 hotovo (jen čtení, větev `ui-field-support`):** panel
  **Support** (`assets/js/vt_support.js`), tlačítko na konci pásu menu za
  Agentem; záložky *Issues* (otevřené issues s fází smyčky, závažností, kdo je
  na tahu, „Recently closed“ složené), *Releases* (verze kitu, vydání, watcher,
  co čeká na retest, počty ve fázích), *Signal* (obě strany: stav, kit,
  heartbeat, čeká na člověka, chyby 24 h; telefonní notifikace — bez ntfy
  tématu). Zdroje `/field/api/issues` a `/field/api/home`, pollují jen při
  otevřeném panelu (`VTHub.stop`). *Help* = nápověda UI robota v angličtině,
  nahoře sekce k právě otevřenému panelu; na PC tlačítko **?** v navbaru
  (na telefonu jen záložka, navbar by se zalomil); odkaz na field `#/help`.
  *(Od 18. 10. 2026 nahrazeno: nápověda = dokumentace v `docs/help/*.md`,
  panel nápovědy `vt_help.js` vpravo v rámu C / sheet na telefonu, „?“ v hlavičce
  každého panelu; záložka Help v Supportu jen vypisuje témata. Údržba:
  `docs/help/README.md`, kontrola `tools/test_help_docs.node.js`.)*

- **I6 hotovo (jen čtení, větev `ui-field-links`):** `assets/js/vt_links.js`.
  Karta issue (Support) má *Ask the agent* (otevře Agent › Chat s
  předvyplněným konceptem „About Support issue #N …“ — **neodešle**, odešle
  člověk) a *Timeline* (Agent › Activity jen pro issue #N za 7 dní — vlastní dotaz `/field/api/activity?issue=N`, štítek s ✕);
  karta field položky v Needs you má *Ask the agent* a *Issue #N*. Řádky
  Activity jsou odkazy: událost kitu s issue → Support › Issues se zvýrazněnou
  kartou, agentní nález → Agent › Findings, job → zvýrazněný v Agent › Work.

- **Jazyk fieldu (2026-10-25, `assets/js/vt_field_view.js`):** zvonek a panel Needs you
  mluví jako úvodní stránka fieldu (kit 0.9.43+, `tools/_overview.py`): *Jak na tom jsme*
  (`/api/home` `stav`, jedna věta za stranu), *Na tobě* (`todo.mine` + agent robota; varianty
  rozhodnutí s doporučenou, Potvrdit = `pick`, Žádná nesedí / Začít s agentem = `ask` do vlákna
  issue, Hotovo / Skrýt), *<druhá strana> má udělat* (sbalené, nepočítá se). Zvonek počítá jen
  `todo.mine` + agentní schválení/práci (dřív celé `/api/attention` včetně klidných informací).
  Support › Issues › **Detail** = lidský blok issue (`/api/issue/N` `human`). Akce `ask` webnodu
  potřebuje kit 0.9.52 (dashboard pustí jen větu, kterou k vláknu sám nabízí). Webnode drží
  poslední dobrou odpověď pomalých GET (`/api/home` 20–30 s při zátěži) a vrací ji s
  `X-Field-Age`, čerstvá doběhne na pozadí.

- **Karty otázek (2026-10-25, kit 0.9.52+ `ask`, `VTField.ask`):** co field člověku položí, je
  v Na tobě jedna ze tří karet jako na dashboardu (`tools/_asks.py`, `askCardHtml`): druh · čeká ·
  #N → nadpis → Proč ty → tělo → Co bude dál → Pro agenty (sbalené). *Rozhodnutí* = možnosti
  jako velká tlačítka (dvě kliknutí → `pick`; možnost s pohybem nikdy tlačítko), *Schválení* =
  Co se změní / Koho se týká / Riziko + seznam změn vydání; nález se rozhodne tady, akce
  hlídače / vydání / sloučení na kartě dashboardu („Schválit nebo zamítnout v Podpoře“), *Úkol
  s kroky* = krok po kroku, poslední Hotovo = `done`, Nejde = karta na dashboardu. Zvonek počítá
  jako field: bez informací (`live`, `info`), bez práce agenta (`ask.agent_work`). Dveře `ask`
  (věta do vlákna) nejsou podle verze kitu: webnode se dashboardu ptá požadavkem, který odmítne
  vždy (bez autora: 400 = dveře jsou, 403 „not an action" = nejsou), a hlásí `ask` v
  `/field/ui_actions`. Test: `tools/test_field_asks.node.js`.

- **Dveře ui-doors (2026-10-26, Robert ano na všechny čtyři body):** z UI robota jde poslat
  i *Nejde* u kroku (věta `ask.steps.steps[].fail`, dveře `ask`) a **Schválit / Zamítnout** akci
  hlídače nebo vydání (`/field/act/approve|dismiss` → dashboard `/api/watch/approve|dismiss`, tělo
  `{id, prompt_sha256}` té karty; akce s pohybem robota nikdy — dashboard odmítne, UI ji nenabídne).
  Webnode zjišťuje dveře `ask` a `approve` stejnou sondou (`/field/ui_actions` → `ask`, `approve`).
  Texty fieldu v jazyce diváka: `home.alt[lang]` (stav, todo), `ask_alt[lang]`, `human_alt[lang]`.

## I5 — zápisy z UI robota (owner 2026-10-18: a) „ať je to integrované“)

**Implementováno** (větev `ui-field-writes` + kit `kit-ui-writes`, 0.9.38): webnode
`POST /field/act/<done|pick|snooze|remind|finding-accept|finding-dismiss>` a
`GET /field/ui_actions`; dashboard `POST /api/ui/token` + průchod s `X-Vitulus-UI-Token`
(docs/DASHBOARD.md „Zápisy z UI robota“). Vypínač `~field_writes` webnodu, výchozí **true**:
pravidlo kitu „uvolňovat, ne zpřísňovat“ — všechny pojistky platí i tak a strana bez klíče
dashboardu (`ui-proxy.key`) nezapíše nic. Původní návrh níže zůstává jako popis.

### Původní návrh

Čeká na ownerův souhlas se změnou bezpečnostního modelu. Dnes zapisuje jen
dashboard (:8790) se svými pojistkami (token stránky za start, Host
allow-list, přesný same-origin Origin/Referer, `Sec-Fetch-Site: same-origin`
+ `Sec-Fetch-Mode: cors`, JSON, sha256 zobrazeného textu, na loopbacku odmítnutí
procesů agenta). Proxy `/field/api/*` je jen GET a tak má zůstat, dokud se
nerozhodne jinak.

**Co by šlo zapisovat (a nic víc):**

| Akce | Endpoint dashboardu | Proč z UI robota |
|---|---|---|
| Hotovo / odpověď na lidský krok | `/api/human-step/done`, `/api/human-step/answer` | člověk stojí u robota, krok je fyzický |
| Rozhodnutí karty Potřebuje tě (zvolená možnost) | `/api/plain/pick` | jedno místo pro rozhodnutí |
| Odložit / připomenout | `/api/attention/snooze`, `/api/attention/remind` | úklid fronty bez přepínání |
| Přijmout / zamítnout nález | `/api/findings/accept`, `/api/findings/dismiss` | nález vzniká na robotu |

**Co ne:** merge (`/api/kitfix/merge`), `watch/tick`, `sync/apply`,
`selftest/run`, `trial/start`, `test-hold`, instalace, fleet, telefon,
nové reporty/úkoly (zůstávají na dashboardu). Nic, co spouští jízdu nebo
sekání — to dál jen přes agentní schválení (brána jízda/sekání).

**Pojistky (všechny najednou):**

1. **Žádné obcházení tokenu:** UI robota si token nebere ze stránky
   dashboardu. Dashboard vydá webnode na loopbacku krátkodobý *proxy token*
   (např. 10 min, vázaný na akci a na `id` karty), webnode ho přidá do
   hlavičky jen pro allow-list výše; prohlížeč ho nikdy nevidí.
2. **Same-origin u robota:** `POST /field/act/<akce>` přijme webnode jen s
   `Origin` = vlastní původ UI, `Sec-Fetch-Site: same-origin`, JSON, malé
   tělo; z cizí stránky v LAN to nejde (žádné CORS).
3. **Potvrzení v UI:** každá akce = karta ukáže přesný text, který dashboard
   zobrazil (hash posílá s požadavkem jako dnes `sha256` promptu); tlačítko
   má druhý krok „Opravdu?“ (inline, ne `confirm()`), u akcí s pohybem nikdy.
4. **Kdo:** do auditu se zapíše jméno z UI (`vitulus_agent_author`) a adresa
   klienta; bez jména akce nejde.
5. **Audit:** dashboard zapisuje akci do svého feedu / receiptu jako dnes,
   webnode navíc řádek do `~/.vitulus/ui_actions.jsonl` (čas, akce, karta,
   kdo, výsledek); Activity v UI ho ukáže.
6. **Vypínač:** vše za přepínačem v konfiguraci webnode (`field_writes:
   false` výchozí), aby to owner mohl kdykoli vypnout.
7. **?mock** dál blokuje všechny POSTy (testy).

**Rozhodnutí pro ownera:** a) ano v tomto rozsahu, b) jen lidské kroky,
c) ne (zápisy zůstávají na dashboardu, UI dál jen odkazuje).

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

**Stav po sloučení s rámem U1 (kolo 5):** spodní hranu dává rám
(`vt_panel.css`: nad malým logem / nad spodní lištou), vedle otevřeného
pravého panelu ho posouvá `right_dock.css`. `vt_joy.css` přidává dvě
pojistky: na telefonu na výšku (`vt-m-sheet`) zůstává vpravo dole 12 px od
hrany (pravý panel je tam sbalený řádek přes celou šířku) a jinde nikdy
neopustí obrazovku. Ověřeno 1440×900, 390×844, 844×390: joystick nepřekrývá
log, pravý panel ani lišty. Zbývá (rám): na výšku s otevřeným sheetem je pod
ním (nedosažitelný, bezpečné); na šířku s otevřeným panelem zbývá mapě
~140 px a joystick se do ní vejde jen těsně.
