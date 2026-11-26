#!/usr/bin/env python3
"""Baut worker.js: worker-src.js + index.html (als Text eingesetzt) -> eine Datei fürs Cloudflare-Dashboard."""
import json, pathlib
hier = pathlib.Path(__file__).parent
src = (hier / "worker-src.js").read_text(encoding="utf-8")
seite = (hier / "index.html").read_text(encoding="utf-8")
platzhalter = "/*SEITE*/''"
assert src.count(platzhalter) == 1
(hier / "worker.js").write_text(src.replace(platzhalter, json.dumps(seite, ensure_ascii=False)), encoding="utf-8")
print("worker.js gebaut:", (hier / "worker.js").stat().st_size, "Bytes")
