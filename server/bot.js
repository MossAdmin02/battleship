// สมองของบอท: ตัดสินใจจาก view แบบเดียวกับที่ผู้เล่นได้รับ จึงไม่เห็นเรือหรือคำสั่งของคนอื่น
const Rules = require('../public/shared');

const CELLS = Rules.SIZE * Rules.SIZE;
const SHIP_CELLS = Rules.FLEET.reduce((sum, size) => sum + size, 0);
const LEVELS = ['easy', 'hard'];
const EASY_MAX_SHOTS = 3;
const GOOD_CHANCE = 0.45; // บอทเก่งยิงทุกช่องที่โอกาสโดนถึงเกณฑ์นี้

const toMask = (ship) => Rules.cellsOf(ship).reduce((mask, cell) => mask | (1 << cell), 0);

/** ตำแหน่งวางที่เป็นไปได้ทั้งหมดของเรือแต่ละขนาด เก็บเป็น bitmask 25 บิต */
const PLACEMENTS = new Map();
for (const size of new Set(Rules.FLEET)) {
  const masks = [];
  for (let r = 0; r < Rules.SIZE; r++) {
    for (let c = 0; c < Rules.SIZE; c++) {
      for (const dir of size === 1 ? ['h'] : ['h', 'v']) {
        const ship = { size, r, c, dir };
        if (Rules.cellsOf(ship)) masks.push(toMask(ship));
      }
    }
  }
  PLACEMENTS.set(size, masks);
}

const cache = new Map();

/**
 * โอกาสที่แต่ละช่องมีเรือ คิดจากการไล่ทุกรูปแบบการวางที่ตรงกับข้อมูลที่เปิดเผยแล้ว
 * board = { shots, ships } โดย ships คือเฉพาะลำที่จมแล้ว
 */
function hitChances(board) {
  let miss = 0;
  let hit = 0;
  for (const [cell, result] of Object.entries(board.shots)) {
    if (result === 'hit') hit |= 1 << cell;
    else miss |= 1 << cell;
  }
  let sunk = 0;
  const remaining = [...Rules.FLEET];
  for (const ship of board.ships) {
    sunk |= toMask(ship);
    remaining.splice(remaining.indexOf(ship.size), 1);
  }

  const key = `${miss}:${hit}:${sunk}`;
  if (cache.has(key)) return cache.get(key);

  const counts = new Array(CELLS).fill(0);
  let total = 0;
  const place = (index, occupied, from) => {
    if (index === remaining.length) {
      if (hit & ~occupied) return; // มีช่องที่โดนแล้วแต่ไม่มีเรือ
      total++;
      for (let bits = occupied & ~sunk; bits; bits &= bits - 1) counts[31 - Math.clz32(bits & -bits)]++;
      return;
    }
    const size = remaining[index];
    const options = PLACEMENTS.get(size);
    // เรือขนาดเท่ากันสลับที่กันได้ นับครั้งเดียว
    for (let k = remaining[index - 1] === size ? from : 0; k < options.length; k++) {
      const mask = options[k];
      if (mask & (occupied | miss)) continue;
      if (!(mask & ~hit)) continue; // ถ้าโดนครบทุกช่อง ลำนั้นต้องถูกเปิดว่าจมแล้ว
      place(index + 1, occupied | mask, k + 1);
    }
  };
  place(0, sunk, 0);

  const chances = counts.map((n) => (total ? n / total : 0));
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, chances);
  return chances;
}

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** สุ่มหยิบ count รายการแบบไม่ซ้ำ รายการน้ำหนักมากมีโอกาสถูกหยิบมากกว่า */
function weightedSample(list, count, weight, random) {
  const pool = list.map((item) => ({ item, w: weight(item) }));
  const picked = [];
  while (picked.length < count && pool.length) {
    let r = random() * pool.reduce((sum, p) => sum + p.w, 0);
    let i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    picked.push(pool.splice(i, 1)[0].item);
  }
  return picked;
}

/** คืนรายการช่องที่บอทจะยิงในรอบนี้ [{target, cell}] */
function decideShots(view, level, random = Math.random) {
  const me = view.players.find((p) => p.id === view.you);
  if (!me || !me.alive || me.bullets === 0) return [];

  const enemies = view.players.filter((p) => p.id !== me.id && p.alive);
  const options = [];
  for (const enemy of enemies) {
    const chances = level === 'hard' ? hitChances(enemy) : null;
    const cellsLeft = SHIP_CELLS - Object.values(enemy.shots).filter((r) => r === 'hit').length;
    for (let cell = 0; cell < CELLS; cell++) {
      if (!enemy.shots[cell]) options.push({ target: enemy.id, cell, chance: chances?.[cell], cellsLeft });
    }
  }
  const pick = (list) => list.map(({ target, cell }) => ({ target, cell }));

  if (level !== 'hard') {
    const count = 1 + Math.floor(random() * Math.min(me.bullets, EASY_MAX_SHOTS));
    return pick(shuffle(options, random).slice(0, count));
  }

  const possible = options.filter((o) => o.chance > 0);

  if (enemies.length === 1) {
    // ตัวต่อตัว: บุกทุกช่องที่โอกาสดี (สุ่มน้ำหนักเล็กน้อยให้เดาทางยาก)
    const ranked = possible
      .map((o) => ({ ...o, score: o.chance * (0.75 + random() * 0.5) }))
      .sort((a, b) => b.score - a.score);
    const good = ranked.filter((o) => o.chance >= GOOD_CHANCE).length;
    return pick(ranked.slice(0, Math.min(me.bullets, Math.max(good, Math.ceil(me.bullets / 4)))));
  }

  // หลายคน: ยิงโดนคือเสียกระสุนเพื่อให้คนอื่นได้ประโยชน์ด้วย จึงยิงประหยัด และเน้นคนที่ยังแข็งแรง
  // สุ่มแบบถ่วงน้ำหนัก บอทหลายตัวจะได้ไม่แย่งยิงช่องเดียวกันจนกระสุนตกเป็นของเป้า
  const count = Math.min(me.bullets, Math.max(1, Math.floor(me.bullets / 5)));
  return pick(weightedSample(possible, count, (o) => (o.chance * o.cellsLeft) ** 2, random));
}

module.exports = { LEVELS, decideShots, hitChances };
