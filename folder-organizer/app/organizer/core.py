"""Scan, Duplikate, leere Ordner, Regeln, Plan, Ausführen und Rücknahme.

Grundregeln: Ein Scan ändert nichts. Es wird nie überschrieben und nie
gelöscht – überzählige Dateien wandern in den Papierkorb-Ordner. Jede
Aktion steht im Protokoll und kann zurückgenommen werden.
"""
import fnmatch
import hashlib
import json
import os
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path

from .paths import data_dir

TRASH = "_MrPG-Papierkorb"
SKIP_DIRS = {"$RECYCLE.BIN", "System Volume Information", ".git", "node_modules",
             "__pycache__", TRASH, ".Trash", "$Recycle.Bin"}

CATEGORIES = {
    "Bilder": ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "tif", "tiff", "svg", "raw", "cr2", "nef"],
    "Videos": ["mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "mpg", "mpeg"],
    "Musik": ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"],
    "Dokumente": ["pdf", "doc", "docx", "odt", "rtf", "txt", "md"],
    "Tabellen": ["xls", "xlsx", "ods", "csv"],
    "Präsentationen": ["ppt", "pptx", "odp"],
    "Archive": ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
    "Programme": ["exe", "msi", "bat", "cmd", "appimage", "deb"],
}


def category(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            return cat
    return "Sonstiges"


# ---------------------------------------------------------------- Scan
def scan(root, progress=None, include_hidden=False):
    """Liefert alle Dateien unter root. Ändert nichts."""
    root = Path(root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Ordner nicht gefunden: {root}")
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS
                       and (include_hidden or not d.startswith("."))]
        for fn in filenames:
            if not include_hidden and fn.startswith("."):
                continue
            p = Path(dirpath) / fn
            try:
                st = p.lstat()
            except OSError:
                continue
            if not p.is_file() or p.is_symlink():
                continue
            files.append({"path": str(p), "rel": str(p.relative_to(root)), "name": fn,
                          "ext": p.suffix.lower().lstrip("."), "size": st.st_size,
                          "mtime": st.st_mtime, "category": category(p.suffix)})
            if progress and len(files) % 500 == 0:
                progress(f"{len(files)} Dateien gefunden")
    return files


def file_hash(path, limit=None, chunk=1 << 20):
    h = hashlib.sha256()
    read = 0
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk if limit is None else min(chunk, limit - read))
            if not b:
                break
            h.update(b)
            read += len(b)
            if limit is not None and read >= limit:
                break
    return h.hexdigest()


def find_duplicates(files, progress=None):
    """Exakte Duplikate: Größe → Anfangs-Hash → voller SHA-256."""
    by_size = {}
    for f in files:
        if f["size"] > 0:
            by_size.setdefault(f["size"], []).append(f)
    groups = []
    cands = [g for g in by_size.values() if len(g) > 1]
    for i, same in enumerate(cands):
        if progress and i % 50 == 0:
            progress(f"Duplikate prüfen {i}/{len(cands)}")
        partial = {}
        for f in same:
            try:
                partial.setdefault(file_hash(f["path"], 65536), []).append(f)
            except OSError:
                pass
        for g in partial.values():
            if len(g) < 2:
                continue
            full = {}
            for f in g:
                try:
                    full.setdefault(file_hash(f["path"]), []).append(f)
                except OSError:
                    pass
            for h, fs in full.items():
                if len(fs) > 1:
                    fs.sort(key=lambda x: (x["mtime"], len(x["path"]), x["path"]))
                    groups.append({"hash": h, "size": fs[0]["size"], "keep": fs[0]["path"],
                                   "files": [x["path"] for x in fs]})
    groups.sort(key=lambda g: -g["size"] * (len(g["files"]) - 1))
    return groups


def find_empty_dirs(root):
    """Ordner ohne Dateien (auch rekursiv), tiefste zuerst."""
    root = Path(root).resolve()
    empty = set()
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        p = Path(dirpath)
        if p == root or any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        if not filenames and all(str(p / d) in empty for d in dirnames):
            empty.add(str(p))
    return sorted(empty, key=lambda s: -s.count(os.sep))


# ---------------------------------------------------------------- Regeln
DEFAULT_RULES = [
    {"name": f"{cat} sortieren", "enabled": True, "ext": exts,
     "target": f"{cat}/{{year}}" if cat in ("Bilder", "Videos") else cat, "rename": ""}
    for cat, exts in CATEGORIES.items()
]


def load_rules():
    p = data_dir() / "regeln.json"
    if p.is_file():
        try:
            return json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            pass
    return [dict(r) for r in DEFAULT_RULES]


def save_rules(rules):
    (data_dir() / "regeln.json").write_text(json.dumps(rules, ensure_ascii=False, indent=2), "utf-8")


def rule_matches(rule, f, text=""):
    if not rule.get("enabled", True):
        return False
    exts = [e.lower().lstrip(".") for e in rule.get("ext") or []]
    if exts and f["ext"] not in exts:
        return False
    if rule.get("name_glob") and not fnmatch.fnmatch(f["name"].lower(), rule["name_glob"].lower()):
        return False
    if rule.get("min_size") and f["size"] < float(rule["min_size"]):
        return False
    if rule.get("older_than_days") and time.time() - f["mtime"] < float(rule["older_than_days"]) * 86400:
        return False
    if rule.get("contains"):
        if rule["contains"].lower() not in (text or "").lower():
            return False
    return True


def _safe(s):
    return "".join(c for c in str(s) if c not in '<>:"|?*\\/').strip() or "_"


def fill(template, f, project=""):
    d = datetime.fromtimestamp(f["mtime"])
    stem = Path(f["name"]).stem
    vals = {"year": d.strftime("%Y"), "month": d.strftime("%m"), "day": d.strftime("%d"),
            "date": d.strftime("%Y-%m-%d"), "name": _safe(stem), "ext": "." + f["ext"] if f["ext"] else "",
            "category": f["category"], "project": project or "Ohne Projekt"}
    out = template
    for k, v in vals.items():
        out = out.replace("{" + k + "}", v if k in ("ext", "name") else _safe(v))
    return out


def rule_target(rule, f, root, project=""):
    tgt = rule.get("target") or ""
    base = Path(fill(tgt, f, project)) if tgt else Path(f["path"]).parent.relative_to(root)
    if not base.is_absolute():
        base = Path(root) / base
    name = fill(rule["rename"], f, project) if rule.get("rename") else f["name"]
    return str(base / name)


# ---------------------------------------------------------------- Plan
def _action(kind, src, dst, reason, source, f=None):
    a = {"id": uuid.uuid4().hex[:10], "kind": kind, "src": src, "dst": dst,
         "reason": reason, "source": source, "enabled": True}
    if f is not None:
        a["size"], a["mtime"] = f["size"], f["mtime"]
    return a


def build_plan(root, files, rules=None, duplicates=None, empty_dirs=None, texts=None, projects=None):
    """Erzeugt bearbeitbare Vorschläge. Duplikate haben Vorrang vor Regeln."""
    root = str(Path(root).resolve())
    texts, projects = texts or {}, projects or {}
    by_path = {f["path"]: f for f in files}
    plan, used = [], set()
    for g in duplicates or []:
        for p in g["files"]:
            if p == g["keep"] or p not in by_path:
                continue
            rel = os.path.relpath(p, root)
            plan.append(_action("move", p, str(Path(root) / TRASH / rel),
                                f"Duplikat von {os.path.relpath(g['keep'], root)}", "duplikat", by_path[p]))
            used.add(p)
    for f in files:
        if f["path"] in used:
            continue
        proj = projects.get(f["path"], {})
        if proj.get("project") and proj.get("target"):
            dst = str(Path(proj["target"]) / f["name"])
            if os.path.normcase(dst) != os.path.normcase(f["path"]):
                plan.append(_action("move", f["path"], dst,
                                    f"Projekt {proj['project']}: {proj.get('why', '')}".strip(), "assistent", f))
                continue
        for r in rules or []:
            if rule_matches(r, f, texts.get(f["path"], "")):
                dst = rule_target(r, f, root, proj.get("project", ""))
                if os.path.normcase(dst) != os.path.normcase(f["path"]):
                    plan.append(_action("move", f["path"], dst, f"Regel: {r.get('name', '')}", "regel", f))
                break
    for d in empty_dirs or []:
        plan.append(_action("rmdir", d, "", "Leerer Ordner", "leer"))
    # gleiche Ziele innerhalb des Plans auflösen (kein gegenseitiges Überschreiben)
    seen = set()
    for a in plan:
        if a["kind"] != "move":
            continue
        a["dst"] = unique_target(a["dst"], seen)
        seen.add(os.path.normcase(a["dst"]))
    return plan


def unique_target(dst, taken=()):
    p = Path(dst)
    cand, i = p, 2
    while os.path.normcase(str(cand)) in taken or cand.exists():
        cand = p.with_name(f"{p.stem} ({i}){p.suffix}")
        i += 1
    return str(cand)


# ---------------------------------------------------------------- Ausführen
def journal_dir():
    d = data_dir() / "protokoll"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_journal(batch):
    p = journal_dir() / f"{batch['id']}.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(batch, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, p)


def execute(plan, root="", progress=None):
    """Führt aktivierte Aktionen aus. Konflikte und geänderte Dateien werden übersprungen."""
    batch = {"id": datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4],
             "time": time.time(), "root": str(root), "done": [], "skipped": [], "undone": False}
    actions = [a for a in plan if a.get("enabled", True)]
    for i, a in enumerate(actions):
        if progress:
            progress(f"{i + 1}/{len(actions)} ausführen")
        try:
            res = _do(a)
        except OSError as e:
            res = f"Fehler: {e}"
        if isinstance(res, dict):
            batch["done"].append(res)
        else:
            batch["skipped"].append({"action": a, "why": res})
        _write_journal(batch)  # nach jedem Schritt sichern – übersteht Abstürze
    return batch


def _do(a):
    src = Path(a["src"])
    if a["kind"] == "rmdir":
        if not src.is_dir():
            return "Ordner existiert nicht mehr"
        if any(src.iterdir()):
            return "Ordner ist nicht mehr leer"
        src.rmdir()
        return {"kind": "rmdir", "src": str(src)}
    dst = Path(a["dst"])
    if not src.is_file():
        return "Quelle existiert nicht mehr"
    st = src.stat()
    if "size" in a and (st.st_size != a["size"] or abs(st.st_mtime - a["mtime"]) > 2):
        return "Datei wurde seit dem Scan geändert"
    if dst.exists():
        return "Ziel ist bereits belegt – nichts überschrieben"
    created = []
    parent = dst.parent
    missing = []
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for d in reversed(missing):
        d.mkdir()
        created.append(str(d))
    shutil.move(str(src), str(dst))
    return {"kind": "move", "src": str(src), "dst": str(dst), "created": created}


def history():
    out = []
    for p in sorted(journal_dir().glob("*.json"), reverse=True):
        try:
            b = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": b["id"], "time": b["time"], "root": b.get("root", ""), "done": len(b["done"]),
                    "skipped": len(b["skipped"]), "undone": b.get("undone", False)})
    return out


def undo(batch_id):
    """Nimmt einen Vorgang zurück – funktioniert auch nach Neustart."""
    p = journal_dir() / f"{batch_id}.json"
    batch = json.loads(p.read_text("utf-8"))
    if batch.get("undone"):
        return {"restored": 0, "problems": ["Bereits zurückgenommen"]}
    restored, problems = 0, []
    for r in reversed(batch["done"]):
        try:
            if r["kind"] == "rmdir":
                Path(r["src"]).mkdir(parents=True, exist_ok=True)
                restored += 1
                continue
            src, dst = Path(r["src"]), Path(r["dst"])
            if not dst.exists():
                problems.append(f"Fehlt: {dst}")
                continue
            if src.exists():
                problems.append(f"Ursprungsort belegt: {src}")
                continue
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(dst), str(src))
            restored += 1
            for d in reversed(r.get("created", [])):
                try:
                    Path(d).rmdir()
                except OSError:
                    pass
        except OSError as e:
            problems.append(str(e))
    batch["undone"] = True
    batch["undo_problems"] = problems
    _write_journal(batch)
    return {"restored": restored, "problems": problems}
