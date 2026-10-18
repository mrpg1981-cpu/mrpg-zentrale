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
| KI | **KI-Team** | Mehrere KIs arbeiten zusammen, siehe unten |
| | **KI-Chat** | Chat oder **Agent im Projekt** (Dateien ändern / alles), mehrere Chats, Vorlagen |
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

## 🧭 Chef-KI und KI-Team: die KIs arbeiten zusammen

**Standard ist die Chef-KI**, im KI-Chat genauso wie im KI-Team. Sie bewertet jede Aufgabe und entscheidet möglichst sparsam:

| Entscheidung | Wann | Anfragen |
|---|---|---|
| **selbst** | Fragen, Erklärungen, kleine bis mittlere Aufgaben | 1 (die Antwort steckt schon in der Entscheidung) |
| **weiterleiten** | Ein anderes Modell ist klar besser oder günstiger, z. B. Codex für eine klar umrissene Code-Änderung oder Ollama für Einfaches ohne Abo-Verbrauch | 2 |
| **Team** | Große oder riskante Änderungen (Bauen) oder wichtige Entscheidungen (Zweitmeinung) | 3–6 |

Die Entscheidung samt Begründung steht in jeder Antwort.

**Rezepte im KI-Team** (auch einzeln wählbar):
| Rezept | Ablauf |
|---|---|
| **Planen → Bauen → Prüfen** | Planer → Umsetzer → **Tests** (kostenlos) → Prüfer mit `git diff`. Schlagen die Tests fehl, geht die Fehlermeldung direkt an den Umsetzer zurück, ohne Prüfer-Anfrage. Standard: 1 Nachbesserung |
| **Zweitmeinung** | Autor → Kritiker → Autor überarbeitet |
| **Diskussion** | Alle antworten, dann entscheidet ein Moderator. Standard: 1 Runde |
| **Eigene Kette** | Beliebige Schritte mit `{{aufgabe}}`, `{{vorher}}` und `{{schritt:N}}` |

Vor dem Start zeigt die Zentrale an, **wie viele Anfragen ungefähr** anfallen. Teams laufen auf dem Server weiter, auch wenn der Browser zu ist.
Tests werden automatisch erkannt: `npm test`, `pytest`, `cargo test` oder `go test`.
Aus eigenen Modulen: `zentrale.team.start({ recipe: 'chef', task, roles: { chef: 'claude' }, project, mode })`.

## ✧ Skills und ◆ Agenten: von allen KIs nutzbar

- **Skill** = eine wiederverwendbare Anleitung im Claude-Code-Format (`SKILL.md` mit `name` und `description`), z. B. Code-Review, Commit-Nachricht oder Logistik-Analyse.
- **Agent** = eine feste Rolle aus Anweisungen, Skills und Rechten, z. B. Code-Reviewer, Bug-Jäger oder Logistik-Assistent. Er ist **an kein Modell gebunden**, jede KI kann ihn ausführen.

| Wo | Wie |
|---|---|
| KI-Chat | Oben Agent und Skills wählen |
| Chef-KI | Kennt alle Agenten und Skills und gibt passende selbst weiter |
| KI-Team | Jede Rolle kann ein Agent sein, dazu Skills für alle Schritte |
| Eigene Module | `zentrale.agents.run('code-reviewer', { prompt })` oder `zentrale.ki.ask({ provider, skills: ['code-review'], prompt })` |

Mitgelieferte Vorlagen liegen in `library/`, eigene in `data/skills/` und `data/agents/`.

## Module mit eigenem Server (z. B. Commander)

```json
{ "name": "Commander", "icon": "⇄", "backend": { "cmd": "node server.js" } }
```
Beim ersten Öffnen erledigt die Zentrale Folgendes:
- Sie startet den Server des Moduls auf einem freien Port und übergibt diesen als `PORT`.
- Falls nötig, führt sie vorher `npm install` aus.
- Sie leitet `/m/<id>/…` an den Server des Moduls weiter. Der Zugriff ist durch das Zentrale-Passwort geschützt.

Der Server erscheint unter **Prozesse** mit Live-Log.
**Wichtig für eigene Apps:** im Frontend relative URLs verwenden (`fetch('api/…')` statt `fetch('/api/…')`).

## Ordner
```
server.js        Kern: Routen, Anmeldung, WebSocket
lib/             Dienste: ki, files, procs, terminal, system, auth, settings
ui/              Dashboard, theme.css (Design-Tokens), zentrale-sdk.js, md.js
core/            eingebaute Werkzeuge (Projekte, Terminal, KI-Chat …)
modules/         DEINE Apps – jeder Ordner ist ein Modul (z. B. commander/)
library/         mitgelieferte Skills und Agenten
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
