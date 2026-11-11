"""Ähnliche Bilder und Videos über einen Bild-Fingerabdruck (dHash, 64 Bit)."""
import subprocess

from .paths import WIN, tool

IMAGE = {"jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "heic"}
VIDEO = {"mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "mpg", "mpeg"}
_NOWIN = 0x08000000 if WIN else 0  # CREATE_NO_WINDOW


def _dhash(pixels):  # 9x8 Graustufen → 64 Bit
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return bits


def _ffmpeg_frame(path, video):
    ff = tool("ffmpeg")
    if not ff:
        return None
    for seek in (["-ss", "3"] if video else []), []:
        cmd = [ff, "-v", "error", *seek, "-i", path, "-vf", "scale=9:8,format=gray",
               "-frames:v", "1", "-f", "rawvideo", "-"]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=_NOWIN).stdout
        except (OSError, subprocess.TimeoutExpired):
            return None
        if len(out) >= 72:
            return out[:72]
        if not video:
            break
    return None


def fingerprint(path, ext):
    if ext in IMAGE:
        try:
            from PIL import Image
            with Image.open(path) as im:
                return _dhash(im.convert("L").resize((9, 8)).tobytes())
        except Exception:
            pass
    px = _ffmpeg_frame(path, ext in VIDEO)
    return _dhash(px) if px else None


def find_similar(files, threshold=8, progress=None, exclude=()):
    """Gruppiert Medien mit ähnlichem Fingerabdruck (Hamming-Abstand ≤ threshold)."""
    media = [f for f in files if f["ext"] in IMAGE | VIDEO and f["path"] not in exclude]
    prints = []
    for i, f in enumerate(media):
        if progress and i % 20 == 0:
            progress(f"Medien vergleichen {i}/{len(media)}")
        h = fingerprint(f["path"], f["ext"])
        if h is not None:
            prints.append((f, h, f["ext"] in VIDEO))
    parent = list(range(len(prints)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(prints)):
        for j in range(i + 1, len(prints)):
            if prints[i][2] == prints[j][2] and bin(prints[i][1] ^ prints[j][1]).count("1") <= threshold:
                parent[find(i)] = find(j)
    groups = {}
    for i, (f, h, v) in enumerate(prints):
        groups.setdefault(find(i), []).append(f["path"])
    return [{"kind": "ähnlich", "files": sorted(g)} for g in groups.values() if len(g) > 1]
