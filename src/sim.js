/* ============ Frustbude-Arena: Spiel-Logik (läuft im Browser UND auf dem Server) ============ */
const SIM = (() => {
  const AW = 18, AH = 32, RIVER = 16, BRIDGES = [3.5, 14.5];
  const CARDS = {
    boxer:  { name: "Boxer",          e: "🥊", cost: 3, type: "unit",  hp: 760,  dmg: 120, hs: 1.1, range: 1.0, speed: 1.25, sight: 5.5, tgt: "any",       r: .55, count: 1, size: 1.35, desc: "Haut alles weg, was ihm vor die Fäuste kommt." },
    tomato: { name: "Tomaten-Werfer", e: "🍅", cost: 3, type: "unit",  hp: 340,  dmg: 95,  hs: 1.2, range: 5.5, speed: 1.0,  sight: 6.5, tgt: "any",       r: .5,  count: 1, size: 1.25, proj: "🍅", desc: "Wirft aus sicherer Entfernung." },
    eggs:   { name: "Eier-Bande",     e: "🥚", cost: 2, type: "unit",  hp: 140,  dmg: 62,  hs: 1.0, range: .8,  speed: 1.7,  sight: 5,   tgt: "any",       r: .35, count: 3, size: 1.0,  desc: "Drei flinke Eier auf einmal." },
    pie:    { name: "Torten-Tank",    e: "🥧", cost: 5, type: "unit",  hp: 2400, dmg: 160, hs: 1.5, range: 1.0, speed: .72,  sight: 7,   tgt: "buildings", r: .8,  count: 1, size: 1.8,  desc: "Langsam, zäh – geht nur auf Tool-Türme." },
    rocket: { name: "Rakete",         e: "🚀", cost: 4, type: "spell", radius: 2.4, dmg: 500, tower: .4, delay: .9, desc: "Großer Flächenschaden, überall." },
    love:   { name: "Liebesbombe",    e: "❤️", cost: 2, type: "spell", radius: 3.0, dmg: 90,  tower: .3, charm: 2.8, delay: .4, desc: "Gegner verlieben sich und machen Pause." },
    dsgvo:  { name: "DSGVO-Keule",    e: "⚖️", cost: 3, type: "spell", radius: 3.2, dmg: 75,  tower: .3, stun: 2.3, delay: .5, desc: "Einwilligung fehlt! Alle im Kreis sind betäubt." },
    banana: { name: "Bananen-Falle",  e: "🍌", cost: 1, type: "trap",  dmg: 150, stun: 1.7, life: 22, desc: "Wer drauftritt, rutscht aus. Nur auf deiner Seite." },
  };
  const DECK = ["boxer", "tomato", "eggs", "pie", "rocket", "love", "dsgvo", "banana"];
  const OVERKILL = { radius: 3.6, dmg: 700, tower: .5, delay: .7 };
  const TW = { princess: { hp: 1600, dmg: 60, hs: .8, range: 7.5, r: 1.35 }, king: { hp: 2800, dmg: 75, hs: 1.0, range: 7.2, r: 1.8 } };
  const LEVEL = { easy: { rate: .7, think: [2.4, 3.6], push: 9.2, smart: 0 }, mid: { rate: 1.0, think: [1.2, 2.0], push: 7.6, smart: .6 }, hard: { rate: 1.28, think: [.6, 1.1], push: 6.4, smart: 1 } };
  const DUR = 150, OT = 60;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const own = (team, y) => team === "A" ? y > RIVER + .6 : y < RIVER - .6;

  function newGame(o) {
    const g = { t: 0, dur: DUR, overtime: false, phase: "play", winner: null, crowns: { A: 0, B: 0 }, units: [], traps: [], spells: [], projs: [], towers: [], players: {}, ev: [], nid: 1, double: false };
    const mk = (team, kind, x, y, tool) => ({ id: "t" + team + kind + (x < 9 ? "L" : x > 9 ? "R" : ""), team, kind, x, y, tool, hp: TW[kind].hp, max: TW[kind].hp, r: TW[kind].r, cd: 0, active: kind !== "king" });
    const tA = o.towers.A, tB = o.towers.B;
    g.towers.push(mk("A", "princess", 3.5, 25.5, tA[0]), mk("A", "princess", 14.5, 25.5, tA[1]), mk("A", "king", 9, 29, tA[2]));
    g.towers.push(mk("B", "princess", 3.5, 6.5, tB[0]), mk("B", "princess", 14.5, 6.5, tB[1]), mk("B", "king", 9, 3, tB[2]));
    for (const p of o.players) {
      const q = shuffle(DECK);
      g.players[p.id] = { id: p.id, team: p.team, name: p.name, bot: !!p.bot, level: p.level || "mid", elixir: 5, hand: q.slice(0, 4), queue: q.slice(4), ok: 0, botT: rnd(1.5, 3), st: { dmg: 0, cards: 0, ok: 0, towers: 0 } };
    }
    return g;
  }

  function canPlace(g, p, card, x, y) {
    if (x < .5 || x > AW - .5 || y < .5 || y > AH - .5) return false;
    const c = CARDS[card];
    if (!c || c.type === "spell") return true;
    return own(p.team, y) && !g.towers.some(t => t.hp > 0 && Math.hypot(t.x - x, t.y - y) < t.r + .3);
  }

  function play(g, pid, card, x, y) {
    const p = g.players[pid];
    if (!p || g.phase !== "play") return false;
    if (card === "overkill") {
      if (p.ok < 100 || p.elixir >= 10 - 1e-6) return false;
      p.ok = 0; p.st.ok++;
      g.spells.push({ id: g.nid++, type: "overkill", team: p.team, owner: pid, x, y, t: OVERKILL.delay, ...OVERKILL });
      g.ev.push({ k: "play", card: "overkill", team: p.team, pid, x, y });
      return true;
    }
    const i = p.hand.indexOf(card), c = CARDS[card];
    if (i < 0 || !c || p.elixir < c.cost - 1e-6) return false;
    if (!canPlace(g, p, card, x, y)) return false;
    p.elixir -= c.cost; p.st.cards++;
    p.hand[i] = p.queue.shift(); p.queue.push(card);
    if (c.type === "unit") {
      for (let k = 0; k < c.count; k++) {
        const a = k / c.count * Math.PI * 2, off = c.count > 1 ? .7 : 0;
        g.units.push({ id: g.nid++, type: card, team: p.team, owner: pid, x: x + Math.cos(a) * off, y: y + Math.sin(a) * off, hp: c.hp, max: c.hp, cd: c.hs * .4, dep: 1, stun: 0, charm: 0, tgt: null, face: p.team === "A" ? -1 : 1 });
      }
    } else if (c.type === "spell") {
      g.spells.push({ id: g.nid++, type: card, team: p.team, owner: pid, x, y, t: c.delay, radius: c.radius, dmg: c.dmg, tower: c.tower, stun: c.stun || 0, charm: c.charm || 0 });
    } else if (c.type === "trap") {
      g.traps.push({ id: g.nid++, team: p.team, owner: pid, x, y, life: c.life });
    }
    g.ev.push({ k: "play", card, team: p.team, pid, x, y });
    return true;
  }

  function credit(g, pid, amt) {
    const p = g.players[pid]; if (!p) return;
    p.st.dmg += amt; p.ok = Math.min(100, p.ok + amt / 14);
  }

  function damageTower(g, t, amt, pid, src) {
    if (t.hp <= 0) return;
    t.hp -= amt; credit(g, pid, amt);
    if (t.kind === "king") t.active = true;
    g.ev.push({ k: "thit", id: t.id, tool: t.tool, team: t.team, x: t.x, y: t.y, dmg: Math.round(amt), src: src || "" });
    if (t.hp <= 0) {
      t.hp = 0;
      const other = t.team === "A" ? "B" : "A";
      const p = g.players[pid]; if (p) p.st.towers++;
      if (t.kind === "king") {
        g.crowns[other] = 3;
        g.towers.filter(x => x.team === t.team).forEach(x => { x.hp = 0; });
      } else {
        g.crowns[other] = Math.min(3, g.crowns[other] + 1);
        const k = g.towers.find(x => x.team === t.team && x.kind === "king"); if (k) k.active = true;
      }
      g.ev.push({ k: "tdead", id: t.id, tool: t.tool, team: t.team, kind: t.kind, x: t.x, y: t.y });
      if (t.kind === "king") end(g, other);
    }
  }

  function damageUnit(g, u, amt, pid) {
    if (u.hp <= 0) return;
    u.hp -= amt; credit(g, pid, amt * .6);
    if (u.hp <= 0) { u.hp = 0; g.ev.push({ k: "die", type: u.type, team: u.team, x: u.x, y: u.y }); }
  }

  function end(g, winner) {
    if (g.phase !== "play") return;
    g.phase = "over"; g.winner = winner;
    g.ev.push({ k: "over", winner });
  }

  function towerTarget(g, u) {
    const enemy = g.towers.filter(t => t.team !== u.team && t.hp > 0);
    const lane = u.x < AW / 2 ? 3.5 : 14.5;
    const pr = enemy.find(t => t.kind === "princess" && t.x === lane);
    if (pr) return pr;
    let best = null, bd = 1e9;
    for (const t of enemy) { const d = dist(u, t); if (d < bd) { bd = d; best = t; } }
    return best;
  }

  function findTarget(g, u, c) {
    if (c.tgt === "any") {
      let best = null, bd = c.sight;
      for (const o of g.units) { if (o.team === u.team || o.hp <= 0) continue; const d = dist(u, o); if (d < bd) { bd = d; best = o; } }
      if (best) return best;
    }
    return towerTarget(g, u);
  }

  function step(g, dt) {
    if (g.phase !== "play") return;
    g.t += dt;
    g.double = g.overtime || (g.dur - g.t) <= 60;
    for (const p of Object.values(g.players)) {
      const rate = p.bot ? LEVEL[p.level].rate : 1;
      p.elixir = Math.min(10, p.elixir + dt / 2.8 * (g.double ? 2 : 1) * rate);
    }
    // Fallen
    for (const tr of g.traps) {
      tr.life -= dt;
      for (const u of g.units) {
        if (u.team === tr.team || u.hp <= 0 || u.dep > 0) continue;
        if (Math.hypot(u.x - tr.x, u.y - tr.y) < .9) {
          tr.life = -1; u.stun = Math.max(u.stun, CARDS.banana.stun); damageUnit(g, u, CARDS.banana.dmg, tr.owner);
          g.ev.push({ k: "slip", x: u.x, y: u.y }); break;
        }
      }
    }
    g.traps = g.traps.filter(t => t.life > 0);
    // Zauber
    for (const s of g.spells) {
      s.t -= dt;
      if (s.t > 0) continue;
      for (const u of g.units) {
        if (u.team === s.team || u.hp <= 0) continue;
        if (Math.hypot(u.x - s.x, u.y - s.y) <= s.radius + .3) {
          damageUnit(g, u, s.dmg, s.owner);
          if (s.stun) u.stun = Math.max(u.stun, s.stun);
          if (s.charm) u.charm = Math.max(u.charm, s.charm);
        }
      }
      for (const t of g.towers) {
        if (t.team === s.team || t.hp <= 0) continue;
        if (Math.hypot(t.x - s.x, t.y - s.y) <= s.radius + t.r * .6) damageTower(g, t, s.dmg * s.tower, s.owner, s.type);
      }
      g.ev.push({ k: "spell", type: s.type, team: s.team, x: s.x, y: s.y, r: s.radius });
    }
    g.spells = g.spells.filter(s => s.t > 0);
    // Geschosse
    for (const pr of g.projs) {
      pr.t -= dt;
      if (pr.t > 0) continue;
      if (pr.tower) { const t = g.towers.find(x => x.id === pr.to); if (t) damageTower(g, t, pr.dmg, pr.owner, pr.src); }
      else { const u = g.units.find(x => x.id === pr.to); if (u) damageUnit(g, u, pr.dmg, pr.owner); }
    }
    g.projs = g.projs.filter(p => p.t > 0);
    if (g.phase !== "play") return;
    // Einheiten
    for (const u of g.units) {
      if (u.hp <= 0) continue;
      const c = CARDS[u.type];
      if (u.dep > 0) { u.dep -= dt; continue; }
      if (u.stun > 0) { u.stun -= dt; continue; }
      if (u.charm > 0) { u.charm -= dt; continue; }
      let tg = u.tgt;
      const valid = tg && tg.hp > 0 && (tg.kind || dist(u, tg) < c.sight + 1.5);
      if (!valid || (tg.kind && c.tgt === "any" && Math.random() < .08)) tg = u.tgt = findTarget(g, u, c);
      if (!tg) continue;
      const reach = c.range + (tg.kind ? tg.r : .35) + c.r * .5;
      const d = dist(u, tg);
      if (d <= reach) {
        u.cd -= dt;
        u.face = tg.y < u.y ? -1 : 1;
        if (u.cd <= 0) {
          u.cd = c.hs;
          if (c.proj) {
            g.projs.push({ t: Math.max(.15, d / 9), to: tg.id, tower: !!tg.kind, dmg: c.dmg, owner: u.owner, src: u.type });
            g.ev.push({ k: "proj", e: c.proj, x: u.x, y: u.y, tx: tg.x, ty: tg.y, d: Math.max(.15, d / 9) });
          } else if (tg.kind) damageTower(g, tg, c.dmg, u.owner, u.type);
          else damageUnit(g, tg, c.dmg, u.owner);
          if (!c.proj) g.ev.push({ k: "hit", src: u.type, x: tg.x + (u.x - tg.x) * .35, y: tg.y + (u.y - tg.y) * .35, team: u.team });
        }
      } else {
        let wx = tg.x, wy = tg.y;
        const cross = (u.y - RIVER) * (tg.y - RIVER) < 0;
        if (cross) {
          const bx = Math.abs(u.x - BRIDGES[0]) < Math.abs(u.x - BRIDGES[1]) ? BRIDGES[0] : BRIDGES[1];
          if (Math.abs(u.x - bx) > .25 || Math.abs(u.y - RIVER) > 1.6) { wx = bx; wy = RIVER + (u.y > RIVER ? .9 : -.9); if (Math.abs(u.y - RIVER) < 1.2) wy = u.y > RIVER ? RIVER - 1 : RIVER + 1; }
        }
        const dx = wx - u.x, dy = wy - u.y, l = Math.hypot(dx, dy) || 1;
        u.x += dx / l * c.speed * dt; u.y += dy / l * c.speed * dt;
        u.face = dy < 0 ? -1 : 1;
      }
    }
    // Abstand halten
    const live = g.units.filter(u => u.hp > 0);
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j], ra = CARDS[a.type].r, rb = CARDS[b.type].r;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || .01, m = (ra + rb) * .8;
      if (d < m) { const push = (m - d) / 2, nx = dx / d, ny = dy / d; a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push; }
    }
    for (const u of live) { u.x = Math.max(.4, Math.min(AW - .4, u.x)); u.y = Math.max(.4, Math.min(AH - .4, u.y)); }
    g.units = g.units.filter(u => u.hp > 0);
    // Türme schießen
    for (const t of g.towers) {
      if (t.hp <= 0 || !t.active) continue;
      t.cd -= dt;
      if (t.cd > 0) continue;
      const T = TW[t.kind];
      let best = null, bd = T.range + t.r;
      for (const u of g.units) { if (u.team === t.team || u.dep > 0) continue; const d = dist(t, u); if (d < bd) { bd = d; best = u; } }
      if (best) {
        t.cd = T.hs; const tt = Math.max(.12, bd / 11);
        g.projs.push({ t: tt, to: best.id, tower: false, dmg: T.dmg, owner: null });
        g.ev.push({ k: "tshot", tool: t.tool, team: t.team, x: t.x, y: t.y - .6, tx: best.x, ty: best.y, d: tt });
      }
    }
    // Zeit
    if (g.t >= g.dur) {
      if (g.crowns.A !== g.crowns.B) end(g, g.crowns.A > g.crowns.B ? "A" : "B");
      else if (!g.overtime) { g.overtime = true; g.dur += OT; g.ev.push({ k: "overtime" }); }
      else {
        const sum = team => g.towers.filter(t => t.team === team).reduce((s, t) => s + t.hp / t.max, 0);
        const a = sum("A"), b = sum("B");
        end(g, Math.abs(a - b) < .01 ? "draw" : a > b ? "A" : "B");
      }
    }
  }

  // ---------------- Bot ----------------
  function bot(g, pid, dt) {
    const p = g.players[pid]; if (!p || g.phase !== "play") return;
    const L = LEVEL[p.level] || LEVEL.mid;
    p.botT -= dt; if (p.botT > 0) return;
    p.botT = rnd(L.think[0], L.think[1]);
    const me = p.team, sideY = y => me === "A" ? Math.max(RIVER + 1.2, Math.min(AH - 1.5, y)) : Math.min(RIVER - 1.2, Math.max(1.5, y));
    const enemyTeam = me === "A" ? "B" : "A";
    const affordable = p.hand.filter(c => CARDS[c].cost <= p.elixir);
    // OVERKILL
    if (p.ok >= 100) {
      const tg = g.towers.filter(t => t.team === enemyTeam && t.hp > 0).sort((a, b) => a.hp - b.hp)[0];
      if (tg && play(g, pid, "overkill", tg.x, tg.y)) return;
    }
    const threats = g.units.filter(u => u.team !== me && own(me, u.y));
    if (threats.length && Math.random() < .5 + L.smart * .5) {
      const th = threats.sort((a, b) => b.hp - a.hp)[0];
      const near = threats.filter(u => dist(u, th) < 3).length;
      if (L.smart > .5 && near >= 2) { const sp = affordable.find(c => c === "dsgvo" || c === "rocket" || c === "love"); if (sp) { play(g, pid, sp, th.x, th.y); return; } }
      const def = affordable.filter(c => CARDS[c].type === "unit" && c !== "pie").sort((a, b) => CARDS[a].cost - CARDS[b].cost)[L.smart > .5 ? 0 : (Math.random() * 3) | 0];
      if (def) { play(g, pid, def, th.x + rnd(-1, 1), sideY(th.y + (me === "A" ? 2 : -2))); return; }
      if (affordable.includes("banana")) { play(g, pid, "banana", th.x, sideY(th.y + (me === "A" ? 1.5 : -1.5))); return; }
    }
    if (p.elixir < L.push && p.elixir < 10) return;
    // Angriff: schwächere Spur
    const lanes = [3.5, 14.5].map(x => { const t = g.towers.find(t => t.team === enemyTeam && t.kind === "princess" && t.x === x); return { x, hp: t ? t.hp : 0 }; });
    const lane = L.smart ? lanes.sort((a, b) => a.hp - b.hp)[0].x : lanes[(Math.random() * 2) | 0].x;
    const units = affordable.filter(c => CARDS[c].type === "unit");
    const spells = affordable.filter(c => CARDS[c].type === "spell");
    if (spells.length && Math.random() < .35) {
      const cluster = g.units.filter(u => u.team !== me).sort((a, b) => g.units.filter(o => o.team !== me && dist(o, b) < 2.5).length - g.units.filter(o => o.team !== me && dist(o, a) < 2.5).length)[0];
      const tw = g.towers.filter(t => t.team === enemyTeam && t.hp > 0).sort((a, b) => a.hp - b.hp)[0];
      const sp = spells[(Math.random() * spells.length) | 0];
      if (cluster && L.smart && sp !== "rocket") { play(g, pid, sp, cluster.x, cluster.y); return; }
      if (tw && sp === "rocket") { play(g, pid, sp, tw.x, tw.y); return; }
    }
    if (units.length) {
      const c = units.includes("pie") && Math.random() < .6 ? "pie" : units[(Math.random() * units.length) | 0];
      const y = c === "pie" ? sideY(me === "A" ? AH - 4 : 4) : sideY(me === "A" ? RIVER + 2.2 : RIVER - 2.2);
      play(g, pid, c, lane + rnd(-1, 1), y);
    }
  }

  // ---------------- Netzwerk ----------------
  const r2 = v => Math.round(v * 100) / 100;
  function snap(g) {
    return {
      t: r2(g.t), dur: g.dur, ot: g.overtime, ph: g.phase, w: g.winner, c: g.crowns, db: g.double,
      u: g.units.map(u => [u.id, u.type, u.team, r2(u.x), r2(u.y), Math.round(u.hp / u.max * 100), (u.stun > 0 ? 1 : 0) | (u.charm > 0 ? 2 : 0) | (u.dep > 0 ? 4 : 0), u.face]),
      tw: g.towers.map(t => [Math.round(t.hp), t.active ? 1 : 0]),
      tr: g.traps.map(t => [t.id, t.team, r2(t.x), r2(t.y)]),
      sp: g.spells.map(s => [s.id, s.type, s.team, r2(s.x), r2(s.y), r2(s.t), s.radius]),
      pl: Object.fromEntries(Object.values(g.players).map(p => [p.id, { id: p.id, e: r2(p.elixir), h: p.hand, n: p.queue[0], ok: Math.round(p.ok), team: p.team, name: p.name, bot: p.bot, st: p.st }])),
      ev: g.ev,
    };
  }
  function towerInfo(g) { return g.towers.map(t => ({ id: t.id, team: t.team, kind: t.kind, x: t.x, y: t.y, tool: t.tool, max: t.max, r: t.r })); }

  return { AW, AH, RIVER, BRIDGES, CARDS, DECK, TW, LEVEL, OVERKILL, newGame, play, step, bot, snap, towerInfo, canPlace, own };
})();
