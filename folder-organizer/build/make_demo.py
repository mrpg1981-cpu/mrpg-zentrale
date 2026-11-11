"""Erzeugt einen Demo-Ordner zum gefahrlosen Ausprobieren."""
import os
import sys
import zipfile
from pathlib import Path

out = Path(sys.argv[1] if len(sys.argv) > 1 else "Demo-Ordner")
out.mkdir(parents=True, exist_ok=True)


def w(rel, data, mtime=None):
    p = out / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    if mtime:
        os.utime(p, (mtime, mtime))


w("Stromrechnung_Mai.txt", "Rechnung Stadtwerke Strom Mai 2024, Betrag 84,20 EUR", 1_715_000_000)
w("Kopie von Stromrechnung_Mai.txt", "Rechnung Stadtwerke Strom Mai 2024, Betrag 84,20 EUR", 1_716_000_000)
w("Einkaufsliste.md", "Brot, Milch, Kaffee")
w("Notizen/Hausbau Angebot Dach.txt", "Angebot Dachdecker Hausbau Ziegel Dämmung")
w("Notizen/Werkstatt Reifen.txt", "Werkstatt: Winterreifen wechseln, Auto Inspektion")
w("tabelle.csv", "Monat;Umsatz\nJan;100\n")
with zipfile.ZipFile(out / "Bericht.docx", "w") as z:
    z.writestr("word/document.xml", "<w:document><w:p><w:t>Projektbericht Hausbau Rohbau</w:t></w:p></w:document>")
(out / "Leerer Ordner" / "auch leer").mkdir(parents=True, exist_ok=True)
try:
    from PIL import Image
    im = Image.new("RGB", (320, 240))
    im.putdata([((x * 2) % 256, (y * 3) % 256, (x + y) % 256) for y in range(240) for x in range(320)])
    im.save(out / "Urlaub.jpg", quality=92)
    im.resize((160, 120)).save(out / "Urlaub_klein.jpg", quality=60)
except ImportError:
    pass
print("Demo-Ordner:", out.resolve())
