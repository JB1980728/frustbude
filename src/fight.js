/* ============ Frustbude-Duell: Kampf-Logik im Tekken-Stil (läuft im Browser UND auf dem Server) ============ */
const FIGHT = (() => {
  const HP = 1000, ROUND = 45, WIN_ROUNDS = 2, MAX_ROUNDS = 5;
  const MOVES = {
    jab:   { start: .09, dmg: 34, block: .2, cd: .3,  stun: .14, ok: 1 },
    heavy: { start: .42, dmg: 100, block: .5, cd: 1.0, stun: .5, ok: 1, brk: .65 },
    ok:    { start: .3,  dmg: 230, block: 1,  cd: .6,  stun: .9, ok: 0 },
  };
  // Stein-Schere-Papier: Schlag unterbricht Haken · Block hält Schläge auf · Haken bricht den Block
  const BOT = { easy: { think: [.55, .9], read: .15, heavyP: 0 }, mid: { think: [.32, .55], read: .4, heavyP: 0 }, hard: { think: [.24, .4], read: .55, heavyP: 0 } };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const other = t => t === "A" ? "B" : "A";

  function fighter(tool) { return { tool, hp: HP, max: HP, act: null, actT: 0, by: null, stun: 0, hitT: 0, guard: false, ok: 0, ko: false }; }

  function newFight(o) {
    const g = { phase: "intro", phaseT: 1.8, round: 1, t: 0, dur: ROUND, wins: { A: 0, B: 0 }, winner: null, roundWinner: null,
      tools: { A: o.tools.A, B: o.tools.B }, f: { A: fighter(o.tools.A), B: fighter(o.tools.B) }, players: {}, ev: [] };
    for (const p of o.players) g.players[p.id] = { id: p.id, team: p.team, name: p.name, bot: !!p.bot, level: p.level || "mid", cd: 0, block: false, botT: rnd(.8, 1.4), botBlockT: 0, st: { dmg: 0, hits: 0, blocks: 0, ok: 0 } };
    return g;
  }

  function guardOf(g, team) {
    const f = g.f[team]; if (f.stun > 0 || f.act) return false;
    return Object.values(g.players).some(p => p.team === team && p.block);
  }

  function act(g, pid, a) {
    const p = g.players[pid]; if (!p) return false;
    if (a === "block1") { p.block = true; return true; }
    if (a === "block0") { p.block = false; return true; }
    if (g.phase !== "fight") return false;
    const f = g.f[p.team];
    // Gedrückt, aber gerade beschäftigt? Kurz merken und sobald wie möglich ausführen
    if (f.stun > 0 || f.act || p.cd > 0 || p.block) { if (!p.bot && a !== "ok") p.buf = { a, t: g.t }; return false; }
    p.buf = null;
    if (a === "ok") { if (f.ok < 100) return false; f.ok = 0; p.st.ok++; }
    else if (a !== "jab" && a !== "heavy") return false;
    const m = MOVES[a];
    f.act = a; f.actT = m.start; f.by = pid; p.cd = m.cd;
    if (a === "jab") { f.jabs = (f.jabs || []).filter(x => g.t - x < 1.2); f.jabs.push(g.t); }
    g.ev.push({ k: "start", team: p.team, move: a });
    return true;
  }

  function land(g, team) {
    const f = g.f[team], m = MOVES[f.act], def = g.f[other(team)], p = g.players[f.by], move = f.act;
    f.act = null;
    if (def.ko) return;
    const blocked = guardOf(g, other(team)) && m.block < 1;
    // Konter: Wer mitten im Ausholen getroffen wird, bekommt mehr ab
    const counter = !blocked && def.act === "heavy" && def.actT > .05;
    let dmg = m.dmg * (blocked ? m.block : 1) * (counter ? 1.5 : 1);
    dmg = Math.round(dmg);
    def.hp = Math.max(0, def.hp - dmg); def.hitT = .18;
    if (p) { p.st.dmg += dmg; if (!blocked) p.st.hits++; }
    f.ok = Math.min(100, f.ok + dmg * .2 * m.ok);
    def.ok = Math.min(100, def.ok + dmg * .12);
    if (counter) { def.act = null; }
    let broke = false;
    if (!blocked) def.stun = Math.max(def.stun, m.stun * (counter ? 1.4 : 1));
    else if (m.brk) { broke = true; def.stun = m.brk; }
    else { Object.values(g.players).forEach(q => { if (q.team === other(team) && q.block) q.st.blocks++; }); f.stun = Math.max(f.stun, .28); }
    g.ev.push({ k: "hit", team, move, dmg, blocked: blocked && !broke, counter, broke });
    if (def.hp <= 0) { def.ko = true; endRound(g, team, true); }
  }

  function endRound(g, winner, ko) {
    if (g.phase !== "fight") return;
    g.roundWinner = winner;
    if (winner === "A" || winner === "B") g.wins[winner]++;
    g.ev.push({ k: "round", winner, ko: !!ko, wins: { ...g.wins } });
    const decided = g.wins.A >= WIN_ROUNDS || g.wins.B >= WIN_ROUNDS || g.round >= MAX_ROUNDS;
    if (decided) {
      g.phase = "over"; g.phaseT = 0;
      g.winner = g.wins.A === g.wins.B ? "draw" : g.wins.A > g.wins.B ? "A" : "B";
      g.ev.push({ k: "over", winner: g.winner });
    } else { g.phase = "roundEnd"; g.phaseT = 2.6; }
  }

  function step(g, dt) {
    if (g.phase === "over") return;
    for (const p of Object.values(g.players)) p.cd = Math.max(0, p.cd - dt);
    if (g.phase === "intro" || g.phase === "roundEnd") {
      g.phaseT -= dt;
      for (const t of ["A", "B"]) { const f = g.f[t]; f.hitT = Math.max(0, f.hitT - dt); }
      if (g.phaseT <= 0) {
        if (g.phase === "roundEnd") {
          g.round++; g.t = 0; g.roundWinner = null;
          for (const t of ["A", "B"]) { const ok = g.f[t].ok; g.f[t] = fighter(g.tools[t]); g.f[t].ok = ok; }
          g.phase = "intro"; g.phaseT = 1.6; g.ev.push({ k: "intro", round: g.round });
        } else { g.phase = "fight"; g.ev.push({ k: "fight" }); }
      }
      return;
    }
    g.t += dt;
    for (const p of Object.values(g.players)) if (p.buf) { const b = p.buf; if (g.t - b.t > .45) p.buf = null; else { p.buf = null; if (!act(g, p.id, b.a) && p.buf) p.buf.t = b.t; } }
    for (const t of ["A", "B"]) {
      const f = g.f[t];
      f.hitT = Math.max(0, f.hitT - dt);
      if (f.stun > 0) { f.stun -= dt; if (f.act) f.act = null; continue; }
      if (f.act) { f.actT -= dt; if (f.actT <= 0) land(g, t); }
      if (g.phase !== "fight") return;
    }
    for (const t of ["A", "B"]) g.f[t].guard = guardOf(g, t);
    if (g.t >= g.dur) {
      const a = g.f.A.hp / g.f.A.max, b = g.f.B.hp / g.f.B.max;
      endRound(g, Math.abs(a - b) < .005 ? "draw" : a > b ? "A" : "B", false);
    }
  }

  function bot(g, pid, dt) {
    const p = g.players[pid]; if (!p || !p.bot) return;
    const L = BOT[p.level] || BOT.mid, me = g.f[p.team], foe = g.f[other(p.team)], foeTeam = other(p.team);
    if (p.botBlockT > 0) { p.botBlockT -= dt; if (p.botBlockT <= 0) p.block = false; }
    if (g.phase !== "fight") { p.block = false; return; }
    // Gegner prallt am Block ab -> sofort zurückschlagen
    if (p.block && foe.stun > .1) { p.block = false; p.botBlockT = 0; p.botT = Math.min(p.botT, rnd(0, L.think[0])); }
    // Haken holt aus -> mit einem schnellen Schlag unterbrechen
    if (foe.act === "heavy" && !p.reacted) {
      p.reacted = true;
      if (Math.random() < L.read) { p.block = false; p.botBlockT = 0; p.botT = Math.min(p.botT, Math.max(0, foe.actT - .2)); p.want = "jab"; }
    }
    if (foe.act !== "heavy") p.reacted = false;
    // Schlag-Hagel -> Deckung hoch
    const spam = (foe.jabs || []).filter(x => g.t - x < 1).length >= 2;
    if (spam && foe.act !== "heavy" && !me.act && me.stun <= 0) {
      if (p.block) { p.botBlockT = Math.max(p.botBlockT, .25); return; }
      if (!p.spamRoll) { p.spamRoll = true; if (Math.random() < L.read) { p.block = true; p.botBlockT = rnd(.5, .9); return; } }
    } else p.spamRoll = false;
    p.botT -= dt; if (p.botT > 0 || me.stun > 0 || me.act) return;
    p.botT = rnd(L.think[0], L.think[1]);
    if (p.want) { const w = p.want; p.want = null; act(g, pid, w); return; }
    if (p.block) return;
    if (me.ok >= 100) { act(g, pid, "ok"); return; }
    // Gegner blockt -> Haken bricht die Deckung
    if (guardOf(g, foeTeam)) return; // Gegner blockt -> abwarten
    act(g, pid, Math.random() < L.heavyP ? "heavy" : "jab");
  }

  const r2 = v => Math.round(v * 100) / 100;
  function snap(g) {
    const fs = t => { const f = g.f[t]; return [Math.round(f.hp), f.act || "", r2(f.actT), r2(f.stun), r2(f.hitT), guardOf(g, t) ? 1 : 0, Math.round(f.ok), f.ko ? 1 : 0]; };
    return { ph: g.phase, pt: r2(g.phaseT), r: g.round, t: r2(g.t), dur: g.dur, w: g.wins, win: g.winner, rw: g.roundWinner, tools: g.tools, A: fs("A"), B: fs("B"),
      pl: Object.fromEntries(Object.values(g.players).map(p => [p.id, { id: p.id, team: p.team, name: p.name, bot: p.bot, cd: r2(p.cd), block: p.block ? 1 : 0, st: p.st }])), ev: g.ev };
  }
  function view(s) {
    const f = a => ({ hp: a[0], max: HP, act: a[1] || null, actT: a[2], stun: a[3], hitT: a[4], guard: !!a[5], ok: a[6], ko: !!a[7] });
    return { phase: s.ph, phaseT: s.pt, round: s.r, t: s.t, dur: s.dur, wins: s.w, winner: s.win, roundWinner: s.rw, tools: s.tools, f: { A: f(s.A), B: f(s.B) }, players: s.pl };
  }
  return { HP, ROUND, WIN_ROUNDS, MOVES, BOT, newFight, act, step, bot, snap, view };
})();
