# 〄 MRPG Zentrale

Die Zentrale für alle Projekte, Apps und KI-Modelle, im MrPG.dev-Design.
Sie läuft **portabel** aus einem Ordner oder im **Docker-Container** (z. B. auf CachyOS).

## Start

**Portabel (Linux, CachyOS, Windows)**
```sh
./start.sh            # Linux / CachyOS
start.bat             # Windows
```
Beim ersten Start installiert das Skript die Pakete (`npm install`) und öffnet http://localhost:7777.
Dort legst du dann ein **Passwort** fest.

**Docker (CachyOS)**
```sh
PROJEKTE=~/Projekte docker compose up -d --build
```
Danach http://localhost:7777 öffnen. Für Zugriff aus dem LAN den Port in `docker-compose.yml` freigeben.

## Was drin ist

| Bereich | Werkzeug | Funktion |
|---|---|---|
| Arbeit | **Projekte** | Alle Ordner im Projektordner mit Git-Status, Skripten aus `package.json`, Docker-Compose und Klonen |
| | **Dateien** | Durchsuchen, bearbeiten (Strg+S), umbenennen, löschen, Bildvorschau, „KI fragen“ |
| | **Terminal** | Echte Shell (xterm + node-pty), mehrere Sitzungen, bleiben beim Neuladen erhalten |
| | **Prozesse** | Dev-Server und Builds starten/stoppen, Live-Log, Meldung, wenn ein Prozess fertig ist |
| | **Notizen** | Notizen und Aufgaben, allgemein oder pro Projekt |
| KI | **KI-Chat** | Chat oder **Agent im Projekt** (Dateien ändern / alles), mehrere Chats, Vorlagen |
| | **KI-Vergleich** | Eine Frage gleichzeitig an alle Modelle |
| | **Prompts** | Vorlagen-Bibliothek mit dem Platzhalter `{{eingabe}}` |
| | **KI-Konten** | Installieren, Anmelden, Abmelden und Nutzungsstatistik |
| System | **System** | CPU, RAM, Speicher, Docker-Container, Event-Bus |
| | **Einstellungen** | Projektordner, Standard-KI, Hell/Dunkel, Akzentfarbe, Passwort, Backup/Restore, Update |

Dazu kommen: Befehlspalette (**Strg+K**), Toasts und Desktop-Benachrichtigungen, Installation als App (PWA) und eine Ansicht für das Handy.

## KI-Modelle: Login mit deinem Abo, ohne API-Keys

Unter **KI-Konten** installierst du die CLI und meldest dich an. Die Anmeldung öffnet sich im Terminal der Zentrale.
Die Logins liegen in `data/auth/<modell>/`.

| Modell | CLI | Login |
|---|---|---|
| Claude | `claude` (Claude Code) | Claude Pro/Max |
| Codex | `codex` | ChatGPT Plus/Pro |
| Gemini | `gemini` | Google-Konto |
| Ollama | `ollama` | kein Login, läuft lokal |

Alternativ über die Kommandozeile: `./start.sh login claude`

**Agent-Modi im KI-Chat:**
- 💬 **Nur Chat:** Die KI antwortet nur.
- ✎ **Dateien ändern:** Die KI darf im gewählten Projekt Dateien bearbeiten.
- ⚠ **Alles:** Die KI darf zusätzlich beliebige Befehle ausführen. Nur nutzen, wenn du ihr vertraust.

## Ordner
```
server.js        Kern: Routen, Anmeldung, WebSocket
lib/             Dienste: ki, files, procs, terminal, system, auth, settings
ui/              Dashboard, theme.css (Design-Tokens), zentrale-sdk.js, md.js
core/            eingebaute Werkzeuge (Projekte, Terminal, KI-Chat …)
modules/         DEINE Apps – jeder Ordner ist ein Modul
modules/_vorlage Vorlage für neue Module
runtime/         portable Programme (node/, bin/), werden vor dem System-PATH gesucht
data/            Passwort, Einstellungen, Logins, Chats, Notizen (nicht im Git)
```

## Eigenes Modul bauen
```sh
node server.js new-module mein-tool "Mein Tool"
```
Das legt `modules/mein-tool/` aus der Vorlage an. Nach einem Neuladen erscheint es im Dashboard.
In jedem Modul steht `window.zentrale` zur Verfügung:

```js
zentrale.ki.ask({ provider, prompt, mode, project, onChunk })  // KI
zentrale.fs.list(pfad) / read(pfad) / write(pfad, inhalt)      // Dateien im Projektordner
zentrale.run.start({ cmd, project }) / follow(id, {onLine})    // Prozesse
zentrale.terminal.create({ project })                          // Terminal
zentrale.projects.list()                                       // Projekte
zentrale.store.get() / set(obj)                                // eigener Speicher
zentrale.store.get('prompts')                                  // gemeinsamer Speicher
zentrale.events.emit(typ, daten) / on(typ, fn)                 // Nachrichten zwischen Modulen
zentrale.notify('Fertig!', 'ok')                               // Toast
zentrale.open('terminal', { project: 'xyz' })                  // anderes Modul öffnen
zentrale.onParams(p => …)                                      // Parameter empfangen
```
Das Design übernimmst du mit `<link rel="stylesheet" href="/theme.css">`. Klassen: `btn`, `btn primary`, `input`, `card`, `page`, `grid`, `row`, `toolbar`, `badge`, `log` …

## Sicherheit
- Ohne Passwort kommt niemand rein. Nach 5 Fehlversuchen ist die Anmeldung 1 Minute gesperrt.
- Dateizugriff ist auf den Projektordner beschränkt, auch über symbolische Links lässt er sich nicht verlassen.
- Standardmäßig lauscht die Zentrale nur auf `127.0.0.1`. Fürs LAN `HOST=0.0.0.0` setzen.
- Passwort vergessen: `node server.js reset-password`
