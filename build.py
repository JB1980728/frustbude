#!/usr/bin/env python3
"""Baut aus public/index.html und src/worker.template.js eine einzige worker.js."""
import json, pathlib
root = pathlib.Path(__file__).parent
html = (root / "public" / "index.html").read_text(encoding="utf-8")
tpl = (root / "src" / "worker.template.js").read_text(encoding="utf-8")
fight = (root / "src" / "fight.js").read_text(encoding="utf-8")
assert html.count("/*__FIGHT__*/") == 1 and tpl.count("__FIGHT__") == 1
html = html.replace("/*__FIGHT__*/", fight, 1)
import base64
og = base64.b64encode((root / "public" / "og.jpg").read_bytes()).decode()
icon = base64.b64encode((root / "public" / "icon.png").read_bytes()).decode()
assert tpl.count("__OG__") == 1 and tpl.count("__ICON__") == 1
tpl = tpl.replace("__OG__", og, 1).replace("__ICON__", icon, 1)
out = tpl.replace("__FIGHT__", fight, 1).replace("__HTML__", json.dumps(html, ensure_ascii=False), 1)
(root / "worker.js").write_text(out, encoding="utf-8")
print("worker.js gebaut:", len(out), "Zeichen")
