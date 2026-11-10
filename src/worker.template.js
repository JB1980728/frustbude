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
  schemaReady = true;
}

async function readBody(req) {
  const txt = await req.text();
  if (txt.length > 4000) throw new Error("too_big");
  return txt ? JSON.parse(txt) : {};
}

/* ======================= Mehrspieler-Raum ======================= */
const DUEL_MS = 45000;
const COUNTDOWN_MS = 3800;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.conns = new Map();
    this.st = { code: "", phase: "lobby", format: "1v1", level: "mid", hostId: null, seed: 0, startAt: 0, endsAt: 0, results: null, round: 0 };
    this.finishTimer = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (!this.st.code) this.st.code = (url.searchParams.get("code") || "").slice(0, 8);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket erwartet", { status: 426 });
    if (this.conns.size >= 24) return new Response("Raum voll", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const c = { id: crypto.randomUUID().slice(0, 8), ws: server, name: "", badge: "", sid: "", role: "spectator", team: "A", joined: false,
      score: 0, hits: 0, ko: 0, combo: 0, hp: 100, tool: "", lastLive: 0, lastAtk: 0, lastReact: 0, msgs: 0, msgWin: Date.now() };
    this.conns.set(c.id, c);
    server.addEventListener("message", e => this.onMsg(c, e.data));
    server.addEventListener("close", () => this.onClose(c));
    server.addEventListener("error", () => this.onClose(c));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(c, obj) { try { c.ws.send(JSON.stringify(obj)); } catch (e) {} }
  broadcast(obj, except) { const s = JSON.stringify(obj); for (const c of this.conns.values()) if (c.joined && c !== except) { try { c.ws.send(s); } catch (e) {} } }
  players() { return [...this.conns.values()].filter(c => c.joined && c.role === "player"); }
  cap() { return this.st.format === "2v2" ? 4 : 2; }
  pub(c) { return { id: c.id, name: c.name, badge: c.badge, role: c.role, team: c.team, score: c.score, hits: c.hits, ko: c.ko, combo: c.combo, hp: c.hp, tool: c.tool }; }
  state() {
    return { t: "state", now: Date.now(), code: this.st.code, phase: this.st.phase, format: this.st.format, level: this.st.level, hostId: this.st.hostId,
      seed: this.st.seed, startAt: this.st.startAt, endsAt: this.st.endsAt, results: this.st.results, round: this.st.round,
      people: [...this.conns.values()].filter(c => c.joined).map(c => this.pub(c)) };
  }
  sync() { this.broadcast(this.state()); }

  balanceTeams() {
    const ps = this.players();
    if (this.st.format === "1v1") { ps.forEach((p, i) => { if (i < 2) p.team = i === 0 ? "A" : "B"; else p.role = "spectator"; }); return; }
    const count = t => ps.filter(p => p.team === t).length;
    ps.forEach(p => { if (count(p.team) > 2) p.team = p.team === "A" ? "B" : "A"; });
    ps.slice(4).forEach(p => p.role = "spectator");
  }

  onMsg(c, raw) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    const now = Date.now();
    if (now - c.msgWin > 1000) { c.msgWin = now; c.msgs = 0; }
    if (++c.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const st = this.st;

    if (m.t === "join" && !c.joined) {
      c.name = cleanName(m.name) || "Anonym";
      c.badge = cleanBadge(m.badge);
      c.sid = cleanSid(m.sid);
      c.joined = true;
      const wantPlay = m.role === "player";
      if (wantPlay && st.phase === "lobby" && this.players().length < this.cap()) {
        c.role = "player";
        const a = this.players().filter(p => p.team === "A" && p !== c).length, b = this.players().filter(p => p.team === "B" && p !== c).length;
        c.team = a <= b ? "A" : "B";
        if (!st.hostId || !this.conns.has(st.hostId)) st.hostId = c.id;
      } else c.role = "spectator";
      this.send(c, { t: "welcome", you: c.id, role: c.role, full: wantPlay && c.role !== "player" });
      this.sync();
      return;
    }
    if (!c.joined) return;

    if (m.t === "team" && st.phase === "lobby" && c.role === "player" && st.format === "2v2" && (m.team === "A" || m.team === "B")) {
      if (this.players().filter(p => p.team === m.team).length < 2) { c.team = m.team; this.sync(); }
      return;
    }
    if (m.t === "play" && st.phase === "lobby" && c.role === "spectator" && this.players().length < this.cap()) {
      c.role = "player";
      const a = this.players().filter(p => p.team === "A" && p !== c).length, b = this.players().filter(p => p.team === "B" && p !== c).length;
      c.team = a <= b ? "A" : "B";
      if (!st.hostId || !this.conns.has(st.hostId)) st.hostId = c.id;
      this.sync(); return;
    }
    if (m.t === "watch" && st.phase === "lobby" && c.role === "player") {
      c.role = "spectator";
      if (st.hostId === c.id) { const p = this.players()[0]; st.hostId = p ? p.id : null; }
      this.sync(); return;
    }
    if (m.t === "settings" && st.phase === "lobby" && st.hostId === c.id) {
      if (m.format === "1v1" || m.format === "2v2") st.format = m.format;
      if (["easy", "mid", "hard"].includes(m.level)) st.level = m.level;
      this.balanceTeams(); this.sync(); return;
    }
    if (m.t === "start" && st.phase === "lobby" && st.hostId === c.id) {
      const ps = this.players(), a = ps.filter(p => p.team === "A").length, b = ps.filter(p => p.team === "B").length;
      if (a < 1 || b < 1) { this.send(c, { t: "error", msg: "Es fehlen noch Mitspieler im anderen Team." }); return; }
      st.phase = "live"; st.round++; st.seed = Math.floor(Math.random() * 1e9);
      st.startAt = now + COUNTDOWN_MS; st.endsAt = st.startAt + DUEL_MS; st.results = null;
      ps.forEach(p => { p.score = 0; p.hits = 0; p.ko = 0; p.combo = 0; p.hp = 100; p.tool = ""; });
      clearTimeout(this.finishTimer);
      this.finishTimer = setTimeout(() => this.finish(), st.endsAt - now + 1800);
      this.sync(); return;
    }
    if ((m.t === "score" || m.t === "final") && st.phase === "live" && c.role === "player") {
      const n = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
      c.score = n(m.score, 300000); c.hits = n(m.hits, 5000); c.ko = n(m.ko, 500); c.combo = n(m.combo, 999); c.hp = n(m.hp, 999);
      c.tool = String(m.tool || "").slice(0, 20);
      if (m.t === "final" || now - c.lastLive > 200) { c.lastLive = now; this.broadcast({ t: "live", p: this.pub(c) }); }
      return;
    }
    if (m.t === "attack" && st.phase === "live" && c.role === "player" && now - c.lastAtk > 900) {
      c.lastAtk = now;
      const kind = ["tomato", "shake", "fusion"].includes(m.kind) ? m.kind : "shake";
      const s = JSON.stringify({ t: "attack", from: c.name, team: c.team, kind });
      for (const o of this.conns.values()) if (o.joined && o.role === "player" && o.team !== c.team) { try { o.ws.send(s); } catch (e) {} }
      this.broadcast({ t: "feed", txt: `${c.name}: ${kind === "fusion" ? "OVERKILL! 💢" : kind === "tomato" ? "Super-Schlag! 🍅" : "Uppercut! 🥊"}` });
      return;
    }
    if (m.t === "react" && REACTIONS.includes(m.e) && now - c.lastReact > 350) {
      c.lastReact = now; this.broadcast({ t: "react", e: m.e, name: c.name }); return;
    }
    if (m.t === "rematch" && st.phase === "results") {
      st.phase = "lobby"; st.results = null;
      this.players().forEach(p => { p.score = 0; p.hits = 0; p.ko = 0; p.combo = 0; });
      this.broadcast({ t: "feed", txt: `${c.name} will eine Revanche! ⚔️` });
      this.sync(); return;
    }
  }

  onClose(c) {
    if (!this.conns.has(c.id)) return;
    this.conns.delete(c.id);
    if (this.st.hostId === c.id) { const p = this.players()[0]; this.st.hostId = p ? p.id : null; }
    if (c.joined) { this.broadcast({ t: "feed", txt: `${c.name} hat den Raum verlassen.` }); this.sync(); }
    if (this.st.phase === "live" && this.players().length === 0) { clearTimeout(this.finishTimer); this.st.phase = "lobby"; }
  }

  async finish() {
    const st = this.st;
    if (st.phase !== "live") return;
    const ps = this.players();
    const teamScore = t => {
      const mem = ps.filter(p => p.team === t);
      const sum = mem.reduce((a, p) => a + p.score, 0);
      return { sum, members: mem.length };
    };
    const A = teamScore("A"), B = teamScore("B");
    // Bei ungleich großen Teams zählt der Durchschnitt, damit es fair bleibt
    const fair = A.members !== B.members;
    const sa = fair ? Math.round(A.sum / Math.max(1, A.members)) : A.sum;
    const sb = fair ? Math.round(B.sum / Math.max(1, B.members)) : B.sum;
    const winner = sa === sb ? "draw" : sa > sb ? "A" : "B";
    st.results = { winner, A: sa, B: sb, fair, players: ps.map(p => this.pub(p)).sort((x, y) => y.score - x.score) };
    st.phase = "results";
    this.sync();
    // Rangliste aktualisieren
    try {
      const db = this.env.DB; if (!db) return;
      await ensureSchema(db);
      const stmts = ps.filter(p => p.sid && p.name && p.name !== "Anonym").map(p =>
        db.prepare("INSERT INTO lb (sid, name, badge, wins, duels, best_duel, ts) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, wins = wins + excluded.wins, duels = duels + 1, best_duel = MAX(best_duel, excluded.best_duel), ts = excluded.ts")
          .bind(p.sid, p.name, p.badge, winner === p.team ? 1 : 0, p.score, Date.now()));
      if (stmts.length) await db.batch(stmts);
    } catch (e) {}
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
        const [wins, duel, time, boss] = await Promise.all([q("wins"), q("best_duel"), q("best_time"), q("boss")]);
        return json({ wins, duel, time, boss });
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
        const rows = await db.prepare("SELECT id, text, ts, same FROM wall WHERE reports < 3 ORDER BY id DESC LIMIT 80").all();
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
