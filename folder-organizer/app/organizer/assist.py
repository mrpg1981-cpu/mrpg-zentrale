"""Sortierassistent (Projektvorschläge) und Suchassistent (Suche nach Inhalt).

Beide laufen vollständig lokal über den mitgelieferten llama-server. Fehlt er,
arbeiten sie mit einem Stichwort-Verfahren weiter – die Bedienung bleibt gleich.
"""
import atexit
import json
import math
import os
import re
import socket
import subprocess
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

from .paths import WIN, data_dir, model, tool

_NOWIN = 0x08000000 if WIN else 0
_procs = {}
_lock = threading.Lock()
STOP = set("und oder der die das ein eine einer mit von für auf ist im in zu den dem des the and of to a".split())


def tokens(s):
    return [t for t in re.findall(r"[a-zA-ZäöüÄÖÜß0-9]{3,}", (s or "").lower()) if t not in STOP]


# ---------------------------------------------------------------- Dienst
def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(url, body, timeout=120):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def available(kind):
    return bool(tool("llama-server", "llama") and model(kind))


def service(kind):
    """Startet den Assistenten bei Bedarf und liefert seine Adresse (oder None)."""
    with _lock:
        p = _procs.get(kind)
        if p and p[0].poll() is None:
            return p[1]
        exe, m = tool("llama-server", "llama"), model(kind)
        if not (exe and m):
            return None
        port = _free_port()
        cmd = [exe, "-m", m, "--host", "127.0.0.1", "--port", str(port), "-c", "4096",
               "-t", str(max(1, (os.cpu_count() or 2) - 1))]
        if kind == "such":
            cmd += ["--embedding", "-ub", "2048", "-b", "2048"]
        log = open(data_dir() / f"assistent-{kind}.log", "w")
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, creationflags=_NOWIN)
        url = f"http://127.0.0.1:{port}"
        for _ in range(240):
            if proc.poll() is not None:
                return None
            try:
                with urllib.request.urlopen(url + "/health", timeout=2) as r:
                    if r.status == 200:
                        _procs[kind] = (proc, url)
                        return url
            except Exception:
                pass
            time.sleep(0.5)
        proc.kill()
        return None


@atexit.register
def shutdown():
    for proc, _ in _procs.values():
        try:
            proc.terminate()
        except OSError:
            pass


# ---------------------------------------------------------------- Projekte
def load_settings():
    p = data_dir() / "einstellungen.json"
    s = {"projects": [], "project_root": "", "use_assistant": True, "ocr": False, "similar_threshold": 8}
    if p.is_file():
        try:
            s.update(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return s


def save_settings(s):
    (data_dir() / "einstellungen.json").write_text(json.dumps(s, ensure_ascii=False, indent=2), "utf-8")


def projects(settings, root=None):
    """Projektliste aus Einstellungen plus Unterordnern des Projektordners."""
    out = {}
    for pr in settings.get("projects") or []:
        if pr.get("name"):
            out[pr["name"]] = {"name": pr["name"], "folder": pr.get("folder") or "",
                               "keywords": pr.get("keywords") or ""}
    pr_root = settings.get("project_root")
    if pr_root and Path(pr_root).is_dir():
        for d in sorted(Path(pr_root).iterdir()):
            if d.is_dir() and not d.name.startswith((".", "_")) and d.name not in out:
                out[d.name] = {"name": d.name, "folder": str(d), "keywords": ""}
    for pr in out.values():
        if not pr["folder"]:
            base = pr_root or (str(Path(root) / "Projekte") if root else "")
            pr["folder"] = str(Path(base) / pr["name"]) if base else ""
    return list(out.values())


def _keyword_guess(f, text, prs):
    words = Counter(tokens(f["name"]) * 3 + tokens(text[:4000]))
    best, score = None, 0
    for pr in prs:
        keys = set(tokens(pr["name"]) + tokens(pr["keywords"]))
        s = sum(words[k] for k in keys)
        if s > score:
            best, score = pr, s
    if best and score >= 2:
        return {"project": best["name"], "target": best["folder"], "why": "Stichworte passen",
                "by": "stichwort"}
    return None


def suggest_project(f, text, prs, use_assistant=True):
    """Ordnet eine Datei einem bekannten Projekt zu – nie einem erfundenen."""
    if not prs:
        return None
    url = service("sortier") if use_assistant else None
    if url:
        names = [p["name"] for p in prs]
        schema = {"type": "object", "properties": {
            "projekt": {"type": "string", "enum": names + ["keins"]},
            "grund": {"type": "string", "maxLength": 120}}, "required": ["projekt", "grund"]}
        desc = "\n".join(f"- {p['name']}" + (f" (Stichworte: {p['keywords']})" if p["keywords"] else "")
                         for p in prs)
        prompt = (f"Projekte:\n{desc}\n\nDatei: {f['rel']}\nInhalt (Auszug):\n{text[:1500]}\n\n"
                  "Zu welchem Projekt gehört die Datei? Nur bei klarer Zuordnung ein Projekt wählen, "
                  "sonst 'keins'. Antworte als JSON.")
        try:
            r = _post(url + "/v1/chat/completions", {
                "messages": [{"role": "system", "content": "Du sortierst Dateien in Projekte. Antworte knapp auf Deutsch."},
                             {"role": "user", "content": prompt}],
                "temperature": 0, "max_tokens": 120,
                "response_format": {"type": "json_object", "schema": schema}}, timeout=180)
            ans = json.loads(r["choices"][0]["message"]["content"])
            name = ans.get("projekt")
            if name in names:
                pr = prs[names.index(name)]
                return {"project": name, "target": pr["folder"], "why": str(ans.get("grund", ""))[:120],
                        "by": "sortierassistent"}
            if name == "keins":
                return None
        except Exception:
            pass
    return _keyword_guess(f, text, prs)


# ---------------------------------------------------------------- Suche
def _index_path():
    return data_dir() / "suchindex.json"


def _embed(url, texts):
    out = []
    for i in range(0, len(texts), 16):
        r = _post(url + "/v1/embeddings", {"input": texts[i:i + 16]}, timeout=300)
        out += [d["embedding"] for d in sorted(r["data"], key=lambda d: d["index"])]
    return out


def build_index(files, texts, use_assistant=True, progress=None):
    entries = []
    for f in files:
        t = texts.get(f["path"], "")
        entries.append({"path": f["path"], "name": f["name"], "rel": f["rel"],
                        "text": (f["rel"] + "\n" + t)[:3000]})
    url = service("such") if use_assistant else None
    mode = "stichwort"
    if url and entries:
        try:
            if progress:
                progress("Suchassistent liest Inhalte …")
            vecs = _embed(url, ["search_document: " + e["text"][:1500] for e in entries])
            for e, v in zip(entries, vecs):
                n = math.sqrt(sum(x * x for x in v)) or 1
                e["vec"] = [round(x / n, 5) for x in v]
            mode = "suchassistent"
        except Exception:
            pass
    idx = {"time": time.time(), "mode": mode, "entries": entries}
    _index_path().write_text(json.dumps(idx, ensure_ascii=False), "utf-8")
    return {"count": len(entries), "mode": mode}


def search(query, limit=30, use_assistant=True):
    p = _index_path()
    if not p.is_file():
        return {"results": [], "mode": "", "hint": "Noch kein Suchindex – erst einen Ordner einlesen."}
    idx = json.loads(p.read_text("utf-8"))
    ents = idx["entries"]
    q = tokens(query)
    n = len(ents) or 1
    df = Counter(t for e in ents for t in set(tokens(e["text"])))
    kw = []
    for e in ents:
        tf = Counter(tokens(e["text"]))
        kw.append(sum(tf[t] / (tf[t] + 1.2) * math.log(1 + n / (1 + df[t])) for t in q)
                  + (2 if query.lower() in e["name"].lower() else 0))
    mx = max(kw) if kw and max(kw) > 0 else 1
    scores = [k / mx for k in kw]
    mode = "stichwort"
    if idx.get("mode") == "suchassistent" and use_assistant:
        url = service("such")
        if url:
            try:
                qv = _embed(url, ["search_query: " + query])[0]
                nq = math.sqrt(sum(x * x for x in qv)) or 1
                qv = [x / nq for x in qv]
                scores = [0.7 * sum(a * b for a, b in zip(qv, e.get("vec", []))) + 0.3 * s
                          for e, s in zip(ents, scores)]
                mode = "suchassistent"
            except Exception:
                pass
    ranked = sorted(zip(scores, ents), key=lambda x: -x[0])
    res = []
    for s, e in ranked[:limit]:
        if s <= (0.25 if mode == "suchassistent" else 0):
            continue
        snip = e["text"]
        pos = min([snip.lower().find(t) for t in q if t in snip.lower()] or [0])
        res.append({"path": e["path"], "rel": e["rel"], "score": round(s, 3),
                    "snippet": snip[max(0, pos - 60):pos + 180].replace("\n", " ")})
    return {"results": res, "mode": mode}
