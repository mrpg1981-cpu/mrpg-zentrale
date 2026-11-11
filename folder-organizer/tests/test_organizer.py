import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
_DATA = tempfile.mkdtemp()
os.environ["MRPG_DATA"] = _DATA

from organizer import assist, core, extract, media  # noqa: E402


def write(p, data=b"x", mtime=None):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode())
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


def snapshot(root):
    return sorted((str(p.relative_to(root)), p.stat().st_size) for p in Path(root).rglob("*"))


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        for p in Path(_DATA).glob("**/*.json"):
            p.unlink()


class TestScan(Base):
    def test_scan_changes_nothing(self):
        write(self.root / "a.jpg", b"1")
        write(self.root / "sub" / "b.pdf", b"22")
        (self.root / "leer" / "tiefer").mkdir(parents=True)
        before = snapshot(self.root)
        files = core.scan(self.root)
        core.find_duplicates(files)
        core.find_empty_dirs(self.root)
        self.assertEqual(len(files), 2)
        self.assertEqual(before, snapshot(self.root))

    def test_skips_trash_and_hidden(self):
        write(self.root / core.TRASH / "x.txt")
        write(self.root / ".git" / "y")
        write(self.root / "z.txt")
        self.assertEqual([f["name"] for f in core.scan(self.root)], ["z.txt"])

    def test_missing_root(self):
        with self.assertRaises(FileNotFoundError):
            core.scan(self.root / "gibtsnicht")


class TestDuplicates(Base):
    def test_exact_groups_keep_oldest(self):
        write(self.root / "neu.txt", b"gleich" * 100, mtime=2_000_000_000)
        write(self.root / "alt.txt", b"gleich" * 100, mtime=1_000_000_000)
        write(self.root / "anders.txt", b"anders" * 100)
        write(self.root / "leer1.txt", b"")
        write(self.root / "leer2.txt", b"")
        g = core.find_duplicates(core.scan(self.root))
        self.assertEqual(len(g), 1)
        self.assertTrue(g[0]["keep"].endswith("alt.txt"))

    def test_same_start_different_end(self):
        write(self.root / "a.bin", b"A" * 70000 + b"1")
        write(self.root / "b.bin", b"A" * 70000 + b"2")
        self.assertEqual(core.find_duplicates(core.scan(self.root)), [])


class TestEmpty(Base):
    def test_nested_empty(self):
        (self.root / "e1" / "e2").mkdir(parents=True)
        write(self.root / "voll" / "f.txt")
        (self.root / "voll" / "leer").mkdir()
        e = core.find_empty_dirs(self.root)
        names = {Path(x).name for x in e}
        self.assertEqual(names, {"e1", "e2", "leer"})
        self.assertLess(e.index(str(self.root / "e1" / "e2")), e.index(str(self.root / "e1")))


class TestRules(Base):
    def test_default_rules_and_placeholders(self):
        write(self.root / "foto.JPG", mtime=1_700_000_000)
        f = core.scan(self.root)
        plan = core.build_plan(self.root, f, core.DEFAULT_RULES)
        self.assertEqual(plan[0]["dst"], str(self.root.resolve() / "Bilder" / "2023" / "foto.JPG"))

    def test_rename_and_conditions(self):
        write(self.root / "rechnung_mai.pdf", mtime=1_700_000_000)
        f = core.scan(self.root)[0]
        r = {"name": "R", "ext": ["pdf"], "name_glob": "rechnung*", "target": "Finanzen/{year}",
             "rename": "{date}_{name}{ext}"}
        self.assertTrue(core.rule_matches(r, f))
        self.assertTrue(core.rule_target(r, f, str(self.root)).endswith(
            os.path.join("Finanzen", "2023", "2023-11-14_rechnung_mai.pdf")))
        self.assertFalse(core.rule_matches({**r, "contains": "Strom"}, f, "Wasser"))
        self.assertTrue(core.rule_matches({**r, "contains": "strom"}, f, "Stromrechnung"))
        self.assertFalse(core.rule_matches({**r, "enabled": False}, f))

    def test_already_in_place_no_action(self):
        write(self.root / "Dokumente" / "a.pdf")
        plan = core.build_plan(self.root, core.scan(self.root), core.DEFAULT_RULES)
        self.assertEqual(plan, [])

    def test_plan_targets_unique(self):
        write(self.root / "x" / "a.pdf", b"1")
        write(self.root / "y" / "a.pdf", b"2")
        plan = core.build_plan(self.root, core.scan(self.root), core.DEFAULT_RULES)
        self.assertEqual(len({a["dst"] for a in plan}), 2)

    def test_rules_persist(self):
        core.save_rules([{"name": "nur", "ext": ["txt"], "target": "T"}])
        self.assertEqual(core.load_rules()[0]["name"], "nur")


class TestExecute(Base):
    def plan(self):
        files = core.scan(self.root)
        return core.build_plan(self.root, files, core.DEFAULT_RULES, core.find_duplicates(files),
                               core.find_empty_dirs(self.root))

    def test_execute_and_undo_after_restart(self):
        write(self.root / "a.jpg", b"bild", mtime=1_700_000_000)
        write(self.root / "kopie" / "a.jpg", b"bild", mtime=1_800_000_000)
        write(self.root / "doc.pdf", b"pdf")
        (self.root / "leer").mkdir()
        before = snapshot(self.root)
        batch = core.execute(self.plan(), self.root)
        self.assertEqual(batch["skipped"], [])
        self.assertTrue((self.root / core.TRASH / "kopie" / "a.jpg").exists())
        self.assertTrue((self.root / "Dokumente" / "doc.pdf").exists())
        self.assertFalse((self.root / "leer").exists())
        # "Neustart": nur das Protokoll auf der Platte zählt
        res = core.undo(batch["id"])
        self.assertEqual(res["problems"], [])
        self.assertEqual(before, snapshot(self.root))
        self.assertTrue(core.history()[0]["undone"])
        self.assertEqual(core.undo(batch["id"])["restored"], 0)

    def test_never_overwrites(self):
        write(self.root / "doc.pdf", b"neu")
        plan = self.plan()
        write(self.root / "Dokumente" / "doc.pdf", b"bestehend")
        b = core.execute(plan, self.root)
        self.assertEqual(len(b["skipped"]), 1)
        self.assertIn("belegt", b["skipped"][0]["why"])
        self.assertEqual((self.root / "Dokumente" / "doc.pdf").read_bytes(), b"bestehend")
        self.assertTrue((self.root / "doc.pdf").exists())

    def test_changed_file_skipped(self):
        write(self.root / "doc.pdf", b"alt")
        plan = self.plan()
        write(self.root / "doc.pdf", b"geaendert!")
        b = core.execute(plan, self.root)
        self.assertIn("geändert", b["skipped"][0]["why"])

    def test_disabled_and_edited_target(self):
        write(self.root / "a.pdf")
        write(self.root / "b.pdf", b"bb")
        plan = self.plan()
        plan[0]["enabled"] = False
        plan[1]["dst"] = str(self.root / "Eigen" / "neu.pdf")
        b = core.execute(plan, self.root)
        self.assertEqual(len(b["done"]), 1)
        self.assertTrue((self.root / "Eigen" / "neu.pdf").exists())

    def test_undo_removes_created_dirs(self):
        write(self.root / "a.pdf")
        b = core.execute(self.plan(), self.root)
        core.undo(b["id"])
        self.assertFalse((self.root / "Dokumente").exists())

    def test_undo_does_not_overwrite(self):
        write(self.root / "a.pdf", b"1")
        b = core.execute(self.plan(), self.root)
        write(self.root / "a.pdf", b"neu angelegt")
        r = core.undo(b["id"])
        self.assertEqual(r["restored"], 0)
        self.assertEqual((self.root / "a.pdf").read_bytes(), b"neu angelegt")


class TestExtract(Base):
    def test_text_and_office(self):
        write(self.root / "a.txt", "Hallo Welt")
        d = self.root / "b.docx"
        with zipfile.ZipFile(d, "w") as z:
            z.writestr("word/document.xml", "<w:document><w:p><w:t>Angebot Müller &amp; Co</w:t></w:p></w:document>")
        x = self.root / "c.xlsx"
        with zipfile.ZipFile(x, "w") as z:
            z.writestr("xl/sharedStrings.xml", "<sst><si><t>Umsatz</t></si></sst>")
        self.assertEqual(extract.extract_text(self.root / "a.txt"), "Hallo Welt")
        self.assertIn("Angebot Müller & Co", extract.extract_text(d))
        self.assertIn("Umsatz", extract.extract_text(x))
        write(self.root / "kaputt.docx", b"keinzip")
        self.assertEqual(extract.extract_text(self.root / "kaputt.docx"), "")

    def test_pdf(self):
        try:
            from pypdf import PdfWriter  # noqa
        except ImportError:
            self.skipTest("pypdf fehlt")
        p = self.root / "t.pdf"
        content = b"BT /F1 24 Tf 72 700 Td (Rechnung Strom) Tj ET"
        objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
                b"<< /Length %d >>stream\n" % len(content) + content + b"\nendstream",
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
        out, offs = b"%PDF-1.4\n", []
        for i, o in enumerate(objs, 1):
            offs.append(len(out))
            out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
        x = len(out)
        out += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(b"%010d 00000 n \n" % o for o in offs)
        out += b"trailer << /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % x
        p.write_bytes(out)
        self.assertIn("Rechnung Strom", extract.extract_text(p))


class TestMedia(Base):
    def test_dhash_similar(self):
        a = list(range(72))
        b = [v + 3 for v in a]
        c = list(reversed(a))
        self.assertEqual(media._dhash(a), media._dhash(b))
        self.assertNotEqual(media._dhash(a), media._dhash(c))

    def test_similar_images(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow fehlt")
        im = Image.new("L", (90, 80))
        im.putdata([(x * 3 + y) % 256 for y in range(80) for x in range(90)])
        im.save(self.root / "a.png")
        im.resize((45, 40)).save(self.root / "a_klein.jpg", quality=70)
        Image.new("L", (90, 80), 255).transpose(0).save(self.root / "weiss.png")
        im.transpose(Image.FLIP_LEFT_RIGHT).save(self.root / "gespiegelt.png")
        g = media.find_similar(core.scan(self.root), 8)
        self.assertEqual(len(g), 1)
        self.assertEqual({Path(x).name for x in g[0]["files"]}, {"a.png", "a_klein.jpg"})


class TestAssist(Base):
    def test_keyword_projects_and_search(self):
        pr_root = self.root / "Projekte"
        (pr_root / "Hausbau").mkdir(parents=True)
        (pr_root / "Urlaub Italien").mkdir(parents=True)
        s = {"project_root": str(pr_root), "projects": [{"name": "Auto", "keywords": "werkstatt reifen"}]}
        prs = assist.projects(s, self.root)
        self.assertEqual({p["name"] for p in prs}, {"Hausbau", "Urlaub Italien", "Auto"})
        f = {"name": "angebot.pdf", "rel": "angebot.pdf"}
        r = assist.suggest_project(f, "Angebot Werkstatt neue Reifen Winter", prs, use_assistant=False)
        self.assertEqual(r["project"], "Auto")
        self.assertIsNone(assist.suggest_project(f, "nichts passendes", prs, use_assistant=False))
        files = [{"path": "/a", "name": "a.pdf", "rel": "a.pdf"}, {"path": "/b", "name": "b.txt", "rel": "b.txt"}]
        assist.build_index(files, {"/a": "Stromrechnung Mai", "/b": "Einkaufsliste Brot"}, False)
        res = assist.search("stromrechnung", use_assistant=False)["results"]
        self.assertEqual(res[0]["path"], "/a")
        self.assertEqual(len(res), 1)

    def test_settings_roundtrip(self):
        assist.save_settings({"ocr": True})
        self.assertTrue(assist.load_settings()["ocr"])
        self.assertIn("projects", assist.load_settings())

    def test_project_in_plan(self):
        write(self.root / "x.pdf")
        f = core.scan(self.root)
        proj = {f[0]["path"]: {"project": "P", "target": str(self.root / "Projekte" / "P"), "why": "w"}}
        plan = core.build_plan(self.root, f, core.DEFAULT_RULES, projects=proj)
        self.assertEqual(plan[0]["source"], "assistent")


class TestApi(Base):
    @classmethod
    def setUpClass(cls):
        from organizer.server import make_server
        cls.srv = make_server(0)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def call(self, path, body=None, headers=None):
        req = urllib.request.Request(self.url + path, None if body is None else json.dumps(body).encode(),
                                     {"Content-Type": "application/json", **(headers or {})})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def wait(self):
        for _ in range(200):
            s = self.call("/api/status")
            if not s["job"]["running"]:
                return s
            time.sleep(0.1)
        self.fail("Zeitüberschreitung")

    def test_full_flow(self):
        with urllib.request.urlopen(self.url + "/") as r:
            self.assertIn("Folder Organizer", r.read().decode())
        write(self.root / "a.pdf", b"x")
        write(self.root / "b.jpg", b"jj")
        write(self.root / "b2.jpg", b"jj", mtime=2_000_000_000)
        self.call("/api/scan", {"root": str(self.root), "options": {"similar": False}})
        s = self.wait()
        self.assertEqual(s["job"]["error"], "")
        res = self.call("/api/result")
        self.assertEqual(len(res["duplicates"]), 1)
        pdf = next(a for a in res["plan"] if a["src"].endswith("a.pdf"))
        self.call("/api/plan/update", {"id": pdf["id"], "dst": "Wichtig/a.pdf"})
        self.call("/api/execute", {})
        s = self.wait()
        self.assertTrue((self.root / "Wichtig" / "a.pdf").exists())
        self.assertTrue((self.root / core.TRASH / "b2.jpg").exists())
        h = self.call("/api/history")
        self.call("/api/undo", {"batch": h[0]["id"]})
        self.assertTrue((self.root / "a.pdf").exists() and (self.root / "b2.jpg").exists())
        self.assertIn("results", self.call("/api/search", {"query": "a"}))

    def test_rejects_foreign_origin_and_bad_root(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.call("/api/execute", {}, {"Origin": "http://boese.example"})
        self.assertEqual(e.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.call("/api/scan", {"root": str(self.root / "fehlt")})
        self.assertEqual(e.exception.code, 400)

    def test_browse(self):
        (self.root / "Unter").mkdir()
        b = self.call("/api/browse?path=" + urllib.request.quote(str(self.root)))
        self.assertIn(str(self.root / "Unter"), b["dirs"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
