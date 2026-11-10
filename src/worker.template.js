// Frustbude – Cloudflare Worker + Durable Object (Mehrspieler-Räume)
// Speichert den gemeinsamen Frust-Zähler, die anonyme Frust-Wand und die Ranglisten in D1.
// Es werden KEINE IP-Adressen gespeichert. Ranglisten zeigen nur frei gewählte Spitznamen.
import { DurableObject } from "cloudflare:workers";

const HTML = __HTML__;

const TOOL_IDS = ["ga","onepage","wix","miro","slack","meet","classroom","coda","posthog","clarity","mixpanel","amplitude","umami","contentsquare","chatgpt","gemini","stitch","figma","claude"];
const WEAPON_IDS = ["fist","tomato","banana","egg","pie","highfive","rocket","love"];
const ALLOWED = new Set([...TOOL_IDS, "boss", "custom", "_ko", "_boss", "_zen", ...WEAPON_IDS.map(w => "w_" + w)]);
const REACTIONS = ["🔥","😂","👏","🍅","😱","💪","❤️"];

// Grobe Beleidigungen und Hetze blockieren (je Wort geprüft, Tricks wie A.r.s.c.h oder 4rsch werden erkannt)
const BLOCK = ["arschloch","wichser","wixxer","fotze","hurensohn","hure","schlampe","missgeburt","spast","spasti","behindert","schwuchtel","neger","nigger","kanake","kanacke","zigeuner","fick","bastard","drecksau","dreckssau","nutte","hitler","judensau","vergasen","umbringen","killyourself"];
const LINKS = ["http://","https://","www.","discord.gg",".com/",".de/"];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function normWord(t) {
  return t.toLowerCase()
    .replace(/0/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/4|@/g, "a").replace(/5|\$/g, "s").replace(/7/g, "t")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z]/g, "");
}
function isBlocked(text) {
  const raw = String(text).toLowerCase();
  if (LINKS.some(l => raw.includes(l))) return true;
  const words = String(text).split(/\s+/).map(normWord).filter(Boolean);
  return words.some(w => BLOCK.some(b => w.includes(b)));
}
function cleanText(t, max) {
  return String(t || "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, max || 200);
}
function cleanName(n) {
  const t = cleanText(n, 16).replace(/\n/g, " ");
  if (t.length < 2 || isBlocked(t)) return "";
  return t;
}
function cleanBadge(b) { return cleanText(b, 8).replace(/\s/g, ""); }
function cleanSid(s) { return String(s || "").replace(/[^a-z0-9]/gi, "").slice(0, 40); }

// Spam-Bremse (nur im Arbeitsspeicher, nichts wird dauerhaft gespeichert)
const lastSeen = new Map();
function tooFast(key, ms) {
  const now = Date.now(), t = lastSeen.get(key) || 0;
  if (now - t < ms) return true;
  lastSeen.set(key, now);
  if (lastSeen.size > 5000) lastSeen.clear();
  return false;
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS hits (tool TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS players (sid TEXT PRIMARY KEY, ts INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS wall (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, ts INTEGER NOT NULL, reports INTEGER NOT NULL DEFAULT 0, same INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE INDEX IF NOT EXISTS wall_vis ON wall(reports, id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lb (sid TEXT PRIMARY KEY, name TEXT NOT NULL, badge TEXT, wins INTEGER NOT NULL DEFAULT 0, duels INTEGER NOT NULL DEFAULT 0, best_duel INTEGER NOT NULL DEFAULT 0, best_time INTEGER NOT NULL DEFAULT 0, boss INTEGER NOT NULL DEFAULT 0, ts INTEGER)"),
  ]);
  try { await db.prepare("ALTER TABLE lb ADD COLUMN best_time_hard INTEGER NOT NULL DEFAULT 0").run(); } catch (e) {}
  schemaReady = true;
}

async function readBody(req) {
  const txt = await req.text();
  if (txt.length > 4000) throw new Error("too_big");
  return txt ? JSON.parse(txt) : {};
}

/* ======================= Duell-Raum (Kampf läuft auf dem Server) ======================= */
__FIGHT__
const BOT_NAMES = ["Bot Bernd","Bot Lotte","Bot Kalle","Bot Frieda","Bot Ronny","Bot Uschi"];
const TICK_MS = 50;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.conns = new Map();
    this.st = { code: "", phase: "lobby", format: "1v1", level: "easy", hostId: null, round: 0, tools: { A: null, B: null } };
    this.bots = [];
    this.g = null;
    this.tick = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (!this.st.code) this.st.code = (url.pathname.split("/").pop() || url.searchParams.get("code") || "").toUpperCase().slice(0, 8);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket erwartet", { status: 426 });
    if (this.conns.size >= 24) return new Response("Raum voll", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const c = { id: crypto.randomUUID().slice(0, 8), ws: server, name: "", badge: "", sid: "", role: "spectator", team: "A", joined: false, lastReact: 0, msgs: 0, msgWin: Date.now() };
    this.conns.set(c.id, c);
    server.addEventListener("message", e => this.onMsg(c, e.data));
    server.addEventListener("close", () => this.onClose(c));
    server.addEventListener("error", () => this.onClose(c));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(c, obj) { try { c.ws.send(JSON.stringify(obj)); } catch (e) {} }
  broadcast(obj) { const s = JSON.stringify(obj); for (const c of this.conns.values()) if (c.joined) { try { c.ws.send(s); } catch (e) {} } }
  humans() { return [...this.conns.values()].filter(c => c.joined && c.role === "player"); }
  players() { return [...this.humans(), ...this.bots]; }
  cap() { return this.st.format === "2v2" ? 4 : 2; }
  dropBot() { if (!this.bots.length) return; const a = this.players().filter(p => p.team === "A").length, b = this.players().filter(p => p.team === "B").length; const team = a >= b ? "A" : "B"; let i = this.bots.findIndex(x => x.team === team); if (i < 0) i = 0; this.bots.splice(i, 1); }
  pub(c) { return { id: c.id, isBot: !!c.isBot, name: c.name, badge: c.badge, role: c.role, team: c.team }; }
  state() {
    return { t: "state", now: Date.now(), code: this.st.code, phase: this.st.phase, format: this.st.format, level: this.st.level, hostId: this.st.hostId, round: this.st.round, tools: this.st.tools,
      people: [...[...this.conns.values()].filter(c => c.joined), ...this.bots].map(c => this.pub(c)) };
  }
  sync() { this.broadcast(this.state()); }
  joinTeam(c) { const a = this.players().filter(p => p.team === "A" && p !== c).length, b = this.players().filter(p => p.team === "B" && p !== c).length; c.team = a <= b ? "A" : "B"; }
  balanceTeams() {
    const ps = this.players();
    if (this.st.format === "1v1") { ps.forEach((p, i) => { if (i < 2) p.team = i === 0 ? "A" : "B"; else p.role = "spectator"; }); }
    else { const count = t => ps.filter(p => p.team === t && p.role === "player").length; ps.forEach(p => { if (count(p.team) > 2) p.team = p.team === "A" ? "B" : "A"; }); ps.slice(4).forEach(p => p.role = "spectator"); }
    this.bots = this.bots.filter(b => b.role === "player");
  }

  onMsg(c, raw) {
    if (typeof raw !== "string" || raw.length > 600) return;
    const now = Date.now();
    if (now - c.msgWin > 1000) { c.msgWin = now; c.msgs = 0; }
    if (++c.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const st = this.st;

    if (m.t === "join" && !c.joined) {
      c.name = cleanName(m.name) || "Anonym"; c.badge = cleanBadge(m.badge); c.sid = cleanSid(m.sid); c.joined = true;
      const wantPlay = m.role === "player";
      if (wantPlay && st.phase === "lobby" && this.players().length >= this.cap() && this.bots.length) this.dropBot();
      if (wantPlay && st.phase === "lobby" && this.players().length < this.cap()) {
        c.role = "player"; this.joinTeam(c);
        if (!st.hostId || !this.conns.has(st.hostId)) st.hostId = c.id;
      } else c.role = "spectator";
      this.send(c, { t: "welcome", you: c.id, role: c.role, full: wantPlay && c.role !== "player" });
      this.sync();
      return;
    }
    if (!c.joined) return;

    if (m.t === "act" && st.phase === "live" && this.g && c.role === "player") {
      if (["jab", "heavy", "ok", "block1", "block0"].includes(m.a)) FIGHT.act(this.g, c.id, m.a);
      return;
    }
    if (m.t === "react" && REACTIONS.includes(m.e) && now - c.lastReact > 350) { c.lastReact = now; this.broadcast({ t: "react", e: m.e }); return; }
    if (m.t === "rematch" && st.phase === "results") {
      st.phase = "lobby"; this.g = null;
      this.broadcast({ t: "feed", txt: `${c.name} will eine Revanche! ⚔️` });
      this.sync(); return;
    }
    if (st.phase !== "lobby") return;

    if (m.t === "tool" && (m.team === "A" || m.team === "B") && TOOL_IDS.includes(m.tool)) {
      const humansInTeam = this.humans().some(p => p.team === m.team);
      if ((c.role === "player" && c.team === m.team) || (!humansInTeam && st.hostId === c.id)) { st.tools[m.team] = m.tool; this.sync(); }
      return;
    }
    if (m.t === "team" && c.role === "player" && st.format === "2v2" && (m.team === "A" || m.team === "B")) {
      if (this.players().filter(p => p.team === m.team).length < 2) { c.team = m.team; this.sync(); }
      return;
    }
    if (m.t === "play" && c.role === "spectator") {
      if (this.players().length >= this.cap() && this.bots.length) this.dropBot();
      if (this.players().length < this.cap()) { c.role = "player"; this.joinTeam(c); if (!st.hostId || !this.conns.has(st.hostId)) st.hostId = c.id; this.sync(); }
      return;
    }
    if (m.t === "watch" && c.role === "player") {
      c.role = "spectator";
      if (st.hostId === c.id) { const p = this.humans()[0]; st.hostId = p ? p.id : null; }
      this.sync(); return;
    }
    if (st.hostId !== c.id) return;
    if (m.t === "settings") {
      if (m.format === "1v1" || m.format === "2v2") st.format = m.format;
      if (["easy", "hard"].includes(m.level)) st.level = m.level;
      this.balanceTeams(); this.sync(); return;
    }
    if (m.t === "bots") {
      const used = new Set(this.bots.map(b => b.name));
      while (this.players().length < this.cap()) {
        const name = BOT_NAMES.find(n => !used.has(n)) || "Bot"; used.add(name);
        const b = { id: "bot" + Math.random().toString(36).slice(2, 7), isBot: true, name, badge: "🤖", role: "player", team: "A" };
        this.joinTeam(b); this.bots.push(b);
      }
      this.sync(); return;
    }
    if (m.t === "nobots") { this.bots = []; this.sync(); return; }
    if (m.t === "start") {
      const ps = this.players();
      if (!ps.some(p => p.team === "A") || !ps.some(p => p.team === "B")) { this.send(c, { t: "error", msg: "Im anderen Team fehlt noch jemand." }); return; }
      const pool = TOOL_IDS.filter(id => id !== st.tools.A && id !== st.tools.B).sort(() => Math.random() - .5);
      if (!st.tools.A) st.tools.A = pool.pop();
      if (!st.tools.B) st.tools.B = pool.pop();
      this.g = FIGHT.newFight({ tools: { ...st.tools }, players: ps.map(p => ({ id: p.id, team: p.team, name: p.name, bot: !!p.isBot, level: st.level })) });
      st.phase = "live"; st.round++;
      this.sync();
      this.run();
      return;
    }
  }

  run() {
    clearInterval(this.tick);
    let last = Date.now();
    this.tick = setInterval(() => {
      const g = this.g;
      if (!g || this.st.phase !== "live") { clearInterval(this.tick); return; }
      const now = Date.now(); let dt = Math.min(.25, (now - last) / 1000); last = now;
      while (dt > 1e-4 && g.phase !== "over") {
        const h = Math.min(1 / 60, dt); dt -= h;
        for (const p of Object.values(g.players)) if (p.bot) FIGHT.bot(g, p.id, h);
        FIGHT.step(g, h);
      }
      this.broadcast({ t: "snap", s: FIGHT.snap(g) });
      g.ev = [];
      if (g.phase === "over") { clearInterval(this.tick); this.finish(); }
    }, TICK_MS);
  }

  async finish() {
    const g = this.g, st = this.st;
    st.phase = "results"; this.sync();
    try {
      const db = this.env.DB; if (!db || !g) return;
      await ensureSchema(db);
      const stmts = [...this.conns.values()].filter(c => c.joined && g.players[c.id] && !g.players[c.id].bot && c.sid && c.name && c.name !== "Anonym").map(c =>
        db.prepare("INSERT INTO lb (sid, name, badge, wins, duels, best_duel, ts) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, wins = wins + excluded.wins, duels = duels + 1, best_duel = MAX(best_duel, excluded.best_duel), ts = excluded.ts")
          .bind(c.sid, c.name, c.badge, g.winner === g.players[c.id].team ? 1 : 0, Math.round(g.players[c.id].st.dmg), Date.now()));
      if (stmts.length) await db.batch(stmts);
    } catch (e) {}
  }

  onClose(c) {
    if (!this.conns.has(c.id)) return;
    this.conns.delete(c.id);
    const st = this.st;
    if (st.hostId === c.id) { const p = this.humans()[0]; st.hostId = p ? p.id : null; }
    // Wer mitten im Kampf geht, wird von einem Bot ersetzt
    if (this.g && st.phase === "live" && this.g.players[c.id]) { const p = this.g.players[c.id]; p.bot = true; p.level = st.level; p.block = false; p.name = p.name + " (Bot)"; }
    if (c.joined) { this.broadcast({ t: "feed", txt: `${c.name} hat den Raum verlassen.` }); this.sync(); }
    if (![...this.conns.values()].some(x => x.joined)) { clearInterval(this.tick); this.g = null; this.bots = []; st.phase = "lobby"; }
  }
}

/* ======================= Worker ======================= */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }

    // Mehrspieler-Raum (WebSocket)
    const rm = path.match(/^\/api\/room\/([A-Z0-9]{4,8})$/);
    if (rm) {
      if (!env.ROOMS) return json({ error: "no_rooms" }, 503);
      const id = env.ROOMS.idFromName(rm[1]);
      const u = new URL(req.url); u.searchParams.set("code", rm[1]);
      return env.ROOMS.get(id).fetch(new Request(u.toString(), req));
    }

    if (!path.startsWith("/api/")) return new Response("Nicht gefunden", { status: 404 });
    if (!env.DB) return json({ error: "no_db" }, 503);
    const db = env.DB;
    const ip = req.headers.get("cf-connecting-ip") || "x";

    try {
      await ensureSchema(db);

      if (path === "/api/stats" && req.method === "GET") {
        const rows = await db.prepare("SELECT tool, n FROM hits").all();
        const p = await db.prepare("SELECT COUNT(*) AS c FROM players").first();
        const hits = {};
        for (const r of rows.results || []) hits[r.tool] = r.n;
        return json({ hits, players: p ? p.c : 0 });
      }

      if (path === "/api/hits" && req.method === "POST") {
        const body = await readBody(req);
        const sid = cleanSid(body.sid);
        if (!sid) return json({ error: "sid" }, 400);
        if (tooFast("h:" + sid, 2500)) return json({ error: "slow_down" }, 429);
        const stmts = []; let total = 0;
        for (const [k, raw] of Object.entries(body.counts || {})) {
          if (!ALLOWED.has(k)) continue;
          const n = Math.floor(Number(raw));
          if (!Number.isFinite(n) || n <= 0) continue;
          const c = Math.min(n, 800); total += c; if (total > 3000) break;
          stmts.push(db.prepare("INSERT INTO hits (tool, n) VALUES (?, ?) ON CONFLICT(tool) DO UPDATE SET n = n + excluded.n").bind(k, c));
        }
        if (!stmts.length) return json({ ok: true });
        stmts.push(db.prepare("INSERT OR IGNORE INTO players (sid, ts) VALUES (?, ?)").bind(sid, Date.now()));
        await db.batch(stmts);
        return json({ ok: true });
      }

      // Einzelspieler-Bestwerte für die Rangliste
      if (path === "/api/score" && req.method === "POST") {
        const b = await readBody(req);
        const sid = cleanSid(b.sid), name = cleanName(b.name), badge = cleanBadge(b.badge);
        if (!sid || !name) return json({ error: "name" }, 400);
        if (tooFast("s:" + sid, 3000)) return json({ error: "slow_down" }, 429);
        if (b.kind === "time") {
          const score = Math.max(0, Math.min(60000, Math.floor(Number(b.score) || 0)));
          await db.prepare("INSERT INTO lb (sid, name, badge, best_time, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, best_time = MAX(best_time, excluded.best_time), ts = excluded.ts")
            .bind(sid, name, badge, score, Date.now()).run();
        } else if (b.kind === "timeHard") {
          const score = Math.max(0, Math.min(60000, Math.floor(Number(b.score) || 0)));
          await db.prepare("INSERT INTO lb (sid, name, badge, best_time_hard, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, best_time_hard = MAX(best_time_hard, excluded.best_time_hard), ts = excluded.ts")
            .bind(sid, name, badge, score, Date.now()).run();
        } else if (b.kind === "boss") {
          await db.prepare("INSERT INTO lb (sid, name, badge, boss, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, boss = boss + 1, ts = excluded.ts")
            .bind(sid, name, badge, Date.now()).run();
        } else if (b.kind === "profile") {
          await db.prepare("UPDATE lb SET name = ?, badge = ? WHERE sid = ?").bind(name, badge, sid).run();
        }
        return json({ ok: true });
      }

      if (path === "/api/leaderboard" && req.method === "GET") {
        const q = (col, extra) => db.prepare(`SELECT name, badge, ${col} AS v FROM lb WHERE ${col} > 0 ${extra || ""} ORDER BY ${col} DESC, ts ASC LIMIT 15`).all().then(r => r.results || []);
        const [wins, duel, time, timeHard, boss] = await Promise.all([q("wins"), q("best_duel"), q("best_time"), q("best_time_hard"), q("boss")]);
        return json({ wins, duel, time, timeHard, boss });
      }

      if (path === "/api/recap" && req.method === "GET") {
        const rows = await db.prepare("SELECT tool, n FROM hits").all();
        const p = await db.prepare("SELECT COUNT(*) AS c FROM players").first();
        const w = await db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(same),0) AS s FROM wall").first();
        const d = await db.prepare("SELECT COALESCE(SUM(duels),0) AS d FROM lb").first();
        const top = await db.prepare("SELECT name, badge, wins AS v FROM lb WHERE wins > 0 ORDER BY wins DESC, ts ASC LIMIT 3").all();
        const hits = {}; for (const r of rows.results || []) hits[r.tool] = r.n;
        return json({ hits, players: p ? p.c : 0, wall: w ? w.c : 0, same: w ? w.s : 0, duels: d ? Math.round(d.d / 2) : 0, top: top.results || [] });
      }

      if (path === "/api/wall" && req.method === "GET") {
        const before = Math.floor(Number(url.searchParams.get("before")) || 0);
        const rows = before > 0
          ? await db.prepare("SELECT id, text, ts, same FROM wall WHERE reports < 3 AND id < ? ORDER BY id DESC LIMIT 80").bind(before).all()
          : await db.prepare("SELECT id, text, ts, same FROM wall WHERE reports < 3 ORDER BY id DESC LIMIT 80").all();
        return json({ notes: rows.results || [] });
      }

      if (path === "/api/wall" && req.method === "POST") {
        const body = await readBody(req);
        const text = cleanText(body.text, 200);
        if (text.length < 3) return json({ error: "too_short" }, 400);
        if (isBlocked(text)) return json({ error: "filter" }, 422);
        const sid = cleanSid(body.sid);
        if (tooFast("w:" + ip, 15000) || (sid && tooFast("ws:" + sid, 15000))) return json({ error: "slow_down" }, 429);
        const ts = Date.now();
        const r = await db.prepare("INSERT INTO wall (text, ts) VALUES (?, ?)").bind(text, ts).run();
        return json({ ok: true, note: { id: r.meta.last_row_id, text, ts, same: 0 } });
      }

      const m = path.match(/^\/api\/wall\/(\d+)\/(same|report)$/);
      if (m && req.method === "POST") {
        const id = Number(m[1]);
        if (tooFast(m[2] + ":" + ip + ":" + id, 10000)) return json({ ok: true });
        const col = m[2] === "same" ? "same" : "reports";
        await db.prepare(`UPDATE wall SET ${col} = ${col} + 1 WHERE id = ?`).bind(id).run();
        return json({ ok: true });
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      if (e && e.message === "too_big") return json({ error: "too_big" }, 413);
      if (e instanceof SyntaxError) return json({ error: "bad_json" }, 400);
      return json({ error: "server" }, 500);
    }
  },
};
