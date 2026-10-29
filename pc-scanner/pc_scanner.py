#!/usr/bin/env python3
"""MRPG PC-Scanner: liest den PC aus, sammelt alle .md-Dateien und erkennt
MCP-Server, Agenten, Skills, Tools/Plugins und Projekte.

Nutzung:
    python pc_scanner.py                 # scannt das Home-Verzeichnis
    python pc_scanner.py C:\\ D:\\        # scannt bestimmte Laufwerke/Ordner
    python pc_scanner.py --out bericht   # Ausgabeordner festlegen

Ergebnis: bericht.html (zum Durchsuchen im Browser), bericht.json, alle_md.md
"""
import argparse
import datetime
import html
import json
import os
import re
import sys
import webbrowser
from pathlib import Path

SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env", ".tox",
    "site-packages", "dist", "build", ".next", ".cache", "cache", "Cache",
    "$Recycle.Bin", "System Volume Information", "Windows", "WinSxS",
    "Program Files", "Program Files (x86)", "ProgramData", "AppData\\Local\\Temp",
    "proc", "sys", "dev", "snap", "Library", ".Trash", ".npm", ".gradle",
    ".m2", ".cargo", ".rustup", "target", "vendor",
}
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


def classify_md(p, text):
    """Ordnet eine .md-Datei als Skill, Agent, Command, Regeln oder Doku ein."""
    parts = [x.lower() for x in p.parts]
    name = p.name.lower()
    fm = frontmatter(text)
    if name == "skill.md" or "skills" in parts:
        return "skill", fm
    if "agents" in parts:
        return "agent", fm
    if "commands" in parts or "prompts" in parts:
        return "command", fm
    if name in ("claude.md", "agents.md", "gemini.md", ".cursorrules", "copilot-instructions.md") \
            or "rules" in parts:
        return "rules", fm
    return "doc", fm


def walk(roots, progress):
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: None):
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS and (not d.startswith(".") or d in KEEP_HIDDEN or d == ".git")]
            progress(dirpath)
            yield Path(dirpath), dirnames, filenames


def scan(roots):
    res = {"md": [], "skills": [], "agents": [], "commands": [], "rules": [],
           "mcp": [], "plugins": [], "projects": [], "tools": []}
    count = [0]

    def progress(d):
        count[0] += 1
        if count[0] % 500 == 0:
            print(f"\r  {count[0]} Ordner gescannt ...", end="", flush=True)

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

    for d, dirnames, files in walk(roots, progress):
        fileset = set(files) | set(dirnames)
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
            # nur oberste Projektebene zählen, keine Unterpakete in bereits erkannten Repos
            if not any(info["path"].startswith(pr["path"] + os.sep) for pr in res["projects"][-50:]
                       if "Git" in pr["types"]):
                res["projects"].append(info)

        for f in files:
            fp = d / f
            low = f.lower()
            if low in MCP_CONFIG_NAMES and str(fp.resolve()) not in seen_cfg:
                data = load_json(fp)
                if data is not None:
                    find_mcp_servers(data, str(fp), res["mcp"])
            if low == "plugin.json" and d.name == ".claude-plugin":
                pj = load_json(fp) or {}
                res["plugins"].append({"name": pj.get("name", d.parent.name),
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
                if bucket and (kind != "skill" or low == "skill.md" or "skills" in [x.lower() for x in fp.parts]):
                    res[bucket].append({k: entry[k] for k in ("title", "description", "path")})
    print()
    return res


def write_reports(res, outdir, roots):
    outdir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # Alle MD-Dateien zu einer großen Datei zusammenführen
    with open(outdir / "alle_md.md", "w", encoding="utf-8") as f:
        f.write(f"# Alle Markdown-Dateien ({len(res['md'])}) – Stand {stamp}\n\n")
        for m in res["md"]:
            f.write(f"\n\n---\n\n## {m['title']}\n`{m['path']}` · {m['kind']} · {m['modified']}\n\n{m['text']}\n")

    light = {k: v for k, v in res.items() if k != "md"}
    light["md"] = [{k: v for k, v in m.items() if k != "text"} for m in res["md"]]
    light["meta"] = {"scanned": stamp, "roots": [str(r) for r in roots]}
    (outdir / "bericht.json").write_text(json.dumps(light, ensure_ascii=False, indent=1), encoding="utf-8")

    # Suchtext für die Volltextsuche im HTML (gekürzt)
    for m in light["md"]:
        src = next(x for x in res["md"] if x["path"] == m["path"])
        m["snippet"] = src["text"][:3000]
    payload = json.dumps(light, ensure_ascii=False).replace("</", "<\\/")
    (outdir / "bericht.html").write_text(HTML.replace("__DATA__", payload), encoding="utf-8")
    return outdir / "bericht.html"


HTML = r"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MRPG PC-Scan</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#667;--acc:#2563eb;--bd:#dde}
@media(prefers-color-scheme:dark){:root{--bg:#111418;--card:#1b2027;--fg:#e6e8eb;--mut:#99a;--acc:#60a5fa;--bd:#2c333d}}
body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px;position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--bd)}
h1{margin:0 0 8px;font-size:20px}input{width:100%;box-sizing:border-box;padding:10px;font-size:15px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
nav{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}nav button{border:1px solid var(--bd);background:var(--card);color:var(--fg);padding:6px 10px;border-radius:999px;cursor:pointer}
nav button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
main{padding:16px;max-width:1100px;margin:auto}.it{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin:6px 0}
.t{font-weight:600}.p{color:var(--mut);font-size:12px;word-break:break-all}.d{margin-top:4px}.tag{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--bd);margin-left:6px}
</style></head><body><header><h1>MRPG PC-Scan <span class="p" id="meta"></span></h1>
<input id="q" placeholder="Suchen in Namen, Pfaden, Beschreibungen und MD-Inhalten …"><nav id="tabs"></nav></header><main id="list"></main>
<script>
const D=__DATA__;const cats=[["projects","Projekte"],["mcp","MCP-Server"],["agents","Agenten"],["skills","Skills"],["commands","Commands"],["plugins","Plugins"],["tools","Tools/CLIs"],["rules","Regeln (CLAUDE.md …)"],["md","Alle MD"]];
let cur="projects";const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
document.getElementById("meta").textContent=D.meta.scanned+" · "+D.meta.roots.join(", ");
function row(c,x){const t=x.title||x.name;let d=x.description||x.command||(x.types||[]).join(", ")||"";if(c=="md")d=x.description||x.kind;
return `<div class="it"><div class="t">${esc(t)}${x.kind&&c=="md"?`<span class=tag>${esc(x.kind)}</span>`:""}${x.types&&c=="projects"?`<span class=tag>${esc(x.types.join(" · "))}</span>`:""}</div><div class="p">${esc(x.path||x.source)}</div>${d&&c!="projects"?`<div class=d>${esc(d)}</div>`:(x.description?`<div class=d>${esc(x.description)}</div>`:"")}</div>`}
function draw(){const q=document.getElementById("q").value.toLowerCase();
document.getElementById("tabs").innerHTML=cats.map(([k,n])=>{const c=D[k].filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q)).length;return `<button class="${k==cur?"on":""}" onclick="cur='${k}';draw()">${n} (${c})</button>`}).join("");
const items=D[cur].filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q));
document.getElementById("list").innerHTML=items.slice(0,2000).map(x=>row(cur,x)).join("")||"<p>Nichts gefunden.</p>"}
document.getElementById("q").oninput=draw;draw();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Scannt den PC nach MD-Dateien, MCP, Agenten, Skills, Tools und Projekten.")
    ap.add_argument("roots", nargs="*", help="Ordner/Laufwerke (Standard: Home-Verzeichnis)")
    ap.add_argument("--out", default="pc-scan-bericht", help="Ausgabeordner")
    ap.add_argument("--no-open", action="store_true", help="Browser nicht automatisch öffnen")
    a = ap.parse_args()
    roots = [Path(r) for r in a.roots] or [Path.home()]
    print("MRPG PC-Scanner – scanne:", ", ".join(map(str, roots)))
    res = scan(roots)
    report = write_reports(res, Path(a.out), roots)
    print("\nErgebnis:")
    for k, n in [("projects", "Projekte"), ("mcp", "MCP-Server"), ("agents", "Agenten"), ("skills", "Skills"),
                 ("commands", "Commands"), ("plugins", "Plugins"), ("tools", "Tools"), ("rules", "Regeln"),
                 ("md", "MD-Dateien")]:
        print(f"  {n:<12} {len(res[k])}")
    print(f"\nBericht: {report.resolve()}")
    if not a.no_open:
        webbrowser.open(report.resolve().as_uri())


if __name__ == "__main__":
    sys.exit(main())
