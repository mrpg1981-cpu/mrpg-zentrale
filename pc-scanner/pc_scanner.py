#!/usr/bin/env python3
"""MRPG PC-Scanner: liest den PC aus, sammelt alle .md-Dateien und erkennt
MCP-Server, Agenten, Skills, Tools/Plugins und Projekte. Zusätzlich erstellt
er eine SICHERE Zugangs-Übersicht (nur SSH-Hostnamen, Benutzer und Pfade) —
es werden ausdrücklich KEINE privaten Schlüssel und KEINE Passwörter gelesen
oder gespeichert.

Mit --github durchsucht er zusätzlich öffentliche GitHub-Repos nach Skills,
Agenten, MCP-Servern und Tools und stellt zu jedem Treffer Download-/Clone-Links
bereit.

Nutzung:
    python pc_scanner.py                 # scannt das Home-Verzeichnis
    python pc_scanner.py C:\\ D:\\        # scannt bestimmte Laufwerke/Ordner
    python pc_scanner.py --github        # zusätzlich GitHub durchsuchen
    python pc_scanner.py --out bericht   # Ausgabeordner festlegen

Vorinstallierte Systemordner (/usr, /opt, /mnt, ... bzw. Windows/Program Files)
werden übersprungen, außer sie werden selbst als Startpunkt angegeben.

Ergebnis: bericht.html (zum Durchsuchen im Browser), bericht.json, alle_md.md
"""
import argparse
import datetime
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

# GitHub-Suche: Suchbegriffe je Kategorie. Treffer bekommen einen Download-/Clone-Link.
GITHUB_QUERIES = {
    "skills": "claude skill SKILL.md",
    "agents": "claude code subagent agent",
    "mcp": "mcp server model context protocol",
    "tools": "claude code plugin tool",
}

SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env", ".tox",
    "site-packages", "dist-packages", "dist", "build", ".next", ".cache", "cache", "Cache",
    "$Recycle.Bin", "System Volume Information", "Windows", "WinSxS",
    "Program Files", "Program Files (x86)", "ProgramData", "AppData\\Local\\Temp",
    "proc", "sys", "dev", "snap", "Library", ".Trash", ".npm", ".gradle",
    ".m2", ".cargo", ".rustup", "target", "vendor", "third_party", "gems",
}
# Ganze Pfad-Anfänge, die übersprungen werden (vorinstallierte Systemsoftware).
# Entfällt automatisch, wenn der Nutzer gezielt so einen Ordner als Startpunkt angibt.
SKIP_PREFIXES_UNIX = ("/usr", "/opt", "/mnt", "/snap", "/var", "/lib", "/boot",
                      "/run", "/srv", "/proc", "/sys", "/dev")
# Ordner, die trotz Punkt am Anfang gescannt werden (hier stecken Agenten/MCP/Skills)
KEEP_HIDDEN = {".claude", ".cursor", ".vscode", ".codex", ".continue", ".github",
               ".windsurf", ".gemini", ".aider", ".roo", ".cline", ".config"}

PROJECT_MARKERS = {
    ".git": "Git", "package.json": "Node/JS", "pyproject.toml": "Python",
    "requirements.txt": "Python", "setup.py": "Python", "Cargo.toml": "Rust",
    "go.mod": "Go", "pom.xml": "Java/Maven", "build.gradle": "Java/Gradle",
    "composer.json": "PHP", "Gemfile": "Ruby", "CMakeLists.txt": "C/C++",
    "pubspec.yaml": "Flutter/Dart", "Dockerfile": "Docker",
}
MCP_CONFIG_NAMES = {".mcp.json", "mcp.json", "claude_desktop_config.json",
                    "mcp_config.json", "mcp_settings.json", "cline_mcp_settings.json"}
MAX_MD_BYTES = 200_000


def mcp_config_candidates():
    home = Path.home()
    appdata = Path(os.environ.get("APPDATA", home / "AppData/Roaming"))
    return [
        home / ".claude.json", home / ".claude/settings.json",
        home / ".cursor/mcp.json", home / ".codeium/windsurf/mcp_config.json",
        home / ".gemini/settings.json", home / ".continue/config.json",
        appdata / "Claude/claude_desktop_config.json",
        home / "Library/Application Support/Claude/claude_desktop_config.json",
        home / ".config/Claude/claude_desktop_config.json",
        appdata / "Code/User/settings.json", appdata / "Code/User/mcp.json",
        home / ".config/Code/User/settings.json", home / ".config/Code/User/mcp.json",
    ]


def read_text(p, limit=MAX_MD_BYTES):
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    data = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                data[k.strip()] = v.strip().strip('"\'')
    return data


def first_heading(text):
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return m.group(1).strip() if m else ""


def find_mcp_servers(obj, source, out, path=""):
    """Sucht rekursiv nach 'mcpServers' / 'servers' Blöcken in JSON."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("mcpServers", "mcp_servers") or (k == "servers" and "mcp" in source.lower()):
                if isinstance(v, dict):
                    for name, cfg in v.items():
                        cfg = cfg if isinstance(cfg, dict) else {}
                        cmd = cfg.get("command") or cfg.get("url") or cfg.get("serverUrl") or ""
                        args = " ".join(map(str, cfg.get("args", []))) if isinstance(cfg.get("args"), list) else ""
                        out.append({"name": name, "command": f"{cmd} {args}".strip(),
                                    "source": source, "scope": path or "global"})
            else:
                find_mcp_servers(v, source, out, k if k.startswith(("/", "C:", "c:")) else path)
    elif isinstance(obj, list):
        for v in obj:
            find_mcp_servers(v, source, out, path)


def load_json(p):
    try:
        return json.loads(read_text(p, 5_000_000))
    except (ValueError, TypeError):
        return None


def github_search(per_category=8, token=None):
    """Durchsucht öffentliche GitHub-Repos nach Skills, Agenten, MCP-Servern und
    Tools. Liefert je Kategorie eine Liste mit Name, Beschreibung, Sternen und
    Download-/Clone-Links. Ohne Internet oder bei einem Fehler: leeres Ergebnis.

    Mit einem Token (Parameter oder Umgebungsvariable GITHUB_TOKEN) sind mehr
    Anfragen pro Minute möglich; ohne Token reicht es für einen Durchlauf.
    """
    token = token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "mrpg-pc-scanner"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # Falls hinter einem Proxy mit eigenem Zertifikat gearbeitet wird (z. B. Firmen-
    # netz oder diese Cloud-Umgebung), dessen CA-Bundle verwenden, sonst Standard.
    import ssl
    ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    for cand in ("/root/.ccr/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt"):
        if not ca and os.path.isfile(cand):
            ca = cand
    try:
        ctx = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    except OSError:
        ctx = ssl.create_default_context()
    found = {}
    for cat, query in GITHUB_QUERIES.items():
        url = ("https://api.github.com/search/repositories?q="
               + urllib.parse.quote(query)
               + f"&sort=stars&order=desc&per_page={per_category}")
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            hint = {403: " (Rate-Limit – mit --github-token mehr Anfragen)",
                    401: " (Token ungültig)"}.get(e.code, "")
            print(f"  GitHub-Suche '{cat}' übersprungen: HTTP {e.code}{hint}.")
            found[cat] = []
            continue
        except (urllib.error.URLError, ValueError, OSError) as e:
            print(f"  GitHub-Suche '{cat}' übersprungen ({e.__class__.__name__} – kein Internet?).")
            found[cat] = []
            continue
        items = []
        for it in data.get("items", []):
            items.append({
                "name": it.get("full_name", ""),
                "description": (it.get("description") or "")[:300],
                "stars": it.get("stargazers_count", 0),
                "language": it.get("language") or "",
                "url": it.get("html_url", ""),
                "clone": it.get("clone_url", ""),
                "zip": f"{it.get('html_url','')}/archive/refs/heads/{it.get('default_branch','main')}.zip",
                "category": cat,
            })
        found[cat] = items
        print(f"  GitHub '{cat}': {len(items)} Repos gefunden.")
    return found


def collect_access_overview():
    """Liefert eine SICHERE Übersicht konfigurierter Zugänge: nur Hostnamen,
    Benutzernamen und Pfade. Es werden KEINE privaten Schlüssel und KEINE
    Passwörter gelesen oder gespeichert — nur, DASS ein Zugang existiert."""
    home = Path.home()
    out = []
    # ~/.ssh/config -> Host-Einträge (keine Schlüsselinhalte)
    cfg = home / ".ssh" / "config"
    if cfg.is_file():
        host = user = hostname = None
        for raw in read_text(cfg, 200_000).splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition(" ")
            k = key.lower()
            if k == "host":
                if host:
                    out.append({"type": "SSH-Host", "name": host, "user": user or "",
                                "hostname": hostname or "", "source": str(cfg)})
                host, user, hostname = val.strip(), None, None
            elif k == "hostname":
                hostname = val.strip()
            elif k == "user":
                user = val.strip()
        if host:
            out.append({"type": "SSH-Host", "name": host, "user": user or "",
                        "hostname": hostname or "", "source": str(cfg)})
    # known_hosts -> wie viele bekannte Server (nur Anzahl, keine Inhalte)
    kh = home / ".ssh" / "known_hosts"
    if kh.is_file():
        try:
            n = sum(1 for ln in open(kh, encoding="utf-8", errors="replace") if ln.strip())
            out.append({"type": "known_hosts", "name": f"{n} bekannte Server", "user": "",
                        "hostname": "", "source": str(kh)})
        except OSError:
            pass
    # Vorhandene Schlüsseldateien -> nur Name/Pfad vermerken, Inhalt NICHT lesen
    ssh_dir = home / ".ssh"
    if ssh_dir.is_dir():
        for f in sorted(ssh_dir.glob("*.pub")):
            out.append({"type": "SSH-Key (öffentlich)", "name": f.name, "user": "",
                        "hostname": "", "source": str(f)})
        for f in sorted(ssh_dir.glob("id_*")):
            if not f.name.endswith(".pub"):
                out.append({"type": "SSH-Key vorhanden", "name": f.name,
                            "user": "(Inhalt nicht gelesen)", "hostname": "", "source": str(f)})
    return out


def classify_md(p, text):
    """Ordnet eine .md-Datei einer Art zu.

    Nur eine Datei namens SKILL.md gilt als echter Skill; andere .md-Dateien in
    einem Skill-Ordner sind Hilfsdateien ('skill-ref') und werden getrennt gezählt.
    """
    parts = [x.lower() for x in p.parts]
    name = p.name.lower()
    fm = frontmatter(text)
    in_agents = "agents" in parts
    if name == "skill.md":
        return "skill", fm
    if in_agents:
        return "agent", fm
    if "commands" in parts or "prompts" in parts:
        return "command", fm
    if name in ("claude.md", "agents.md", "gemini.md", ".cursorrules", "copilot-instructions.md") \
            or "rules" in parts:
        return "rules", fm
    if "skills" in parts:
        return "skill-ref", fm
    return "doc", fm


def walk(roots, progress):
    # Systemordner nur überspringen, wenn der Nutzer sie nicht selbst als Start wählte
    explicit = {str(Path(r).resolve()) for r in roots}

    def is_system(path):
        rp = str(Path(path).resolve())
        if rp in explicit or any(rp.startswith(e + os.sep) and e in explicit for e in explicit):
            return False
        return rp.startswith(SKIP_PREFIXES_UNIX)

    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS and (not d.startswith(".") or d in KEEP_HIDDEN or d == ".git")
                           and not is_system(os.path.join(dirpath, d))]
            progress(dirpath)
            yield Path(dirpath), dirnames, filenames


def scan(roots, with_github=False, github_token=None, on_progress=None):
    res = {"md": [], "skills": [], "agents": [], "commands": [], "rules": [],
           "mcp": [], "plugins": [], "projects": [], "tools": [], "access": [],
           "github": {}}
    git_roots = set()
    count = [0]

    def progress(d):
        count[0] += 1
        if on_progress is not None:
            on_progress(count[0], d)
        if count[0] % 500 == 0:
            print(f"\r  {count[0]} Ordner gescannt ...", end="", flush=True)

    res["access"] = collect_access_overview()

    if with_github:
        print("Suche auf GitHub nach Skills, Agenten, MCP-Servern und Tools ...")
        res["github"] = github_search(token=github_token)

    seen_cfg = set()
    for p in mcp_config_candidates():
        if p.is_file():
            seen_cfg.add(str(p.resolve()))
            data = load_json(p)
            if data is not None:
                find_mcp_servers(data, str(p), res["mcp"])
                if isinstance(data, dict) and isinstance(data.get("enabledPlugins"), dict):
                    for plug, on in data["enabledPlugins"].items():
                        res["plugins"].append({"name": plug, "enabled": on, "source": str(p)})

    plugin_dirs = set()
    for d, dirnames, files in walk(roots, progress):
        fileset = set(files) | set(dirnames)
        # Plugin ohne Manifest: Ordner unterhalb eines 'plugins'-Pfads mit skills/ oder commands/
        parts_low = [x.lower() for x in d.parts]
        if "plugins" in parts_low and ("skills" in dirnames or "commands" in dirnames) \
                and str(d) not in plugin_dirs and d.name.lower() not in ("plugins", "synced"):
            plugin_dirs.add(str(d))
            if not any(p.get("source", "").startswith(str(d)) for p in res["plugins"]):
                res["plugins"].append({"name": d.name, "description": "(ohne Manifest erkannt)", "source": str(d)})
        markers = [t for m, t in PROJECT_MARKERS.items() if m in fileset]
        if markers:
            info = {"name": d.name, "path": str(d), "types": sorted(set(markers)), "description": ""}
            if "package.json" in files:
                pj = load_json(d / "package.json") or {}
                info["description"] = pj.get("description", "")
                if pj.get("bin"):
                    res["tools"].append({"name": pj.get("name", d.name), "kind": "npm CLI", "path": str(d)})
            readme = next((f for f in files if f.lower() == "readme.md"), None)
            if readme and not info["description"]:
                info["description"] = first_heading(read_text(d / readme, 4000))
            # Unterpakete innerhalb eines bereits erkannten Git-Repos nicht erneut zählen
            if not any(info["path"] == g or info["path"].startswith(g + os.sep) for g in git_roots):
                res["projects"].append(info)
                if "Git" in info["types"]:
                    git_roots.add(info["path"])

        for f in files:
            fp = d / f
            low = f.lower()
            if low in MCP_CONFIG_NAMES and str(fp.resolve()) not in seen_cfg:
                data = load_json(fp)
                if data is not None:
                    find_mcp_servers(data, str(fp), res["mcp"])
            if low in ("plugin.json", "marketplace.json"):
                pj = load_json(fp) or {}
                base = d.parent if d.name == ".claude-plugin" else d
                res["plugins"].append({"name": pj.get("name", base.name),
                                       "description": pj.get("description", ""), "source": str(fp)})
            if low.endswith((".md", ".mdc", ".markdown")):
                text = read_text(fp)
                kind, fm = classify_md(fp, text)
                try:
                    st = fp.stat()
                    size, mtime = st.st_size, datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes")
                except OSError:
                    size, mtime = 0, ""
                entry = {"path": str(fp), "title": fm.get("name") or first_heading(text) or f,
                         "description": fm.get("description", "")[:300], "kind": kind,
                         "size": size, "modified": mtime, "text": text}
                res["md"].append(entry)
                bucket = {"skill": "skills", "agent": "agents", "command": "commands", "rules": "rules"}.get(kind)
                if bucket:
                    res[bucket].append({k: entry[k] for k in ("title", "description", "path")})
    print()
    return res


def build_light(res, roots):
    """Baut die kompakte Ergebnisstruktur (ohne die großen MD-Volltexte) für
    JSON-Datei und HTML-Bericht. Fügt pro MD-Datei einen Suchauszug ('snippet')
    für die Volltextsuche hinzu."""
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    light = {k: v for k, v in res.items() if k not in ("md", "github")}
    light["md"] = []
    for m in res["md"]:
        item = {k: v for k, v in m.items() if k != "text"}
        item["snippet"] = m.get("text", "")[:3000]
        light["md"].append(item)
    # GitHub-Treffer aller Kategorien zu einer flachen Liste zusammenführen
    light["github"] = [it for items in res.get("github", {}).values() for it in items]
    light["meta"] = {"scanned": stamp, "roots": [str(r) for r in roots]}
    return light


def write_reports(res, outdir, roots):
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # Alle MD-Dateien zu einer großen Datei zusammenführen
    with open(outdir / "alle_md.md", "w", encoding="utf-8") as f:
        f.write(f"# Alle Markdown-Dateien ({len(res['md'])}) – Stand {stamp}\n\n")
        for m in res["md"]:
            f.write(f"\n\n---\n\n## {m['title']}\n`{m['path']}` · {m['kind']} · {m['modified']}\n\n{m['text']}\n")

    light = build_light(res, roots)
    (outdir / "bericht.json").write_text(json.dumps(light, ensure_ascii=False, indent=1), encoding="utf-8")
    payload = json.dumps(light, ensure_ascii=False).replace("</", "<\\/")
    html_doc = HTML.replace("__SERVE__", "false").replace("__DATA__", payload)
    (outdir / "bericht.html").write_text(html_doc, encoding="utf-8")
    return outdir / "bericht.html"


def serve_report(roots, outdir, with_github=False, github_token=None, port=0, open_browser=True):
    """Startet einen lokalen Mini-Webserver, scannt im Hintergrund und zeigt den
    Fortschritt live in bericht.html. Am Ende kann das Ergebnis als JSON
    gespeichert werden. Läuft, bis das Browserfenster 'Beenden' sendet oder der
    Prozess abgebrochen wird."""
    import http.server
    import threading
    import time

    outdir.mkdir(parents=True, exist_ok=True)
    state = {"done": False, "count": 0, "current": "", "started": time.time(),
             "phase": "scan", "result": None, "error": None,
             "roots": [str(r) for r in roots]}
    stop = threading.Event()

    def worker():
        try:
            def on_progress(n, d):
                state["count"] = n
                state["current"] = str(d)
            res = scan(roots, with_github=with_github, github_token=github_token, on_progress=on_progress)
            state["phase"] = "write"
            write_reports(res, outdir, roots)          # schreibt auch bericht.json auf Platte
            state["result"] = build_light(res, roots)  # für den Browser-Download
        except Exception as e:  # Scan soll den Server nie abstürzen lassen
            state["error"] = f"{e.__class__.__name__}: {e}"
        finally:
            state["done"] = True

    html_doc = HTML.replace("__SERVE__", "true").replace("__DATA__", "null").encode("utf-8")

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # keine Konsolenausgabe pro Anfrage

        def _send(self, body, ctype="application/json; charset=utf-8", extra=None):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html", "/bericht.html"):
                self._send(html_doc, "text/html; charset=utf-8")
            elif path == "/api/status":
                self._send(json.dumps({"done": state["done"], "count": state["count"],
                                       "current": state["current"], "phase": state["phase"],
                                       "elapsed": int(time.time() - state["started"]),
                                       "error": state["error"], "roots": state["roots"]}).encode("utf-8"))
            elif path == "/api/result":
                body = json.dumps(state["result"] if state["result"] else {}, ensure_ascii=False).encode("utf-8")
                self._send(body)
            elif path in ("/bericht.json", "/download"):
                body = json.dumps(state["result"] if state["result"] else {}, ensure_ascii=False,
                                  indent=1).encode("utf-8")
                self._send(body, extra={"Content-Disposition": "attachment; filename=bericht.json"})
            else:
                self.send_error(404)

        def do_POST(self):
            if self.path.split("?", 1)[0] == "/api/shutdown":
                self._send(b'{"ok":true}')
                stop.set()
            else:
                self.send_error(404)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual = srv.server_address[1]
    url = f"http://127.0.0.1:{actual}/"
    threading.Thread(target=worker, daemon=True).start()
    print(f"MRPG PC-Scanner läuft im Hintergrund. Bericht im Browser: {url}")
    print("Zum Stoppen das Browserfenster 'Beenden' nutzen oder dieses Fenster schließen.")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    srv.timeout = 0.5
    while not stop.is_set():
        srv.handle_request()
    srv.server_close()
    return outdir / "bericht.html"


HTML = r"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>〄 MRPG PC-Scan</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2324272d'/%3E%3Ctext x='16' y='23' font-size='20' text-anchor='middle' fill='%2367f5ff' font-family='monospace'%3E%E3%80%84%3C/text%3E%3C/svg%3E">
<style>
/* MRPG-Design (mrpg.dev): dunkles Slate, Cyan-Akzent, Monospace-Marke */
:root{--bg:#2b2f36;--card:#24272d;--panel:#383c44;--fg:#f2f5f7;--mut:#b9bec7;--acc:#67f5ff;--bd:#59616d}
body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px;position:sticky;top:0;background:#24272d;border-bottom:1px solid var(--bd);z-index:10}
h1{margin:0 0 8px;font-size:20px;display:flex;align-items:center;gap:10px}
.brand{color:var(--acc);font:bold 18px/1 monospace}
input{width:100%;box-sizing:border-box;padding:10px;font-size:15px;border:1px solid var(--bd);border-radius:8px;background:var(--panel);color:var(--fg)}
input::placeholder{color:var(--mut)}
input:focus{outline:0;border-color:var(--acc)}
nav{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}nav button{border:1px solid var(--bd);background:var(--panel);color:var(--mut);padding:6px 10px;border-radius:999px;cursor:pointer;font-family:monospace}
nav button:hover{color:var(--acc);border-color:var(--acc)}
nav button.on{background:var(--acc);color:#111;border-color:var(--acc);font-weight:bold}
main{padding:16px;max-width:1100px;margin:auto}.it{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin:6px 0}
.it:hover{border-color:var(--acc)}
.t{font-weight:600}.p{color:var(--mut);font-size:12px;word-break:break-all;font-family:monospace}.d{margin-top:4px}.tag{font-size:11px;padding:1px 6px;border-radius:4px;background:#67f5ff22;color:var(--acc);margin-left:6px;font-family:monospace}
.lnk{display:inline-block;margin:6px 8px 0 0;padding:4px 10px;border-radius:6px;background:var(--acc);color:#111;text-decoration:none;font-size:12px;font-weight:bold}
.lnk.alt{background:transparent;color:var(--acc);border:1px solid var(--acc);font-weight:normal}
.bar{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.btn{border:0;background:var(--acc);color:#111;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:bold}
.btn.alt{background:var(--panel);color:var(--fg);border:1px solid var(--bd)}
.btn.alt:hover{border-color:var(--acc);color:var(--acc)}
#prog{max-width:1100px;margin:16px auto;padding:16px;background:var(--card);border:1px solid var(--bd);border-radius:10px}
#prog h2{margin:0 0 10px;font-size:16px;color:var(--acc);font-family:monospace}
.track{height:12px;border-radius:999px;background:var(--panel);overflow:hidden;margin:10px 0}
.fill{height:100%;width:30%;border-radius:999px;background:var(--acc);animation:slide 1.3s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.hide{display:none}
footer{max-width:1100px;margin:0 auto;padding:10px 16px;color:var(--mut);font:11px monospace;border-top:1px solid var(--bd)}
</style></head><body><header><h1><span class="brand">〄 MRPG</span> PC-Scan <span class="p" id="meta"></span></h1>
<div class="bar" id="toolbar"><button class="btn" id="dl">Als JSON speichern</button><button class="btn alt hide" id="stop">Beenden</button></div>
<input id="q" placeholder="Suchen in Namen, Pfaden, Beschreibungen und MD-Inhalten …"><nav id="tabs"></nav></header>
<section id="prog" class="hide"><h2>Durchsuche den PC …</h2><div id="pline" class="p"></div><div class="track"><div class="fill"></div></div><div id="pcur" class="p"></div></section>
<main id="list"></main>
<footer>MRPG · LOCAL-FIRST · mrpg.dev</footer>
<script>
let D=__DATA__;const SERVE=__SERVE__;
const cats=[["projects","Projekte"],["mcp","MCP-Server"],["agents","Agenten"],["skills","Skills"],["commands","Commands"],["plugins","Plugins"],["tools","Tools/CLIs"],["rules","Regeln (CLAUDE.md …)"],["access","Zugänge"],["github","GitHub (zum Download)"],["md","Alle MD"]];
let cur="projects";const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const $=id=>document.getElementById(id);
function row(c,x){const t=x.title||x.name;
if(c=="access"){const d=[x.user&&("Benutzer: "+x.user),x.hostname&&("Adresse: "+x.hostname)].filter(Boolean).join(" · ");
return `<div class="it"><div class="t">${esc(t)}<span class=tag>${esc(x.type)}</span></div>${d?`<div class=d>${esc(d)}</div>`:""}<div class="p">${esc(x.source)}</div></div>`}
if(c=="github"){return `<div class="it"><div class="t">${esc(x.name)}<span class=tag>${esc(x.category)}</span>${x.stars?`<span class=tag>★ ${x.stars}</span>`:""}${x.language?`<span class=tag>${esc(x.language)}</span>`:""}</div>${x.description?`<div class=d>${esc(x.description)}</div>`:""}<div><a class=lnk href="${esc(x.url)}" target=_blank rel=noopener>Auf GitHub öffnen</a><a class="lnk alt" href="${esc(x.zip)}" target=_blank rel=noopener>ZIP herunterladen</a><a class="lnk alt" href="${esc(x.url)}" target=_blank rel=noopener onclick="navigator.clipboard&&navigator.clipboard.writeText('git clone '+${JSON.stringify(x.clone)});return true">Clone-Link</a></div></div>`}
let d=x.description||x.command||(x.types||[]).join(", ")||"";if(c=="md")d=x.description||x.kind;
return `<div class="it"><div class="t">${esc(t)}${x.kind&&c=="md"?`<span class=tag>${esc(x.kind)}</span>`:""}${x.types&&c=="projects"?`<span class=tag>${esc(x.types.join(" · "))}</span>`:""}</div><div class="p">${esc(x.path||x.source)}</div>${d&&c!="projects"?`<div class=d>${esc(d)}</div>`:(x.description?`<div class=d>${esc(x.description)}</div>`:"")}</div>`}
function draw(){if(!D){return}const q=$("q").value.toLowerCase();
$("tabs").innerHTML=cats.map(([k,n])=>{const c=(D[k]||[]).filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q)).length;return `<button class="${k==cur?"on":""}" onclick="cur='${k}';draw()">${n} (${c})</button>`}).join("");
const items=(D[cur]||[]).filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q));
$("list").innerHTML=items.slice(0,2000).map(x=>row(cur,x)).join("")||"<p>Nichts gefunden.</p>"}
function showResult(){$("prog").classList.add("hide");$("q").classList.remove("hide");$("tabs").classList.remove("hide");
$("meta").textContent=(D.meta?D.meta.scanned+" · "+D.meta.roots.join(", "):"");draw()}
$("dl").onclick=function(){if(SERVE){location.href="/bericht.json";return}
const blob=new Blob([JSON.stringify(D,null,1)],{type:"application/json"});const a=document.createElement("a");
a.href=URL.createObjectURL(blob);a.download="bericht.json";a.click();URL.revokeObjectURL(a.href)};
$("q").oninput=draw;
if(SERVE){
  $("prog").classList.remove("hide");$("q").classList.add("hide");$("tabs").classList.add("hide");$("stop").classList.remove("hide");
  $("dl").textContent="Als JSON speichern (nach dem Scan)";
  $("stop").onclick=function(){fetch("/api/shutdown",{method:"POST"}).catch(()=>{});$("prog").innerHTML="<h2>Beendet. Das Fenster kann geschlossen werden.</h2>"};
  const poll=()=>fetch("/api/status").then(r=>r.json()).then(s=>{
    if(s.error){$("pline").textContent="Fehler: "+s.error}
    else{$("pline").textContent=s.count+" Ordner durchsucht · "+s.elapsed+" s"+(s.phase=="write"?" · schreibe Bericht …":"");$("pcur").textContent=s.current||""}
    if(s.done){fetch("/api/result").then(r=>r.json()).then(j=>{D=j;$("dl").textContent="Als JSON speichern";showResult()})}
    else{setTimeout(poll,700)}
  }).catch(()=>setTimeout(poll,1200));
  poll();
}else{showResult()}
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Scannt den PC nach MD-Dateien, MCP, Agenten, Skills, Tools und Projekten.")
    ap.add_argument("roots", nargs="*", help="Ordner/Laufwerke (Standard: Home-Verzeichnis)")
    ap.add_argument("--out", default="pc-scan-bericht", help="Ausgabeordner")
    ap.add_argument("--no-open", action="store_true", help="Browser nicht automatisch öffnen")
    ap.add_argument("--github", action="store_true",
                    help="Zusätzlich GitHub nach Skills/Agenten/MCP/Tools durchsuchen (mit Download-Links)")
    ap.add_argument("--github-token", default=None,
                    help="GitHub-Token für mehr Anfragen (sonst GITHUB_TOKEN-Umgebungsvariable)")
    ap.add_argument("--serve", action="store_true",
                    help="Im Hintergrund laufen und den Fortschritt live im Browser anzeigen")
    ap.add_argument("--port", type=int, default=0, help="Fester Port für --serve (Standard: frei wählen)")
    a = ap.parse_args()
    roots = [Path(r) for r in a.roots] or [Path.home()]

    if a.serve:
        serve_report(roots, Path(a.out), with_github=a.github, github_token=a.github_token,
                     port=a.port, open_browser=not a.no_open)
        return

    print("MRPG PC-Scanner – scanne:", ", ".join(map(str, roots)))
    res = scan(roots, with_github=a.github, github_token=a.github_token)
    report = write_reports(res, Path(a.out), roots)
    print("\nErgebnis:")
    for k, n in [("projects", "Projekte"), ("mcp", "MCP-Server"), ("agents", "Agenten"), ("skills", "Skills"),
                 ("commands", "Commands"), ("plugins", "Plugins"), ("tools", "Tools"), ("rules", "Regeln"),
                 ("access", "Zugänge"), ("md", "MD-Dateien")]:
        print(f"  {n:<12} {len(res[k])}")
    gh = sum(len(v) for v in res.get("github", {}).values())
    if a.github:
        print(f"  {'GitHub-Repos':<12} {gh}")
    print(f"\nBericht: {report.resolve()}")
    if not a.no_open:
        webbrowser.open(report.resolve().as_uri())


if __name__ == "__main__":
    sys.exit(main())
