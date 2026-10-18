---
name: Sicherheits-Check
description: Prüft Code, Konfiguration oder Docker-Setups auf Sicherheitslücken. Nutzen bei Login, Passwörtern, Dateizugriff, Shell-Befehlen, Netzwerk oder Docker.
---

Prüfe der Reihe nach:
1. **Eingaben:** Wird jede Benutzereingabe validiert? Shell-/SQL-/HTML-Injection möglich?
2. **Authentifizierung:** Passwörter gehasht (scrypt/bcrypt/argon2)? Sitzungen sicher (HttpOnly, SameSite)? Brute-Force-Schutz?
3. **Dateizugriff:** Können Pfade (`../`, Symlinks) aus dem erlaubten Ordner ausbrechen?
4. **Geheimnisse:** API-Keys/Passwörter im Code, in Logs oder im Git?
5. **Netzwerk/Docker:** Läuft etwas unnötig als root? Ports offen nach außen? Docker-Socket eingebunden?
6. **Abhängigkeiten:** bekannte unsichere oder veraltete Pakete?

Ausgabe: Tabelle mit **Risiko (hoch/mittel/niedrig)**, Fundstelle, Erklärung, Fix. Hohe Risiken zuerst.
