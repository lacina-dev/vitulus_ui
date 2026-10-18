---
id: status-icons
title: Ikony stavu a barvy
group: Using the UI
order: 110
icon: la-circle
summary: Co říká každá ikona v navbaru, monitor počítače a čtyři barvy, které UI používá všude.
ui: [icons]
related: [localization, settings, troubleshooting]
keywords: [ikona, ikony, barva, barvy, zelená, oranžová, červená, šedá, stav, wifi, gps, imu, lidar, kamera, motor, teplota, ventilátor, napájení, baterie, nabíjení, spojení, připojení, monitor, cpu, paměť, ram, disk, síť, nuc, icon, colour, color, status, supply, battery, online, offline]
---
# Ikony stavu a barvy

## Čtyři barvy

Celé UI používá stejné čtyři tóny — na ikonách, čipech, kartách i tečkách v logu:

| Barva | Znamená |
|---|---|
| green | OK |
| orange | varování — funguje, ale podívej se na to |
| red | porucha — něco je špatně |
| grey | bez dat nebo vypnuto |

Barva akcentu (azurová) není stav: označuje odkazy, aktivní záložku a to, co je vybrané.

## Ikony v navbaru

![Navbar na PC s očíslovanými značkami](../img/shot-navbar.webp "1 spojení s robotem · 2 upozornění na déšť · 3 ikony stavu · 4 ? nápověda · 5 Čeká na tebe (zvonek)")

![Ikony stavu zblízka: skupiny senzory, pojezd, teplota a napájení](../img/shot-status-icons.webp "Čtyři skupiny zleva doprava: senzory · pojezd · teplota · napájení")

Na PC jsou v navbaru ve čtyřech skupinách (připojení a senzory · pojezd a sekačka · teploty ·
napájení); na úzké obrazovce v pruhu pod menu. Když na ikonu najedeš myší, ukáže svůj název.

| Ikona | Co | Zelená | Oranžová | Červená | Šedá |
|---|---|---|---|---|---|
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_wifi_green.png) | Wi-Fi | dobrá | střední | špatná | odpojeno |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_gps_green.png) | GPS (přijímač polohy) | RTK | 3D fix bez RTK | špatný | bez dat |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_gpsnav_green.png) | GPS navigace (přijímač kurzu) | RTK | 3D fix bez RTK | špatný | bez dat |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_imu_green.png) | IMU | zapnuto | — | — | vypnuto |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_lidar_green.png) | Lidar | zapnuto | — | — | vypnuto |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_camera_green.png) | Kamera (D435) | zapnuto | — | — | vypnuto |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_mower_green.png) | Sekačka | zapnuto / pracuje | — | chyba | vypnuto |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_motorLF_green.png) | Pojezdový motor (jeden na kolo) | OK | teplý | horký | vypnuto |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_tempPCB_green.png) | Teplota desky | OK | teplá | horká | bez dat |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_fanPCB_green.png) | Ventilátor desky | běží | — | — | stojí |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_temp_green.png) | Okolní teplota | OK | teplá | horká | bez dat |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_fan_green.png) | Vnější ventilátor | běží | — | — | stojí |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_supply_green.png) | Napájecí vstup (nabíječka) | připojeno (= v doku) | — | porucha | nic |
| ![](../../../nodes/templates/assets/img/robot_icons/Nextion_ico_batt_full.png) | Baterie | plná · ¾ · ½ · ¼ · prázdná; při nabíjení s bleskem | | | bez dat |

Ikona **mráčku** vedle loga je upozornění na déšť ([Počasí](waiting.md#počasí-mapa--déšť)),
text **spojení** vlevo od něj (**SPOJENO** / **PŘIPOJUJI** / **ODPOJENO**) říká, jestli je stránka
připojená k robotu — kliknutím se hned připojí znovu.

> [!TIP]
> Všechny ikony šedé? Stránka není připojená, nebo software robota (znovu) startuje — počkej
> minutu, pak viz [Řešení problémů](troubleshooting.md#ui-nereaguje).

## Monitor počítače

Na začátku pravé skupiny navbaru (na úzké obrazovce pod tlačítkem menu **☰**) ukazují čtyři malé
budíky počítač robota (NUC): **CPU**, **RAM** (paměť), **DISK** a **SÍŤ** (stahování ↓ / odesílání
↑). Budík je zelený pod 75 %, oranžový od 75 % a červený od 90 %; šedý, když data počítače nejsou
dostupná. Po najetí myší ukáže podrobnosti.
