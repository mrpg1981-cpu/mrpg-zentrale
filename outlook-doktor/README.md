# Outlook Doktor

Diagnose- und Reparatur-Tool für Microsoft Outlook (klassisch, 2016–365).

## Phase 1 – Diagnose (fertig)
Reine Analyse, **es werden keine Änderungen** am System vorgenommen.

```powershell
powershell -ExecutionPolicy Bypass -File .\OutlookDoktor.ps1
```

Prüft: Prozess, Add-ins, PST/OST, Profil, Navigationsbereich, Verbindung (M365), Anmeldung,
Office-Installation, Abstürze (30 Tage), Speicher & Rechte.

Ergebnis: HTML- + JSON-Bericht in `Desktop\OutlookDoktor`.

## Nächste Phasen
2. Reparatur-Module mit Backup & Rückgängig
3. Oberfläche (WPF) + PDF-Bericht
4. Tests, Code-Signatur
