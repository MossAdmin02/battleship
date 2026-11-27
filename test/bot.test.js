const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const { decideShots, hitChances } = require('../server/bot');
const Rules = require('../public/shared');

/** ตัวสุ่มที่ให้ผลเดิมทุกครั้ง */
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ห้องที่ทุกที่นั่งเป็นบอท (หัวห้องถูกสั่งแทนด้วย botAct) */
function botGame(levels, random) {
  const game = new Game('BOTS', { random });
  const host = game.addPlayer('host');
  Object.assign(host, { isBot: true, level: levels[0] });
  for (const level of levels.slice(1)) game.addBot(host.id, level);
  game.start(host.id);
  game.autoPlace();
  return game;
}

function playOut(game) {
  let guard = 3000;
  while (game.phase !== 'over') {
    assert.ok(guard-- > 0, 'เกมไม่จบ');
    if (game.phase === 'command') {
      const [bot] = game.pendingBots();
      game.botAct(bot.id); // submit จะ throw ถ้าบอทสั่งยิงผิดกติกา
    } else {
      game.step();
    }
  }
}

test('จัดการบอทในห้องรอ', () => {
  const game = new Game('ROOM');
  const host = game.addPlayer('A');
  const friend = game.addPlayer('B');
  assert.throws(() => game.addBot(friend.id, 'easy'), /หัวห้อง/);
  assert.throws(() => game.addBot(host.id, 'god'), /ระดับ/);
  const one = game.addBot(host.id, 'easy');
  const two = game.addBot(host.id, 'hard');
  assert.deepEqual([one.name, two.name], ['บอท 1', 'บอท 2']);
  assert.throws(() => game.removeBot(host.id, friend.id), /ไม่พบบอท/);
  assert.throws(() => game.removeBot(friend.id, one.id), /หัวห้อง/);
  game.removeBot(host.id, one.id);
  assert.equal(game.addBot(host.id, 'easy').name, 'บอท 1');
  assert.equal(game.findByToken(null), null);

  for (let i = game.players.length; i < 8; i++) game.addBot(host.id, 'easy');
  assert.throws(() => game.addBot(host.id, 'easy'), /ห้องเต็ม/);

  game.removePlayer(host.id);
  assert.equal(game.hostId, friend.id, 'บอทเป็นหัวห้องไม่ได้');
  game.removePlayer(friend.id);
  assert.equal(game.hostId, null);
  assert.equal(game.hasHumans(), false);
});

test('เล่นคนเดียวกับบอท: บอทพร้อมเอง และอยู่ต่อเมื่อเล่นอีกรอบ', () => {
  const game = new Game('SOLO');
  const host = game.addPlayer('A');
  const bot = game.addBot(host.id, 'hard');
  game.start(host.id);
  assert.ok(bot.ready && Rules.isValidFleet(bot.ships));
  assert.throws(() => game.addBot(host.id, 'easy'), /เริ่มเกมไปแล้ว/);
  assert.throws(() => game.removeBot(host.id, bot.id), /ห้องรอ/);
  assert.equal(game.view(host.id).players[1].ships.length, 0);
  game.placeShips(host.id, Rules.randomFleet());
  assert.equal(game.phase, 'command');
  assert.throws(() => game.botAct(host.id), /ไม่ใช่บอท/);
  game.botAct(bot.id);
  assert.ok(bot.submitted && bot.command.length >= 1);
  assert.deepEqual(game.pendingBots(), []);

  game.finish([host.id], 'last');
  game.rematch(host.id);
  assert.equal(game.players.length, 2);
  assert.ok(game.players[1].isBot);
});

test('คำนวณโอกาสโดน', () => {
  const empty = hitChances({ shots: {}, ships: [] });
  assert.ok(Math.abs(empty.reduce((a, b) => a + b, 0) - 7) < 1e-9, 'รวมต้องเท่าจำนวนช่องเรือ');

  const chances = hitChances({ shots: { 12: 'hit', 0: 'miss' }, ships: [] });
  assert.equal(chances[12], 1);
  assert.equal(chances[0], 0);
  assert.ok(chances[11] > chances[24] * 0.5);

  // เรือลำเล็กจมแล้ว: ไม่นับซ้ำ เหลือเรืออีก 6 ช่อง
  const sunk = hitChances({ shots: { 6: 'hit' }, ships: [{ size: 1, r: 1, c: 1, dir: 'h' }] });
  assert.equal(sunk[6], 0);
  assert.ok(Math.abs(sunk.reduce((a, b) => a + b, 0) - 6) < 1e-9);
});

test('บอทไม่แอบดูเรือ: เรือคนอื่นต่างกันแต่ข้อมูลเปิดเผยเท่ากัน ต้องตัดสินใจเหมือนกัน', () => {
  for (const level of ['easy', 'hard']) {
    const decisions = [1, 2].map((fleetSeed) => {
      const game = botGame([level, level, level], seeded(7));
      for (const p of game.players.slice(1)) p.ships = Rules.randomFleet(seeded(fleetSeed * 100 + p.id));
      return decideShots(game.view(game.players[0].id), level, seeded(99));
    });
    assert.deepEqual(decisions[0], decisions[1]);
    assert.ok(decisions[0].length >= 1);
  }
});

test('บอทล้วนเล่นจนจบได้ทุกจำนวนคนโดยไม่ผิดกติกา', () => {
  const random = seeded(1);
  for (let n = 0; n < 70; n++) {
    const levels = Array.from({ length: 2 + (n % 7) }, () => (random() < 0.5 ? 'easy' : 'hard'));
    const game = botGame(levels, random);
    playOut(game);
    assert.ok(game.winnerIds.length >= 1);
  }
});

test('บอทเก่งชนะบอทง่ายบ่อยกว่าชัดเจน', (t) => {
  const random = seeded(2024);
  const games = 200;
  let hard = 0;
  let easy = 0;
  for (let n = 0; n < games; n++) {
    const levels = n % 2 ? ['hard', 'easy'] : ['easy', 'hard']; // สลับลำดับที่นั่ง
    const game = botGame(levels, random);
    playOut(game);
    if (game.winnerIds.length === 1) {
      if (game.player(game.winnerIds[0]).level === 'hard') hard++;
      else easy++;
    }
  }
  t.diagnostic(`เก่ง ${hard} / ง่าย ${easy} / เสมอ ${games - hard - easy}`);
  assert.ok(hard > games * 0.7, `บอทเก่งชนะ ${hard}/${games}`);
});
