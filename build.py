#!/usr/bin/env python3
"""Baut aus public/index.html und src/worker.template.js eine einzige worker.js."""
import json, pathlib
root = pathlib.Path(__file__).parent
html = (root / "public" / "index.html").read_text(encoding="utf-8")
tpl = (root / "src" / "worker.template.js").read_text(encoding="utf-8")
out = tpl.replace("__HTML__", json.dumps(html, ensure_ascii=False), 1)
(root / "worker.js").write_text(out, encoding="utf-8")
print("worker.js gebaut:", len(out), "Zeichen")
