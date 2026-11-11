"""Praxistest im fertigen portablen Ordner: alle Werkzeuge und beide Assistenten."""
import os
import sys
import tempfile
from pathlib import Path

home = Path(sys.argv[1]).resolve()
os.environ["MRPG_HOME"] = str(home)
os.environ["MRPG_DATA"] = tempfile.mkdtemp()
sys.path.insert(0, str(home / "app"))
from organizer import assist, core, extract, media, paths  # noqa: E402

ok = True


def check(name, cond, info=""):
    global ok
    print(("OK   " if cond else "FEHLT") + f" {name} {info}")
    ok &= bool(cond)


for t, sub in (("ffmpeg", ""), ("tesseract", ""), ("llama-server", "llama")):
    p = paths.tool(t, sub)
    check(t, p and str(home) in p, p)
check("Modelle", paths.model("sortier") and paths.model("such"))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
d = Path(tempfile.mkdtemp())
im = Image.new("RGB", (900, 200), "white")
ImageDraw.Draw(im).text((20, 60), "RECHNUNG STADTWERKE", fill="black", font=ImageFont.load_default(size=60))
im.save(d / "scan.png")
txt = extract.ocr(d / "scan.png")
check("OCR", "RECHNUNG" in txt.upper(), repr(txt[:40]))
im.save(d / "a.jpg")
im.resize((450, 100)).save(d / "b.jpg")
check("Ähnliche Bilder (FFmpeg)", media._ffmpeg_frame(str(d / "a.jpg"), False) is not None)
check("Ähnliche Bilder", len(media.find_similar(core.scan(d))) == 1)

prs = [{"name": "Hausbau", "folder": "C:\\Projekte\\Hausbau", "keywords": "Dach Ziegel Rohbau"},
       {"name": "Auto", "folder": "C:\\Projekte\\Auto", "keywords": "Werkstatt Reifen"}]
f = {"name": "angebot.txt", "rel": "angebot.txt"}
s = assist.suggest_project(f, "Angebot des Dachdeckers für neue Ziegel am Haus", prs, True)
check("Sortierassistent", s and s["by"] == "sortierassistent" and s["project"] == "Hausbau", s)
files = [{"path": "/1", "name": "x.txt", "rel": "x.txt"}, {"path": "/2", "name": "y.txt", "rel": "y.txt"}]
r = assist.build_index(files, {"/1": "Abrechnung der Stadtwerke für Elektrizität", "/2": "Rezept Apfelkuchen"}, True)
check("Suchassistent Index", r["mode"] == "suchassistent", r)
res = assist.search("Stromkosten", use_assistant=True)
check("Suchassistent Suche", res["mode"] == "suchassistent" and res["results"] and res["results"][0]["path"] == "/1", res)
assist.shutdown()
sys.exit(0 if ok else 1)
