"""Text aus Dokumenten lesen – TXT, PDF, Office, OpenDocument, optional OCR."""
import html
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

from .paths import HOME, WIN, tool

MAX = 20000
TEXT = {"txt", "md", "csv", "log", "json", "xml", "html", "htm", "ini", "py", "js", "yaml", "yml", "rtf"}
OFFICE = {"docx": ["word/document.xml"], "xlsx": ["xl/sharedStrings.xml"], "pptx": ["ppt/slides/"],
          "odt": ["content.xml"], "ods": ["content.xml"], "odp": ["content.xml"]}
OCR_IMG = {"png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"}
_NOWIN = 0x08000000 if WIN else 0


def _xml_text(data):
    data = re.sub(r"</(w:p|a:p|text:p|si)>", "\n", data)
    return html.unescape(re.sub(r"<[^>]+>", " ", data))


def _clean(s):
    return re.sub(r"[ \t\r\f\v]+", " ", s).strip()[:MAX]


def ocr(path):
    exe = tool("tesseract")
    if not exe:
        return ""
    tess = HOME / "tools" / "tesseract" / "tessdata"
    langs = "deu+eng"
    if tess.is_dir():
        have = {p.stem for p in tess.glob("*.traineddata")}
        langs = "+".join(l for l in ("deu", "eng") if l in have) or "eng"
    cmd = [exe, str(path), "stdout", "-l", langs]
    env = None
    if tess.is_dir():
        import os
        env = dict(os.environ, TESSDATA_PREFIX=str(tess))
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=120, env=env, creationflags=_NOWIN)
        return r.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _pdf(path, use_ocr):
    text = ""
    try:
        from pypdf import PdfReader
        r = PdfReader(str(path))
        for page in r.pages[:30]:
            text += (page.extract_text() or "") + "\n"
            if len(text) > MAX:
                break
    except Exception:
        pass
    if len(text.strip()) < 20 and use_ocr:  # gescanntes PDF
        try:
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(str(path))
            with tempfile.TemporaryDirectory() as td:
                for i in range(min(3, len(doc))):
                    img = Path(td) / f"s{i}.png"
                    doc[i].render(scale=2).to_pil().save(img)
                    text += ocr(img) + "\n"
        except Exception:
            pass
    return text


def extract_text(path, ext=None, use_ocr=False):
    p = Path(path)
    ext = (ext or p.suffix.lstrip(".")).lower()
    try:
        if ext in TEXT:
            with open(p, "rb") as f:
                return _clean(f.read(MAX * 2).decode("utf-8", "replace"))
        if ext in OFFICE:
            out = []
            with zipfile.ZipFile(p) as z:
                for name in sorted(z.namelist()):
                    if any(name == w or (w.endswith("/") and name.startswith(w) and name.endswith(".xml"))
                           for w in OFFICE[ext]):
                        out.append(_xml_text(z.read(name).decode("utf-8", "replace")))
            return _clean("\n".join(out))
        if ext == "pdf":
            return _clean(_pdf(p, use_ocr))
        if ext in OCR_IMG and use_ocr:
            return _clean(ocr(p))
    except Exception:
        return ""
    return ""
