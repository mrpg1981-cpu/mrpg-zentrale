# MRPG Commander

Zwei-Fenster-Dateimanager im Norton-Commander-Stil (MRPG Design) zum Hoch- und Herunterladen per **SFTP, FTP oder FTPS**.

## Start
```bash
cd mrpg-commander
npm install
npm start
```
Dann im Browser öffnen: http://127.0.0.1:8021 — links = lokaler Rechner, rechts = Server.

## Tasten
| Taste | Funktion |
|---|---|
| Tab | Panel wechseln |
| ↑ ↓ Pos1 Ende BildAuf/Ab | bewegen |
| Enter / Doppelklick | Ordner öffnen |
| Backspace | eine Ebene hoch |
| Einfg / Leertaste / Strg+Klick | markieren |
| Strg+A | alles markieren |
| F5 | Kopieren (lokal → Server = Upload, Server → lokal = Download, auch Ordner) |
| F6 | Umbenennen |
| F7 | Ordner anlegen |
| F8 / Entf | Löschen |
| F2 | Neu laden |
| F10 | Trennen |

Der Server lauscht nur auf 127.0.0.1. Passwörter werden nicht gespeichert (nur Server/Port/Benutzer).
