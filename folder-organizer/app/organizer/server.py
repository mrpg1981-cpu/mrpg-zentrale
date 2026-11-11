"""Lokaler Webserver (nur 127.0.0.1) mit JSON-API und Oberfläche."""
import json
import os
import string
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import VERSION, assist, core, extract, media
from .paths import APP_DIR, WIN, data_dir, model, tool

UI = APP_DIR / "ui" / "index.html"
DOCS = {"pdf", "doc", "docx", "odt", "rtf", "txt", "md", "xlsx", "ods", "csv", "pptx", "odp"}


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.job = {"running": False, "step": "", "error": "", "kind": ""}
        self.result = None  # {root, files, duplicates, similar, empty, plan}

    def progress(self, msg):
        self.job["step"] = msg


S = State()


def run_job(kind, fn):
    with S.lock:
        if S.job["running"]:
            raise RuntimeError("Es läuft bereits ein Vorgang.")
        S.job = {"running": True, "step": "Start …", "error": "", "kind": kind, "last": None}

    def work():
        try:
            S.job["last"] = fn()
            S.job["step"] = "Fertig"
        except Exception as e:  # Fehler sichtbar machen statt abstürzen
            S.job["error"] = str(e)
            traceback.print_exc()
        finally:
            S.job["running"] = False
    threading.Thread(target=work, daemon=True).start()


def do_scan(root, opt):
    root = str(Path(root).expanduser().resolve())
    st = assist.load_settings()
    p = S.progress
    p("Dateien einlesen …")
    files = core.scan(root, p)
    dups = core.find_duplicates(files, p) if opt.get("duplicates", True) else []
    dup_paths = {x for g in dups for x in g["files"]}
    similar = media.find_similar(files, int(st.get("similar_threshold", 8)), p, exclude=dup_paths) \
        if opt.get("similar", True) else []
    empty = core.find_empty_dirs(root) if opt.get("empty", True) else []
    texts = {}
    if opt.get("content", True):
        docs = [f for f in files if f["ext"] in DOCS or (st.get("ocr") and f["ext"] in extract.OCR_IMG)]
        for i, f in enumerate(docs):
            if i % 10 == 0:
                p(f"Inhalte lesen {i}/{len(docs)}")
            if f["size"] < 50 * 1024 * 1024:
                texts[f["path"]] = extract.extract_text(f["path"], f["ext"], bool(st.get("ocr")))
    proj = {}
    prs = assist.projects(st, root)
    if opt.get("projects", True) and prs:
        cands = [f for f in files if f["path"] not in dup_paths and
                 (f["path"] in texts or f["category"] in ("Bilder", "Videos"))][:400]
        prfolders = {os.path.normcase(x["folder"]) for x in prs}
        for i, f in enumerate(cands):
            if any(os.path.normcase(f["path"]).startswith(d + os.sep) for d in prfolders if d):
                continue  # liegt schon in einem Projekt
            p(f"Sortierassistent {i}/{len(cands)}")
            s = assist.suggest_project(f, texts.get(f["path"], ""), prs, st.get("use_assistant", True))
            if s:
                proj[f["path"]] = s
    rules = core.load_rules() if opt.get("rules", True) else []
    plan = core.build_plan(root, files, rules, dups, empty, texts, proj)
    if opt.get("index", True):
        p("Suchindex erstellen …")
        assist.build_index(files, texts, st.get("use_assistant", True), p)
    S.result = {"root": root, "files": len(files), "bytes": sum(f["size"] for f in files),
                "duplicates": dups, "similar": similar, "empty": empty, "plan": plan,
                "projects": proj}
    return {"files": len(files), "actions": len(plan)}


def status():
    return {"version": VERSION, "job": S.job, "has_result": S.result is not None,
            "tools": {"ffmpeg": bool(tool("ffmpeg")), "ocr": bool(tool("tesseract")),
                      "sortierassistent": assist.available("sortier"),
                      "suchassistent": assist.available("such")},
            "data": str(data_dir())}


def browse(path):
    if not path:
        if WIN:
            roots = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
        else:
            roots = ["/", str(Path.home())]
        return {"path": "", "parent": "", "dirs": roots}
    p = Path(path).expanduser().resolve()
    dirs = []
    try:
        for d in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            if d.is_dir() and not d.name.startswith((".", "$")):
                dirs.append(str(d))
    except OSError:
        pass
    parent = str(p.parent) if p.parent != p else ""
    return {"path": str(p), "parent": parent, "dirs": dirs}


def reveal(path):
    p = Path(path)
    target = p if p.is_dir() else p.parent
    if WIN:
        if p.is_file():
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            os.startfile(str(target))  # noqa
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _ok_origin(self):
        # Schutz: nur Anfragen von der eigenen Oberfläche annehmen
        o = self.headers.get("Origin")
        return not o or o.startswith(("http://127.0.0.1:", "http://localhost:"))

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path in ("/", "/index.html"):
                return self._send(200, UI.read_bytes(), "text/html; charset=utf-8")
            if u.path == "/api/status":
                return self._send(200, status())
            if u.path == "/api/result":
                return self._send(200, S.result or {})
            if u.path == "/api/rules":
                return self._send(200, core.load_rules())
            if u.path == "/api/settings":
                return self._send(200, assist.load_settings())
            if u.path == "/api/history":
                return self._send(200, core.history())
            if u.path == "/api/browse":
                return self._send(200, browse(q.get("path", "")))
            self._send(404, {"error": "Nicht gefunden"})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def do_POST(self):
        if not self._ok_origin():
            return self._send(403, {"error": "Fremde Herkunft abgelehnt"})
        u = urlparse(self.path).path
        try:
            b = self._body()
            if u == "/api/scan":
                if not b.get("root") or not Path(b["root"]).expanduser().is_dir():
                    return self._send(400, {"error": "Bitte einen vorhandenen Ordner wählen."})
                run_job("scan", lambda: do_scan(b["root"], b.get("options") or {}))
                return self._send(200, {"ok": True})
            if u == "/api/plan/update":
                if not S.result:
                    return self._send(400, {"error": "Kein Scan vorhanden"})
                ids = b.get("ids") or [b.get("id")]
                for a in S.result["plan"]:
                    if a["id"] in ids:
                        if "enabled" in b:
                            a["enabled"] = bool(b["enabled"])
                        if b.get("dst") and a["kind"] == "move":
                            d = Path(b["dst"])
                            if not d.is_absolute():
                                d = Path(S.result["root"]) / d
                            a["dst"] = str(d)
                return self._send(200, {"ok": True})
            if u == "/api/execute":
                if not S.result:
                    return self._send(400, {"error": "Kein Scan vorhanden"})
                plan, root = S.result["plan"], S.result["root"]

                def ex():
                    batch = core.execute(plan, root, S.progress)
                    S.result = None  # Dateien haben sich geändert → neu scannen
                    return {"batch": batch["id"], "done": len(batch["done"]),
                            "skipped": [{"src": s["action"]["src"], "why": s["why"]} for s in batch["skipped"]]}
                run_job("execute", ex)
                return self._send(200, {"ok": True})
            if u == "/api/undo":
                return self._send(200, core.undo(b["batch"]))
            if u == "/api/rules":
                core.save_rules(b if isinstance(b, list) else b.get("rules", []))
                return self._send(200, {"ok": True})
            if u == "/api/rules/reset":
                core.save_rules([dict(r) for r in core.DEFAULT_RULES])
                return self._send(200, core.load_rules())
            if u == "/api/settings":
                s = assist.load_settings()
                s.update(b)
                assist.save_settings(s)
                return self._send(200, s)
            if u == "/api/search":
                st = assist.load_settings()
                return self._send(200, assist.search(b.get("query", ""), 40, st.get("use_assistant", True)))
            if u == "/api/reveal":
                reveal(b["path"])
                return self._send(200, {"ok": True})
            self._send(404, {"error": "Nicht gefunden"})
        except RuntimeError as e:
            self._send(409, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": str(e)})


def make_server(port=0):
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
