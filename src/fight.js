/* ============ Frustbude-Duell: Tauziehen mit der Boxbirne (läuft im Browser UND auf dem Server) ============
   Eine Boxbirne hängt in der Mitte. Jeder Treffer schiebt sie zur Gegenseite.
   Erreicht sie deine Seite, verlierst du die Runde. Wer zuerst 2 Runden gewinnt, gewinnt das Duell. */
const FIGHT = (() => {
  const ROUND = 30, WIN_ROUNDS = 2, MAX_ROUNDS = 5, PUSH = .034, MAX_RATE = 10;
  const BOT = { easy: { rate: [3.2, 4.6], grab: [1.2, 2.2], grabP: .5 }, hard: { rate: [5.2, 7.2], grab: [.55, 1.1], grabP: .85 } };
  // Superkräfte: erscheinen im Feld, wer zuerst tippt, bekommt sie
  const POWERS = { turbo: { e: "⚡", name: "TURBO", dur: 4 }, freeze: { e: "🧊", name: "EINFRIEREN", dur: 2.2 }, mega: { e: "💥", name: "MEGA-SCHLAG" } };
  const RUSH = 10; // letzte 10 Sekunden: Endspurt, jeder Treffer zählt doppelt
  const rnd = (a, b) => a + Math.random() * (b - a);

  function newFight(o) {
    const g = { phase: "intro", phaseT: 2, round: 1, t: 0, dur: ROUND, wins: { A: 0, B: 0 }, winner: null, roundWinner: null,
      tool: o.tool, pos: 0, players: {}, ev: [], pu: null, puT: rnd(5, 7), puN: 1, boost: { A: 0, B: 0 }, frozen: { A: 0, B: 0 }, rush: false };
    for (const p of o.players) g.players[p.id] = { id: p.id, team: p.team, name: p.name, bot: !!p.bot, level: p.level === "hard" ? "hard" : "easy", taps: [], botT: 0, botRate: 0, st: { hits: 0 } };
    return g;
  }

  // Ein Treffer schiebt die Boxbirne: Team A (links) schiebt nach rechts, Team B nach links
  function act(g, pid, a, id) {
    const p = g.players[pid]; if (!p || g.phase !== "fight") return false;
    if (a === "grab") {
      if (!g.pu || g.pu.id !== id) return false;
      // Aufhol-Bonus: Wer vorne liegt, darf erst nach 0,4 Sekunden zugreifen
      const lead = g.pos > .05 ? "A" : g.pos < -.05 ? "B" : null;
      if (lead === p.team && (g.pu.age || 0) < .4) return false;
      const k = g.pu.kind, t = p.team, o = t === "A" ? "B" : "A"; g.pu = null; g.puT = rnd(5, 8);
      if (k === "turbo") g.boost[t] = POWERS.turbo.dur;
      else if (k === "freeze") g.frozen[o] = POWERS.freeze.dur;
      g.ev.push({ k: "grab", team: t, kind: k, pid, name: p.name });
      if (k === "mega") push(g, t, .2);
      return true;
    }
    if (a !== "hit") return false;
    if (g.frozen[p.team] > 0) return false;
    p.taps = p.taps.filter(x => g.t - x < 1);
    if (p.taps.length >= MAX_RATE) return false; // gegen Auto-Klicker
    p.taps.push(g.t); p.st.hits++;
    g.ev.push({ k: "hit", team: p.team, pid });
    push(g, p.team, PUSH * (g.boost[p.team] > 0 ? 2 : 1) * (g.rush ? 2 : 1));
    return true;
  }
  function push(g, team, amt) {
    g.pos += team === "A" ? amt : -amt;
    if (g.pos >= 1) { g.pos = 1; endRound(g, "A", true); }
    else if (g.pos <= -1) { g.pos = -1; endRound(g, "B", true); }
  }

  function endRound(g, winner, ko) {
    if (g.phase !== "fight") return;
    g.roundWinner = winner;
    if (winner === "A" || winner === "B") g.wins[winner]++;
    g.ev.push({ k: "round", winner, ko: !!ko });
    if (g.wins.A >= WIN_ROUNDS || g.wins.B >= WIN_ROUNDS || g.round >= MAX_ROUNDS) {
      g.phase = "over"; g.winner = g.wins.A === g.wins.B ? "draw" : g.wins.A > g.wins.B ? "A" : "B";
      g.ev.push({ k: "over", winner: g.winner });
    } else { g.phase = "roundEnd"; g.phaseT = 2.6; }
  }

  function step(g, dt) {
    if (g.phase === "over") return;
    if (g.phase === "intro" || g.phase === "roundEnd") {
      g.phaseT -= dt;
      if (g.phaseT <= 0) {
        if (g.phase === "roundEnd") { g.round++; g.t = 0; g.pos = 0; g.roundWinner = null; g.pu = null; g.puT = rnd(5, 7); g.boost = { A: 0, B: 0 }; g.frozen = { A: 0, B: 0 }; g.rush = false; g.phase = "intro"; g.phaseT = 1.6; g.ev.push({ k: "intro", round: g.round }); }
        else { g.phase = "fight"; g.ev.push({ k: "fight" }); }
      }
      return;
    }
    g.t += dt;
    for (const t of ["A", "B"]) { g.boost[t] = Math.max(0, g.boost[t] - dt); g.frozen[t] = Math.max(0, g.frozen[t] - dt); }
    if (!g.rush && g.dur - g.t <= RUSH) { g.rush = true; g.ev.push({ k: "rush" }); }
    if (g.pu) { g.pu.t -= dt; g.pu.age = (g.pu.age || 0) + dt; if (g.pu.t <= 0) { g.pu = null; g.puT = rnd(4, 7); } }
    else if (!g.rush || g.dur - g.t > 3) { g.puT -= dt; if (g.puT <= 0) { const kinds = Object.keys(POWERS); const side = Math.random() < .5; // weit weg von der Boxbirne: am linken oder rechten Rand, oben oder unten
      g.pu = { id: g.puN++, kind: kinds[(Math.random() * kinds.length) | 0], x: side ? rnd(.08, .17) : rnd(.83, .92), y: Math.random() < .5 ? rnd(.12, .3) : rnd(.72, .9), t: 3 }; g.ev.push({ k: "pu", kind: g.pu.kind }); } }
    if (g.t >= g.dur) endRound(g, Math.abs(g.pos) < .02 ? "draw" : g.pos > 0 ? "A" : "B", false);
  }

  function bot(g, pid, dt) {
    const p = g.players[pid]; if (!p || !p.bot || g.phase !== "fight") return;
    const L = BOT[p.level] || BOT.easy;
    if (g.pu) { if (p.puSeen !== g.pu.id) { p.puSeen = g.pu.id; p.puWant = Math.random() < L.grabP ? rnd(L.grab[0], L.grab[1]) : -1; } if (p.puWant > 0) { p.puWant -= dt; if (p.puWant <= 0 && !act(g, pid, "grab", g.pu.id) && g.pu) p.puWant = .15; } }
    if (!p.botRate || Math.random() < dt * .5) p.botRate = rnd(L.rate[0], L.rate[1]); // mal schneller, mal langsamer
    p.botT -= dt;
    while (p.botT <= 0) { p.botT += 1 / p.botRate * rnd(.7, 1.3); act(g, pid, "hit"); if (g.phase !== "fight") return; }
  }

  const r3 = v => Math.round(v * 1000) / 1000;
  function snap(g) {
    return { ph: g.phase, pt: Math.round(g.phaseT * 100) / 100, r: g.round, t: Math.round(g.t * 100) / 100, dur: g.dur, w: g.wins, win: g.winner, rw: g.roundWinner, tool: g.tool, pos: r3(g.pos), pu: g.pu ? { id: g.pu.id, kind: g.pu.kind, x: r3(g.pu.x), y: r3(g.pu.y), t: Math.round(g.pu.t * 10) / 10 } : null, bo: { A: Math.round(g.boost.A * 10) / 10, B: Math.round(g.boost.B * 10) / 10 }, fr: { A: Math.round(g.frozen.A * 10) / 10, B: Math.round(g.frozen.B * 10) / 10 }, ru: g.rush,
      pl: Object.fromEntries(Object.values(g.players).map(p => [p.id, { id: p.id, team: p.team, name: p.name, bot: p.bot, st: p.st }])), ev: g.ev };
  }
  function view(s) { return { phase: s.ph, phaseT: s.pt, round: s.r, t: s.t, dur: s.dur, wins: s.w, winner: s.win, roundWinner: s.rw, tool: s.tool, pos: s.pos, pu: s.pu, boost: s.bo || { A: 0, B: 0 }, frozen: s.fr || { A: 0, B: 0 }, rush: !!s.ru, players: s.pl }; }
  return { ROUND, WIN_ROUNDS, PUSH, BOT, POWERS, RUSH, newFight, act, step, bot, snap, view };
})();
