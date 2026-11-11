"""Startpunkt: python main.py [--port N] [--no-browser]"""
import argparse
import os
import sys
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from organizer import VERSION  # noqa: E402
from organizer.server import make_server  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="MrPG Folder Organizer")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    try:
        srv = make_server(a.port)
    except OSError:
        srv = make_server(0)
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"〄 MrPG Folder Organizer {VERSION} läuft auf {url}")
    print("Dieses Fenster offen lassen. Beenden mit Strg+C oder Fenster schließen.")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
