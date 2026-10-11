# Odpovědi

**Connectoru přijde ze serveru příkaz "zapiš doklad X do firmy Y". Co musí platit, aby ho směl provést?**

Doklad X musí prokazatelně patřit firmě Y: TAXY jeho klienta přiřazuje firmě Y, firma Y má v Kaktusu IČO tohoto klienta a IČO odběratele na dokladu je IČO firmy Y. Doklad musí být v TAXY schválený a úplný, částky musí sedět (celkem = základy + DPH, kromě zaokrouhlení na koruny) a číslo dokladu, VS, IČO i DIČ se musí do Kaktusu vejít beze změny, protože delší hodnoty Kaktus potichu ořízne. Doklad v Kaktusu ještě nesmí být, a to ani pod svým TAXY id, ani se stejným dodavatelem a číslem dokladu, včetně smazaných záznamů. Do firmy Y zrovna nesmí zapisovat nikdo jiný: účetní ji nemá otevřenou, zámek firmy nedrží jiný běh Connectoru a případná dřívější přerušená dávka je dořešená. Pokud některou z podmínek nejde ověřit, Connector doklad nezapíše a vrátí stav s důvodem, protože pozdě zapsaná faktura je levná, kdežto chybný zápis v účetnictví klienta ne.

**Počítač účetní se vypne uprostřed zápisu dávky. V jakém stavu jsme a co se stane po zapnutí?**

Víme, která dávka se přerušila: Connector před spuštěním importu uložil na disk záznam o dávce a zálohu dat firmy. Nevíme, kam až Kaktus došel, protože jeho import není atomický: část dávky může být zapsaná a výjimečně zůstane některá tabulka prázdná. Po zapnutí Connector při nejbližším zápisu nejdřív dořeší přerušenou dávku: doklady, které podle TAXY id najde v DBF, potvrdí a zbytek pošle znovu, takže se nic nezapíše dvakrát ani neztratí. Poškozenou tabulku předtím obnoví z naší zálohy, ale jen když poškození mohla způsobit jedině naše dávka: záloha je v pořádku, od dávky se v datech firmy nic nezměnilo a firma není v Kaktusu otevřená. Jinak počká, dokud je firma otevřená, nebo firmu zastaví s chybou a cestou k záloze, protože obnova by smazala práci účetní.

**Čas:** 3 hodiny. **Částka k proplacení:** 0 Kč.
