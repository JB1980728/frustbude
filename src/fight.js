/* ============ Frustbude-Duell: Tauziehen mit der Boxbirne (läuft im Browser UND auf dem Server) ============
   Eine Boxbirne hängt in der Mitte. Jeder Treffer schiebt sie zur Gegenseite.
   Erreicht sie deine Seite, verlierst du die Runde. Wer zuerst 2 Runden gewinnt, gewinnt das Duell. */
const FIGHT = (() => {
  const ROUND = 30, WIN_ROUNDS = 2, MAX_ROUNDS = 5, PUSH = .034, MAX_RATE = 12;
  const BOT = { easy: { rate: [3.2, 4.6] }, hard: { rate: [5.2, 7.2] } };
  const rnd = (a, b) => a + Math.random() * (b - a);

  function newFight(o) {
    const g = { phase: "intro", phaseT: 2, round: 1, t: 0, dur: ROUND, wins: { A: 0, B: 0 }, winner: null, roundWinner: null,
      tool: o.tool, pos: 0, players: {}, ev: [] };
    for (const p of o.players) g.players[p.id] = { id: p.id, team: p.team, name: p.name, bot: !!p.bot, level: p.level === "hard" ? "hard" : "easy", taps: [], botT: 0, botRate: 0, st: { hits: 0 } };
    return g;
  }

  // Ein Treffer schiebt die Boxbirne: Team A (links) schiebt nach rechts, Team B nach links
  function act(g, pid, a) {
    const p = g.players[pid]; if (!p || a !== "hit" || g.phase !== "fight") return false;
    p.taps = p.taps.filter(x => g.t - x < 1);
    if (p.taps.length >= MAX_RATE) return false; // gegen Auto-Klicker
    p.taps.push(g.t); p.st.hits++;
    g.pos += p.team === "A" ? PUSH : -PUSH;
    g.ev.push({ k: "hit", team: p.team, pid });
    if (g.pos >= 1) { g.pos = 1; endRound(g, "A", true); }
    else if (g.pos <= -1) { g.pos = -1; endRound(g, "B", true); }
    return true;
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
        if (g.phase === "roundEnd") { g.round++; g.t = 0; g.pos = 0; g.roundWinner = null; g.phase = "intro"; g.phaseT = 1.6; g.ev.push({ k: "intro", round: g.round }); }
        else { g.phase = "fight"; g.ev.push({ k: "fight" }); }
      }
      return;
    }
    g.t += dt;
    if (g.t >= g.dur) endRound(g, Math.abs(g.pos) < .02 ? "draw" : g.pos > 0 ? "A" : "B", false);
  }

  function bot(g, pid, dt) {
    const p = g.players[pid]; if (!p || !p.bot || g.phase !== "fight") return;
    const L = BOT[p.level] || BOT.easy;
    if (!p.botRate || Math.random() < dt * .5) p.botRate = rnd(L.rate[0], L.rate[1]); // mal schneller, mal langsamer
    p.botT -= dt;
    while (p.botT <= 0) { p.botT += 1 / p.botRate * rnd(.7, 1.3); act(g, pid, "hit"); if (g.phase !== "fight") return; }
  }

  const r3 = v => Math.round(v * 1000) / 1000;
  function snap(g) {
    return { ph: g.phase, pt: Math.round(g.phaseT * 100) / 100, r: g.round, t: Math.round(g.t * 100) / 100, dur: g.dur, w: g.wins, win: g.winner, rw: g.roundWinner, tool: g.tool, pos: r3(g.pos),
      pl: Object.fromEntries(Object.values(g.players).map(p => [p.id, { id: p.id, team: p.team, name: p.name, bot: p.bot, st: p.st }])), ev: g.ev };
  }
  function view(s) { return { phase: s.ph, phaseT: s.pt, round: s.r, t: s.t, dur: s.dur, wins: s.w, winner: s.win, roundWinner: s.rw, tool: s.tool, pos: s.pos, players: s.pl }; }
  return { ROUND, WIN_ROUNDS, PUSH, BOT, newFight, act, step, bot, snap, view };
})();
