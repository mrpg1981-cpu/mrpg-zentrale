---
name: Code-Review
description: Gründliches Review von Code oder einem Diff – Bugs, Sicherheit, Randfälle, Lesbarkeit. Nutzen, wenn Code geprüft oder bewertet werden soll.
---

1. Verstehe zuerst, was der Code tun soll.
2. Suche gezielt nach:
   - **Bugs:** falsche Logik, Off-by-one, null/undefined, Race Conditions, fehlende Fehlerbehandlung
   - **Sicherheit:** Injection (Shell, SQL, HTML), Pfade außerhalb erlaubter Ordner, Geheimnisse im Code
   - **Randfälle:** leere Eingaben, sehr große Daten, Sonderzeichen/Umlaute, gleichzeitige Zugriffe
3. Bewerte nur echte Probleme – Stil und Geschmack nur erwähnen, wenn sie die Lesbarkeit deutlich schädigen.
4. Ausgabe: nummerierte Liste, je Punkt **Datei:Zeile**, Problem, konkreter Fix. Wichtigstes zuerst.
5. Wenn alles in Ordnung ist: kurz sagen, was geprüft wurde, und nichts erfinden.
