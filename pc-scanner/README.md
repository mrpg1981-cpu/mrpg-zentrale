# MRPG PC-Scanner

Durchsucht den PC, sammelt alle Markdown-Dateien und listet auf, was an
KI-Werkzeugen und Projekten installiert ist.

## Starten

**Windows:** `scan-starten.bat` doppelklicken (Python muss installiert sein).

**Terminal:**

```
python pc_scanner.py              # nur das Benutzerverzeichnis
python pc_scanner.py C:\ D:\      # ganze Laufwerke
python pc_scanner.py --github     # zusätzlich GitHub durchsuchen
python pc_scanner.py --out bericht --no-open
```

## GitHub-Suche (`--github`)

Mit `--github` durchsucht der Scanner zusätzlich öffentliche GitHub-Repos nach
**Skills, Agenten, MCP-Servern und Tools**. Jeder Treffer bekommt im Bericht
unter dem Reiter „GitHub" drei Links:

- **Auf GitHub öffnen** – die Projektseite.
- **ZIP herunterladen** – das Projekt als ZIP-Archiv.
- **Clone-Link** – kopiert `git clone …` in die Zwischenablage.

Ohne Anmeldung erlaubt GitHub nur wenige Suchanfragen pro Minute. Für mehr
Treffer kann ein Token übergeben werden:

```
python pc_scanner.py --github --github-token DEIN_TOKEN
# oder per Umgebungsvariable:
set GITHUB_TOKEN=DEIN_TOKEN        (Windows)
export GITHUB_TOKEN=DEIN_TOKEN     (Linux/Mac)
```

Ohne Internet wird der GitHub-Teil einfach übersprungen, der PC-Scan läuft
trotzdem durch.

## Was gefunden wird

- **Projekte** – Ordner mit Git, Node, Python, Rust, Go, Java, PHP, Docker usw.
- **MCP-Server** – aus Claude Desktop, Claude Code, Cursor, Windsurf, VS Code,
  Gemini, Continue und allen `.mcp.json`-Dateien.
- **Agenten** – Dateien in `agents/`-Ordnern.
- **Skills** – nur echte `SKILL.md`; Hilfsdateien erscheinen unter „Alle MD".
- **Commands** – Dateien in `commands/`- oder `prompts/`-Ordnern.
- **Plugins** – mit und ohne Manifest (`plugin.json`/`marketplace.json`).
- **Tools/CLIs** – Kommandozeilen-Tools aus npm-Paketen.
- **Regeln** – `CLAUDE.md`, `AGENTS.md`, `.cursorrules` usw.
- **Zugänge** – siehe unten.
- **GitHub** – mit `--github`: Skills/Agenten/MCP/Tools aus öffentlichen Repos
  mit Download-Links (siehe unten).
- **Alle MD** – jede Markdown-Datei mit Volltextsuche.

Systemordner (`/usr`, `/opt`, `/mnt`, `Windows`, `Program Files`, Caches,
`node_modules` …) werden übersprungen – außer man gibt sie selbst als Startpunkt an.

## Zugänge – was NICHT passiert

Die Zugangs-Übersicht zeigt nur, **dass** ein Zugang existiert: SSH-Hostnamen
aus `~/.ssh/config`, Benutzernamen, die Anzahl bekannter Server und die Namen
vorhandener Schlüsseldateien.

Es werden **ausdrücklich keine privaten Schlüssel und keine Passwörter**
gelesen, kopiert oder gespeichert. Der Scanner ist ein Inventar-Werkzeug, kein
Passwort-Sammler.

Wenn du von überall auf alle deine PCs zugreifen willst, nutze dafür
SSH-Schlüssel (öffentlicher Teil auf die Zielrechner) zusammen mit einem
privaten Netz wie Tailscale oder WireGuard und einem Passwort-Manager –
nicht eine offene Liste kopierter Geheimnisse.

## Ergebnis

Im Ausgabeordner (Standard `pc-scan-bericht/`):

- `bericht.html` – öffnet sich im Browser, mit Suchfeld und Reitern.
- `alle_md.md` – alle Markdown-Dateien in einer Datei.
- `bericht.json` – die Rohdaten.
