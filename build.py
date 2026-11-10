#!/usr/bin/env python3
"""Baut aus public/index.html, src/sim.js und src/worker.template.js eine einzige worker.js."""
import json, pathlib
root = pathlib.Path(__file__).parent
sim = (root / "src" / "sim.js").read_text(encoding="utf-8")
html = (root / "public" / "index.html").read_text(encoding="utf-8")
assert html.count("/*__SIM__*/") == 1
html = html.replace("/*__SIM__*/", sim, 1)
(root / "public" / "game.html").write_text(html, encoding="utf-8")  # fertige Einzeldatei (z. B. für Vorschau)
tpl = (root / "src" / "worker.template.js").read_text(encoding="utf-8")
assert tpl.count("__SIM__") == 1 and tpl.count("__HTML__") == 1
out = tpl.replace("__SIM__", sim, 1).replace("__HTML__", json.dumps(html, ensure_ascii=False), 1)
(root / "worker.js").write_text(out, encoding="utf-8")
print("worker.js gebaut:", len(out), "Zeichen")
