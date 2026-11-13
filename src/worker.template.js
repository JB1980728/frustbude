// Frustbude – Cloudflare Worker + Durable Object (Mehrspieler-Räume)
// Speichert den gemeinsamen Frust-Zähler, die anonyme Frust-Wand und die Ranglisten in D1.
// Es werden KEINE IP-Adressen gespeichert. Ranglisten zeigen nur frei gewählte Spitznamen.
import { DurableObject } from "cloudflare:workers";

const HTML = __HTML__;
const OG_JPG = "__OG__";
const ICON_PNG = "__ICON__";
const ASSETS = __ASSETS__;

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
  // Spitznamen: nur Buchstaben (plus Leerzeichen und Bindestrich), max. 12 Zeichen
  const t = String(n || "").normalize("NFC").replace(/[^\p{L} \-]/gu, "").replace(/\s+/g, " ").replace(/^[ \-]+|[ \-]+$/g, "").slice(0, 12).trim();
  if (t.length < 2 || isBlocked(t)) return "";
  return t;
}
function cleanBadge(b) { return cleanText(b, 8).replace(/\s/g, ""); }
// Chat: kurz, ohne Links und Beleidigungen; nur im Arbeitsspeicher
function chatCheck(c, raw) {
  const now = Date.now();
  if (!c.name || c.name === "Anonym") return { err: "Leg erst einen Spitznamen an, dann kannst du chatten." };
  if (now - (c.lastChat || 0) < 1200) return { err: "Nicht so schnell 🙂" };
  const text = cleanText(raw, 140).replace(/\n/g, " ");
  if (text.length < 1) return { err: "" };
  if (isBlocked(text)) return { err: "Das enthält Wörter oder Links, die hier nicht erlaubt sind." };
  c.lastChat = now;
  return { msg: { t: "chat", id: now + "-" + Math.random().toString(36).slice(2, 6), name: c.name, text, ts: now } };
}
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
  for (const col of ["best_time_hard", "best_ko", "best_ko_hard", "boss_time", "boss_time_hard"]) { try { await db.prepare(`ALTER TABLE lb ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`).run(); } catch (e) {} }
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
    this.st = { code: "", phase: "lobby", format: "1v1", level: "easy", hostId: null, round: 0, tool: null };
    this.bots = [];
    this.g = null;
    this.tick = null;
    this.chat = [];
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
  fillBots() {
    const used = new Set(this.bots.map(b => b.name)), added = [];
    while (this.players().length < this.cap()) {
      const name = BOT_NAMES.find(n => !used.has(n)) || "Bot"; used.add(name);
      const b = { id: "bot" + Math.random().toString(36).slice(2, 7), isBot: true, name, badge: "🤖", role: "player", team: "A" };
      this.joinTeam(b); this.bots.push(b); added.push(name);
    }
    return added;
  }
  cap() { return this.st.format === "2v2" ? 4 : 2; }
  dropBot() { if (!this.bots.length) return; const a = this.players().filter(p => p.team === "A").length, b = this.players().filter(p => p.team === "B").length; const team = a >= b ? "A" : "B"; let i = this.bots.findIndex(x => x.team === team); if (i < 0) i = 0; this.bots.splice(i, 1); }
  pub(c) { return { id: c.id, isBot: !!c.isBot, name: c.name, badge: c.badge, role: c.role, team: c.team }; }
  state() {
    return { t: "state", now: Date.now(), code: this.st.code, phase: this.st.phase, format: this.st.format, level: this.st.level, hostId: this.st.hostId, round: this.st.round, tool: this.st.tool,
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
      if (this.chat.length) this.send(c, { t: "chatlog", msgs: this.chat });
      this.sync();
      return;
    }
    if (!c.joined) return;

    if (m.t === "act" && st.phase === "live" && this.g && c.role === "player") {
      if (m.a === "hit") { const n = Math.max(1, Math.min(4, Math.floor(Number(m.n) || 1))); for (let i = 0; i < n; i++) FIGHT.act(this.g, c.id, "hit"); }
      else if (m.a === "grab") FIGHT.act(this.g, c.id, "grab", Math.floor(Number(m.id) || 0));
      return;
    }
    if (m.t === "chat") { const r = chatCheck(c, m.text); if (r.err !== undefined) { if (r.err) this.send(c, { t: "chatErr", msg: r.err }); return; }
      this.chat.push(r.msg); if (this.chat.length > 15) this.chat.shift(); this.broadcast(r.msg); return; }
    if (m.t === "react" && REACTIONS.includes(m.e) && now - c.lastReact > 350) { c.lastReact = now; this.broadcast({ t: "react", e: m.e }); return; }
    if (m.t === "rematch" && st.phase === "results") {
      st.phase = "lobby"; this.g = null;
      // 2 gegen 2: Bei jeder Revanche werden die Teams neu gemischt – so spielt jeder mal mit und gegen jeden
      if (st.format === "2v2") { const ps = this.players().slice(0, 4); if (ps.length === 4) { const pairs = [[0, 1], [0, 2], [0, 3]], pr = pairs[st.round % 3]; ps.forEach((p, i) => { p.team = pr.includes(i) ? "A" : "B"; }); } }
      this.broadcast({ t: "feed", txt: `${c.name} will eine Revanche! ⚔️` + (st.format === "2v2" ? " Die Teams werden neu gemischt." : "") });
      this.sync(); return;
    }
    if (st.phase !== "lobby") return;

    if (m.t === "tool" && TOOL_IDS.includes(m.tool) && st.hostId === c.id) { st.tool = m.tool; this.sync(); return; }
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
    if (m.t === "bots") { this.fillBots(); this.sync(); return; }
    if (m.t === "nobots") { this.bots = []; this.sync(); return; }
    if (m.t === "start") {
      // 2 gegen 2 mit weniger als 4 Leuten: freie Plätze übernimmt ein Bot
      if (st.format === "2v2" && this.players().length >= 2 && this.players().length < 4) {
        const added = this.fillBots();
        if (added.length) { this.broadcast({ t: "feed", txt: `🤖 ${added.join(" und ")} ${added.length > 1 ? "springen" : "springt"} ein, damit es 2 gegen 2 wird.` }); this.sync(); }
      }
      const ps = this.players();
      if (!ps.some(p => p.team === "A") || !ps.some(p => p.team === "B")) { this.send(c, { t: "error", msg: "Im anderen Team fehlt noch jemand." }); return; }
      if (!st.tool) st.tool = TOOL_IDS[(Math.random() * TOOL_IDS.length) | 0];
      this.g = FIGHT.newFight({ tool: st.tool, players: ps.map(p => ({ id: p.id, team: p.team, name: p.name, bot: !!p.isBot, level: st.level })) });
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
          .bind(c.sid, c.name, c.badge, g.winner === g.players[c.id].team ? 1 : 0, Math.round(g.players[c.id].st.hits), Date.now()));
      if (stmts.length) await db.batch(stmts);
    } catch (e) {}
  }

  onClose(c) {
    if (!this.conns.has(c.id)) return;
    this.conns.delete(c.id);
    const st = this.st;
    if (st.hostId === c.id) { const p = this.humans()[0]; st.hostId = p ? p.id : null; }
    // Wer mitten im Kampf geht, wird von einem Bot ersetzt
    if (this.g && st.phase === "live" && this.g.players[c.id]) { const p = this.g.players[c.id]; p.bot = true; p.level = st.level; p.name = p.name + " (Bot)"; }
    if (c.joined) { this.broadcast({ t: "feed", txt: `${c.name} hat den Raum verlassen.` }); this.sync(); }
    if (![...this.conns.values()].some(x => x.joined)) { clearInterval(this.tick); this.g = null; this.bots = []; st.phase = "lobby"; }
  }
}

/* ======================= Tool-Karten-Tisch (Kartenspiel, bis zu 4 Spieler) ======================= */
__CARDS__
const TURN_MS = 30000;
const CARD_REACTS = ["😂","😱","🔥","👏","🍅","😤","🙈","❤️"];
export class Table extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.conns = new Map(); this.bots = []; this.st = { code: "", phase: "lobby", hostId: null, round: 0 }; this.g = null; this.botT = null; this.turnT = null; }
  async fetch(req) {
    const url = new URL(req.url);
    if (!this.st.code) this.st.code = (url.searchParams.get("code") || "").toUpperCase().slice(0, 8);
    if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket erwartet", { status: 426 });
    if (this.conns.size >= 16) return new Response("Tisch voll", { status: 429 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept();
    const c = { id: crypto.randomUUID().slice(0, 8), ws: server, name: "", badge: "", sid: "", role: "spectator", joined: false, msgs: 0, msgWin: Date.now() };
    this.conns.set(c.id, c);
    server.addEventListener("message", e => this.onMsg(c, e.data));
    server.addEventListener("close", () => this.onClose(c)); server.addEventListener("error", () => this.onClose(c));
    return new Response(null, { status: 101, webSocket: client });
  }
  send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) {} }
  humans() { return [...this.conns.values()].filter(c => c.joined && c.role === "player"); }
  players() { return [...this.humans(), ...this.bots]; }
  report(close) {
    if (!this.env.LOBBY || !this.st.code) return;
    const hum = this.humans(), host = this.conns.get(this.st.hostId);
    const body = close ? { code: this.st.code, close: true } : { code: this.st.code, name: host ? host.name : (hum[0] ? hum[0].name : ""), count: hum.length, live: this.st.phase !== "lobby", title: this.players().map(p => (p.isBot ? "🤖 " : "") + p.name).join(", ") };
    const key = JSON.stringify(body); if (!close && key === this.lastRep && Date.now() - (this.lastRepT || 0) < 20000) return; this.lastRep = key; this.lastRepT = Date.now();
    try { this.ctx.waitUntil(this.env.LOBBY.get(this.env.LOBBY.idFromName("main")).fetch("https://lobby/report", { method: "POST", body: JSON.stringify(body) }).catch(() => {})); } catch (e) {}
    if (!close && !this.repT) this.repT = setInterval(() => { if (![...this.conns.values()].some(x => x.joined)) { clearInterval(this.repT); this.repT = null; return; } this.lastRepT = 0; this.report(); }, 20000);
  }
  sync() {
    this.report();
    const people = [...[...this.conns.values()].filter(c => c.joined), ...this.bots].map(p => ({ id: p.id, name: p.name, badge: p.badge, role: p.role, isBot: !!p.isBot }));
    for (const c of this.conns.values()) if (c.joined) this.send(c, { t: "state", code: this.st.code, phase: this.st.phase, hostId: this.st.hostId, you: c.id, people, game: this.g ? CARDS.view(this.g, c.id) : null, ev: this.g ? this.g.ev : [] });
    if (this.g) this.g.ev = [];
  }
  fill() { const used = new Set(this.bots.map(b => b.name)); while (this.players().length < 4) { const name = BOT_NAMES.find(n => !used.has(n)) || "Bot"; used.add(name); this.bots.push({ id: "bot" + Math.random().toString(36).slice(2, 7), isBot: true, name, badge: "🤖", role: "player" }); } }
  onMsg(c, raw) {
    if (typeof raw !== "string" || raw.length > 400) return;
    const now = Date.now(); if (now - c.msgWin > 1000) { c.msgWin = now; c.msgs = 0; } if (++c.msgs > 20) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const st = this.st;
    if (m.t === "join" && !c.joined) {
      c.name = cleanName(m.name) || "Anonym"; c.badge = cleanBadge(m.badge); c.sid = cleanSid(m.sid); c.joined = true;
      if (st.phase === "lobby" && this.players().length >= 4 && this.bots.length) this.bots.pop();
      if (st.phase === "lobby" && this.players().length < 4) { c.role = "player"; if (!st.hostId || !this.conns.has(st.hostId)) st.hostId = c.id; }
      this.send(c, { t: "welcome", you: c.id, role: c.role }); this.sync(); return;
    }
    if (!c.joined) return;
    // Emoji-Reaktionen am Tisch (auch Zuschauer), höchstens ~3 pro Sekunde
    if (m.t === "react" && CARD_REACTS.includes(m.e)) {
      if (now - (c.lastReact || 0) < 300) return; c.lastReact = now;
      const o = JSON.stringify({ t: "react", id: c.id, name: c.name, e: m.e });
      for (const x of this.conns.values()) if (x.joined) { try { x.ws.send(o); } catch (e) {} }
      return;
    }
    if (m.t === "act" && st.phase === "play" && this.g && c.role === "player") {
      const a = { t: String(m.a || ""), cid: Math.floor(Number(m.cid)), color: m.color, call: !!m.call };
      if (CARDS.act(this.g, c.id, a)) this.after();
      return;
    }
    if (m.t === "again" && st.phase === "over") {
      st.phase = "lobby"; this.g = null;
      // Zuschauer dürfen in der nächsten Runde mitspielen (Bots machen Platz)
      for (const x of this.conns.values()) if (x.joined && x.role !== "player") { if (this.players().length >= 4 && this.bots.length) this.bots.pop(); if (this.players().length < 4) x.role = "player"; }
      this.sync(); return;
    }
    if (st.phase !== "lobby" || st.hostId !== c.id) return;
    if (m.t === "bots") { if (this.bots.length && this.players().length >= 4) this.bots = []; else this.fill(); this.sync(); return; }
    if (m.t === "start") {
      this.fill(); // freie Plätze übernehmen Bots
      const ps = this.players().slice(0, 4);
      this.g = CARDS.newGame(ps.map(p => ({ id: p.id, name: p.name, bot: !!p.isBot })));
      st.phase = "play"; st.round++; this.after(); return;
    }
  }
  // Nach jedem Zug: allen den neuen Stand schicken, Bots ziehen lassen, Zeitlimit stellen
  after() {
    const g = this.g; clearTimeout(this.botT); clearTimeout(this.turnT);
    if (g.phase === "over") { this.st.phase = "over"; this.sync(); return; }
    this.sync();
    const id = CARDS.cur(g);
    if (g.bots[id]) { this.botT = setTimeout(() => { if (this.g === g && CARDS.cur(g) === id && g.phase === "play") { CARDS.act(g, id, CARDS.botMove(g, id)); this.after(); } }, 900 + Math.random() * 700); return; }
    // Wer 30 Sekunden nichts tut, für den spielt kurz der Bot (damit niemand ewig wartet)
    this.turnT = setTimeout(() => { if (this.g === g && CARDS.cur(g) === id && g.phase === "play") { g.ev.push({ k: "slow", id, s: ++g.seq }); CARDS.act(g, id, CARDS.botMove(g, id)); this.after(); } }, TURN_MS);
  }
  onClose(c) {
    if (!this.conns.has(c.id)) return; this.conns.delete(c.id);
    const st = this.st;
    if (st.hostId === c.id) { const p = this.humans()[0]; st.hostId = p ? p.id : null; }
    // Wer mitten im Spiel geht, wird von einem Bot ersetzt
    if (this.g && st.phase === "play" && this.g.hands[c.id]) { this.g.bots[c.id] = true; this.g.names[c.id] += " (Bot)"; if (CARDS.cur(this.g) === c.id) this.after(); }
    if (![...this.conns.values()].some(x => x.joined)) { clearTimeout(this.botT); clearTimeout(this.turnT); this.g = null; this.bots = []; st.phase = "lobby"; this.report(true); clearInterval(this.repT); this.repT = null; return; }
    this.sync();
  }
}

/* ======================= Treffpunkt: Wer ist online, offene Duelle, Herausforderungen ======================= */
export class Lobby extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.conns = new Map(); this.rooms = new Map(); this.syncT = null; this.chat = []; this.loaded = false; }
  // Chat für alle: bleibt 23 Stunden gespeichert, danach verschwindet er
  // Kompletter Neustart am 11.11.2026: älterer Chat wird verworfen
  fresh() { const cut = Math.max(Date.now() - 23 * 3600000, 1794384789882); this.chat = this.chat.filter(x => x.ts > cut); return this.chat; }
  async fetch(req) {
    if (!this.loaded) { this.loaded = true; try { this.chat = (await this.ctx.storage.get("chat")) || []; } catch (e) { this.chat = []; } this.fresh(); }
    // Kartentische melden sich selbst (unabhängig vom Handy des Gastgebers)
    if (req.method === "POST" && new URL(req.url).pathname === "/report") {
      let m = {}; try { m = await req.json(); } catch (e) {}
      const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (code.length >= 4) {
        if (m.close) this.rooms.delete(code);
        else { const r = this.rooms.get(code); this.rooms.set(code, { code, by: "srv", name: cleanName(m.name) || "Jemand", format: "cards", count: Math.max(0, Math.min(4, m.count | 0)), cap: 4, ts: Date.now(), ch: m.live ? 0 : (r ? r.ch : 0), live: !!m.live, title: cleanText(m.title || "", 70).replace(/\n/g, " ") }); }
        this.sync();
      }
      return new Response("ok");
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket erwartet", { status: 426 });
    if (this.conns.size >= 300) return new Response("Voll", { status: 429 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept();
    const c = { id: crypto.randomUUID().slice(0, 8), ws: server, name: "", sid: "", busy: false, lastCh: 0, msgs: 0, msgWin: Date.now(), seen: Date.now() };
    this.conns.set(c.id, c);
    // Wer sich 20 Sekunden nicht meldet (Handy gesperrt, App zu), fliegt aus der Online-Liste
    if (!this.sweep) this.sweep = setInterval(() => { const now = Date.now(); for (const o of this.conns.values()) if (now - o.seen > 20000) { try { o.ws.close(1000, "timeout"); } catch (e) {} this.drop(o); } if (!this.conns.size) { clearInterval(this.sweep); this.sweep = null; } }, 5000);
    server.addEventListener("message", e => { c.seen = Date.now(); this.onMsg(c, e.data); });
    const bye = () => this.drop(c);
    server.addEventListener("close", bye); server.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }
  drop(c) { if (!this.conns.has(c.id)) return; this.conns.delete(c.id); for (const [k, r] of this.rooms) if (r.by === c.id) this.rooms.delete(k); this.sync(); }
  send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) {} }
  view() {
    const people = [...this.conns.values()].map(c => ({ name: c.name || null, busy: !!c.busy, act: c.act || "" }));
    const rooms = [...this.rooms.values()].filter(r => Date.now() - r.ts < (r.by === "srv" ? 50000 : 30 * 60000)).map(r => ({ code: r.code, name: r.name, format: r.format, count: r.count, cap: r.cap, ch: r.ch ? Math.round((Date.now() - r.ch) / 1000) : null, live: !!r.live, title: r.title || "" }));
    return { t: "online", people, rooms };
  }
  sync() { if (this.syncT) return; this.syncT = setTimeout(() => { this.syncT = null; const s = JSON.stringify(this.view()); for (const c of this.conns.values()) { try { c.ws.send(s); } catch (e) {} } }, 120); }
  onMsg(c, raw) {
    if (typeof raw !== "string" || raw.length > 500) return;
    const now = Date.now(); if (now - c.msgWin > 5000) { c.msgWin = now; c.msgs = 0; } if (++c.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (m.t === "ping") return;
    if (m.t === "hello" || m.t === "status") { c.name = cleanName(m.name) || ""; c.sid = cleanSid(m.sid); c.busy = !!m.busy; c.act = ["cards", "cardsBots", "duel", "free", "boss", "time", "tap", "zen"].includes(m.act) ? m.act : ""; if (m.t === "hello") { this.send(c, this.view()); this.send(c, { t: "chatlog", msgs: this.fresh() }); } this.sync(); return; }
    if (m.t === "chat") { const r = chatCheck(c, m.text); if (r.err !== undefined) { if (r.err) this.send(c, { t: "chatErr", msg: r.err }); return; }
      this.fresh(); this.chat.push(r.msg); if (this.chat.length > 150) this.chat.shift(); this.ctx.storage.put("chat", this.chat).catch(() => {}); const s = JSON.stringify(r.msg); for (const o of this.conns.values()) { try { o.ws.send(s); } catch (e) {} } return; }
    if (m.t === "open" && code.length >= 4) {
      const fmt = m.format === "2v2" || m.format === "cards" ? m.format : "1v1", cap = fmt === "1v1" ? 2 : 4, count = Math.max(1, Math.min(cap, Math.floor(Number(m.count) || 1)));
      const r = this.rooms.get(code); if (r && r.by !== c.id) return;
      if (!r && [...this.rooms.values()].filter(x => x.by === c.id).length >= 2) return;
      this.rooms.set(code, { code, by: c.id, name: c.name || "Jemand", format: fmt, count, cap, ts: now, ch: m.live ? 0 : (r ? r.ch : 0), live: !!m.live, title: m.live ? cleanText(m.title, 70).replace(/\n/g, " ") : "" }); this.sync(); return;
    }
    if (m.t === "close" && code) { const r = this.rooms.get(code); if (r && r.by === c.id) { this.rooms.delete(code); this.sync(); } return; }
    if (m.t === "challenge" && code && now - c.lastCh > 20000) {
      const r = this.rooms.get(code); if (!r || (r.by !== c.id && !(r.by === "srv" && r.format === "cards"))) return;
      c.lastCh = now; r.ch = now; this.sync(); const s = JSON.stringify({ t: "challenge", code, name: c.name || "Jemand", format: r.format, ts: now });
      for (const o of this.conns.values()) if (o !== c) { try { o.ws.send(s); } catch (e) {} }
      this.send(c, { t: "challenged", n: this.conns.size - 1 }); return;
    }
  }
}

/* ======================= Worker ======================= */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Vorschaubild für geteilte Links und App-Symbol
    if (req.method === "GET" && ASSETS[path]) {
      const [type, b64] = ASSETS[path], bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": type, "cache-control": "public, max-age=604800" } });
    }
    if (req.method === "GET" && (path === "/og.jpg" || path === "/icon.png")) {
      const b64 = path === "/og.jpg" ? OG_JPG : ICON_PNG, bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": path === "/og.jpg" ? "image/jpeg" : "image/png", "cache-control": "public, max-age=86400" } });
    }
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }

    // Treffpunkt (WebSocket)
    if (path === "/api/lobby") {
      if (!env.LOBBY) return json({ error: "no_lobby" }, 503);
      return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(req);
    }

    // Tool-Karten-Tisch (WebSocket)
    const tb = path.match(/^\/api\/table\/([A-Z0-9]{4,8})$/);
    if (tb) {
      if (!env.TABLES) return json({ error: "no_tables" }, 503);
      const u = new URL(req.url); u.searchParams.set("code", tb[1]);
      return env.TABLES.get(env.TABLES.idFromName(tb[1])).fetch(new Request(u.toString(), req));
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
        } else if (b.kind === "ko" || b.kind === "koHard") {
          const col = b.kind === "koHard" ? "best_ko_hard" : "best_ko", score = Math.max(0, Math.min(200, Math.floor(Number(b.score) || 0)));
          await db.prepare(`INSERT INTO lb (sid, name, badge, ${col}, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, ${col} = MAX(${col}, excluded.${col}), ts = excluded.ts`)
            .bind(sid, name, badge, score, Date.now()).run();
        } else if (b.kind === "bossTime" || b.kind === "bossTimeHard") {
          // Endgegner-Bestzeit: kleiner ist besser (mindestens 5 s, damit nichts Unsinniges reinkommt)
          const col = b.kind === "bossTimeHard" ? "boss_time_hard" : "boss_time", ms = Math.floor(Number(b.score) || 0);
          if (ms >= 5000 && ms <= 3600000) await db.prepare(`INSERT INTO lb (sid, name, badge, ${col}, boss, ts) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(sid) DO UPDATE SET name = excluded.name, badge = excluded.badge, ${col} = CASE WHEN ${col} = 0 OR excluded.${col} < ${col} THEN excluded.${col} ELSE ${col} END, boss = boss + 1, ts = excluded.ts`)
            .bind(sid, name, badge, ms, Date.now()).run();
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
        // Duell: alle, die schon ein Duell gespielt haben – auch mit 0 Siegen
        const winsQ = db.prepare("SELECT name, badge, wins AS v, duels AS d FROM lb WHERE duels > 0 ORDER BY wins DESC, duels DESC, ts ASC LIMIT 30").all().then(r => r.results || []);
        const qt = col => db.prepare(`SELECT name, badge, ${col} AS v FROM lb WHERE ${col} > 0 ORDER BY ${col} ASC, ts ASC LIMIT 15`).all().then(r => r.results || []);
        const [wins, duel, time, timeHard, boss, bossTime, bossTimeHard] = await Promise.all([winsQ, q("best_duel"), q("best_ko"), q("best_ko_hard"), q("boss"), qt("boss_time"), qt("boss_time_hard")]);
        return json({ wins, duel, time, timeHard, boss, bossTime, bossTimeHard });
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
