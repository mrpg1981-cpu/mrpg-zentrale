"""Pfade im portablen Ordner und mitgelieferte Werkzeuge finden."""
import os
import shutil
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
HOME = Path(os.environ.get("MRPG_HOME") or APP_DIR.parent).resolve()
WIN = sys.platform.startswith("win")


def data_dir() -> Path:
    d = Path(os.environ.get("MRPG_DATA") or HOME / "daten")
    d.mkdir(parents=True, exist_ok=True)
    return d


def tool(name: str, sub: str = "") -> str | None:
    """Mitgeliefertes Werkzeug bevorzugen, sonst Systemprogramm."""
    exe = name + (".exe" if WIN else "")
    for base in (HOME / "tools" / (sub or name), HOME / "tools" / (sub or name) / "bin", HOME / "tools"):
        p = base / exe
        if p.is_file():
            return str(p)
    return shutil.which(name)


def model(kind: str) -> str | None:
    """Erstes .gguf-Modell in assistenten/<kind>/."""
    d = HOME / "assistenten" / kind
    if d.is_dir():
        for p in sorted(d.glob("*.gguf")):
            return str(p)
    return None
