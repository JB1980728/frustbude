# Frustbude – Hau die Tools!

Frust-Spiel für die PM-Weiterbildung: Kurs-Tools als Boxbirnen, Einzel- und Mehrspieler (1 gegen 1, 2 gegen 2), Zuschauer, Ranglisten, Abzeichen, anonyme Frust-Wand.

- `public/index.html` – das Spiel (Quelle)
- `src/worker.template.js` – Server (Cloudflare Worker + Durable Object für Mehrspieler-Räume)
- `build.py` – baut daraus `worker.js`
- `wrangler.toml` – Cloudflare-Konfiguration (D1-Datenbank `frustbude-db`, Durable Object `Room`)

Änderungen: `public/index.html` oder `src/worker.template.js` bearbeiten, `python3 build.py` ausführen, committen und pushen. Cloudflare veröffentlicht automatisch.
