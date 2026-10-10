# Testovací úkol: napojení účetního programu Kaktus

Dobrý den,

tohle je práce, kterou u nás budete dělat nejčastěji: přijde nový účetní program a je potřeba ho napojit na TAXY. Program Kaktus je vymyšlený, problémy v něm ne.

## Co máte napsat

Program v TypeScriptu, který se pouští z příkazové řádky a umí dvě věci:

| | Vstup | Výstup |
|---|---|---|
| **1. Čtení** | data Kaktusu ve složce `kaktus/DATA/` | soubor s dodavateli a přijatými fakturami obou firem |
| **2. Zápis** | faktury z TAXY v `taxy/doklady-k-zapisu.json` | faktury zapsané v Kaktusu a přehled, jak dopadl každý doklad |

Všechno běží na vašem počítači nad soubory z tohoto balíčku. Nepíšete žádný server, web, databázi ani síťovou komunikaci.

## Kam ten program patří

Jen pro představu, nic z toho neprogramujete:

```
 TAXY (web a server)            počítač účetní kanceláře
┌──────────────────┐  příkaz   ┌─────────────────────────────────────────┐
│                  │ ────────> │ TAXY Connector (naše desktopová         │
│ faktury klientů  │           │ aplikace, TypeScript)                   │
│                  │ <──────── │   └─ modul pro Kaktus  <== TOHLE PÍŠETE │
└──────────────────┘  výsledek │              │ čte a zapisuje           │
                               │              v                          │
                               │   účetní program Kaktus (data v DBF)    │
                               └─────────────────────────────────────────┘
```

Účetní kancelář má Kaktus nainstalovaný u sebe na Windows. Program nemá žádné API, data drží v DBF souborech. Na stejném počítači běží náš Connector, který dostává příkazy ze serveru TAXY a provádí je lokálně. Connector i spojení se serverem jsou hotové.

V úkolu to máte zjednodušené:

- místo serveru TAXY máte dva soubory ve složce `taxy/`,
- místo Connectoru spouštíte svůj program ručně,
- místo skutečného Kaktusu máte simulátor a jeho data ve složce `kaktus/`.

## Jak se s Kaktusem pracuje

- **Čtení:** přímo z DBF souborů v `kaktus/DATA/`.
- **Zápis:** nikdy přímo do DBF. Vytvoříte XML dávku a předáte ji programu k importu, ten zapíše data sám a vrátí odpověď. Stejně to děláme u Pohody.
- Jak má dávka vypadat, popisuje příručka výrobce z roku 2014. Výrobce program už nevyvíjí a jinou dokumentaci nemáme.

Příkazy simulátoru (Node 18+, bez instalace):

```
node kaktus/kaktus.cjs import davka.xml     importuje dávku (jako KAKTUS.EXE /IMPORT)
node kaktus/kaktus.cjs obnovit              vrátí data do výchozího stavu
node kaktus/kaktus.cjs zamknout 0001        účetní má firmu 0001 otevřenou
node kaktus/kaktus.cjs odemknout 0001       účetní firmu zavřela
```

## Co je v balíčku

| Cesta | Co to je |
|---|---|
| `kaktus/DATA/` | data Kaktusu: `FIRMY.DBF` a složka pro každou ze dvou firem |
| `kaktus/kaktus.cjs` | simulátor, zastupuje cizí `KAKTUS.EXE` |
| `kaktus/prirucka/` | příručka výrobce |
| `taxy/klienti.json` | klienti kanceláře v TAXY a jejich firmy v Kaktusu |
| `taxy/doklady-k-zapisu.json` | faktury, které TAXY posílá k zápisu |

## Na co myslet

- Program se bude spouštět opakovaně a bez dozoru, u stovek kanceláří.
- Simulátor se chová jako skutečný program, ne nutně jako jeho příručka.
- Do kódu simulátoru se podívat můžete, skutečný program byste také mohl rozebrat. Jen napište, jestli jste to udělal.
- Jak se program spouští a jak vypadají jeho výstupy, je na vás.
- Co přesně znamená "hotovo", také necháváme na vás. Hodnotíme to, jako byste řešení zítra nasazoval a nikdo ho po vás nekontroloval.
- Když vám něco chybí nebo nedává smysl, odpovězte na e-mail, ve kterém úkol přišel. Otázky jsou v pořádku.

## Co odevzdat

Odkaz na repozitář (ideálně s historií commitů) nebo zip, ve kterém bude:

1. Kód.
2. `README.md`, nejvýš 400 slov: jak spustit čtení a zápis, co řešení umí a neumí, co jste o Kaktusu zjistil, která rozhodnutí jste udělal za nás a co byste udělal před ostrým nasazením.
3. Výstup z vašeho běhu: načtená data a přehled zápisu.
4. Jak jste pracoval s AI: soubor s instrukcemi pro agenta (`CLAUDE.md`, `AGENTS.md` nebo co používáte) a pár vět o tom, co dělala AI, co jste ověřoval sám a kde se spletla.
5. Odpovědi na dvě otázky, každá nejvýš 5 vět:
   - Connectoru přijde ze serveru příkaz "zapiš doklad X do firmy Y". Co musí platit, aby ho směl provést?
   - Počítač účetní se vypne uprostřed zápisu dávky. V jakém stavu jsme a co se stane po zapnutí?
6. Kolik času vám úkol zabral a částku k proplacení.

Limity délky myslíme vážně. Chceme vidět, co považujete za důležité.

## Organizace

- **Rozsah:** počítáme se 3-4 hodinami. AI používejte, jak jste zvyklý. Pokud to budete mít za hodinu, je to v pořádku.
- **Odměna:** napište částku, kterou za úkol chcete. Zaplatíme ji bez ohledu na výsledek.
- **Termín:** do 5 dnů od obdržení.
- **Hovor:** potom si na 30-45 minut zavoláme. Projdeme řešení a naživo v něm se sdílenou obrazovkou uděláte jednu malou úpravu. AI při tom klidně použijte.

Marian Zikmund, TAXY
