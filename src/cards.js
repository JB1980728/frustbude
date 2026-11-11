/* ======================= Tool-Karten: Kartenspiel-Logik (läuft im Browser und auf dem Server) ======================= */
const CARDS = (() => {
  // 4 Farben = 4 Tool-Gruppen
  const GROUPS = {
    komm:   { name: "Kommunikation", short: "Komm.",  color: "#3b82f6", tools: ["slack", "meet", "classroom", "coda"] },
    design: { name: "Design",        short: "Design", color: "#d946ef", tools: ["figma", "miro", "stitch", "wix", "onepage"] },
    ki:     { name: "KI",            short: "KI",     color: "#22c55e", tools: ["chatgpt", "claude", "gemini"] },
    daten:  { name: "Analyse",       short: "Analyse",color: "#f59e0b", tools: ["ga", "posthog", "clarity", "mixpanel", "amplitude", "umami", "contentsquare"] },
  };
  const COLORS = Object.keys(GROUPS);
  const HAND = 7, CALL_PENALTY = 2;

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function newDeck() {
    const d = []; let id = 0;
    for (const c of COLORS) {
      const tl = GROUPS[c].tools; let k = 0;
      const add = v => d.push({ id: id++, c, v, tool: tl[(k++) % tl.length] });
      add("0");
      for (let n = 1; n <= 9; n++) { add(String(n)); add(String(n)); }
      for (const v of ["skip", "rev", "d2"]) { add(v); add(v); }
    }
    for (let i = 0; i < 4; i++) { d.push({ id: id++, c: "w", v: "wild", tool: "joker" }); d.push({ id: id++, c: "w", v: "w4", tool: "boss" }); }
    return shuffle(d);
  }

  function newGame(players) {
    const g = { deck: newDeck(), pile: [], hands: {}, order: players.map(p => p.id), names: {}, bots: {}, turn: 0, dir: 1, color: null,
      phase: "play", winner: null, pending: null, ev: [], seq: 0, turnAt: Date.now() };
    players.forEach(p => { g.names[p.id] = p.name; g.bots[p.id] = !!p.bot; g.hands[p.id] = []; });
    for (let r = 0; r < HAND; r++) for (const id of g.order) g.hands[id].push(g.deck.pop());
    // Erste Karte: immer eine Zahlenkarte
    let i = g.deck.findIndex(c => c.c !== "w" && /^\d$/.test(c.v)); const first = g.deck.splice(i, 1)[0];
    g.pile.push(first); g.color = first.c;
    g.turn = (Math.random() * g.order.length) | 0;
    return g;
  }

  const top = g => g.pile[g.pile.length - 1];
  const cur = g => g.order[g.turn];
  const nextIdx = (g, steps = 1) => { const n = g.order.length; return ((g.turn + g.dir * steps) % n + n) % n; };
  function canPlay(g, card) { const t = top(g); return card.c === "w" || card.c === g.color || card.v === t.v; }
  function draw(g, id, n) {
    const got = [];
    for (let i = 0; i < n; i++) {
      if (!g.deck.length) { const t = g.pile.pop(); g.deck = shuffle(g.pile); g.pile = [t]; if (!g.deck.length) break; }
      const c = g.deck.pop(); g.hands[id].push(c); got.push(c);
    }
    g.ev.push({ k: "draw", id, n: got.length, s: ++g.seq });
    return got;
  }
  function advance(g, steps = 1) { g.turn = nextIdx(g, steps); g.pending = null; g.turnAt = Date.now(); }

  // a = {t:"play", cid, color, call} | {t:"draw"} | {t:"keep"}
  function act(g, id, a) {
    if (g.phase !== "play" || cur(g) !== id || !a) return false;
    const hand = g.hands[id];
    if (a.t === "draw") {
      if (g.pending) return false;
      const [c] = draw(g, id, 1);
      if (c && canPlay(g, c)) { g.pending = { id, cid: c.id }; g.turnAt = Date.now(); }
      else advance(g);
      return true;
    }
    if (a.t === "keep") { if (!g.pending) return false; advance(g); return true; }
    if (a.t !== "play") return false;
    const i = hand.findIndex(c => c.id === a.cid); if (i < 0) return false;
    const card = hand[i];
    if (g.pending && g.pending.cid !== card.id) return false;
    if (!canPlay(g, card)) return false;
    if (card.c === "w" && !COLORS.includes(a.color)) return false;
    hand.splice(i, 1); g.pile.push(card); if (g.pile.length > 40) g.pile.splice(0, g.pile.length - 40);
    g.color = card.c === "w" ? a.color : card.c;
    g.ev.push({ k: "play", id, card, color: g.color, s: ++g.seq });
    if (!hand.length) { g.phase = "over"; g.winner = id; g.pending = null; g.ev.push({ k: "win", id, s: ++g.seq }); return true; }
    if (hand.length === 1) {
      if (a.call) g.ev.push({ k: "call", id, s: ++g.seq });
      else { g.ev.push({ k: "forgot", id, s: ++g.seq }); draw(g, id, CALL_PENALTY); }
    }
    const two = g.order.length === 2;
    if (card.v === "skip") { g.ev.push({ k: "skip", id: g.order[nextIdx(g)], s: ++g.seq }); advance(g, 2); }
    else if (card.v === "rev") { g.dir *= -1; g.ev.push({ k: "rev", dir: g.dir, s: ++g.seq }); advance(g, two ? 2 : 1); }
    else if (card.v === "d2" || card.v === "w4") {
      const victim = g.order[nextIdx(g)]; draw(g, victim, card.v === "d2" ? 2 : 4);
      g.ev.push({ k: "skip", id: victim, s: ++g.seq }); advance(g, 2);
    } else advance(g);
    return true;
  }

  // Bot: spielt passende Karten, Joker zuletzt, sucht die Farbe, von der er am meisten hat
  function bestColor(hand) { const n = {}; COLORS.forEach(c => n[c] = 0); hand.forEach(c => { if (c.c !== "w") n[c.c]++; }); return COLORS.reduce((a, b) => n[b] > n[a] ? b : a, COLORS[(Math.random() * 4) | 0]); }
  function botMove(g, id) {
    const hand = g.hands[id];
    if (g.pending) { const c = hand.find(x => x.id === g.pending.cid); return c ? { t: "play", cid: c.id, color: bestColor(hand.filter(x => x !== c)), call: Math.random() < .9 } : { t: "keep" }; }
    const ok = hand.filter(c => canPlay(g, c));
    if (!ok.length) return { t: "draw" };
    const nextCount = g.hands[g.order[nextIdx(g)]].length;
    const score = c => (c.c === "w" ? (c.v === "w4" ? (nextCount <= 2 ? 50 : -20) : -10) : 0) + (["skip", "d2", "rev"].includes(c.v) ? (nextCount <= 3 ? 30 : 5) : 0) + (c.c === g.color ? 3 : 0) + Math.random() * 4;
    const c = ok.sort((a, b) => score(b) - score(a))[0];
    return { t: "play", cid: c.id, color: c.c === "w" ? bestColor(hand.filter(x => x !== c)) : undefined, call: Math.random() < .9 };
  }

  // Was ein Spieler sehen darf: eigene Karten offen, von den anderen nur die Anzahl
  function view(g, forId) {
    return { phase: g.phase, winner: g.winner, turn: cur(g), dir: g.dir, color: g.color, top: top(g), under: g.pile.slice(-4, -1), deck: g.deck.length, turnAt: g.turnAt,
      players: g.order.map(id => ({ id, name: g.names[id], bot: g.bots[id], n: g.hands[id].length })),
      hand: forId && g.hands[forId] ? g.hands[forId] : null, pending: g.pending && g.pending.id === forId ? g.pending.cid : null,
      playable: forId && g.hands[forId] && cur(g) === forId && g.phase === "play" ? g.hands[forId].filter(c => (!g.pending || c.id === g.pending.cid) && canPlay(g, c)).map(c => c.id) : [] };
  }

  return { GROUPS, COLORS, newGame, act, botMove, view, canPlay, cur };
})();
