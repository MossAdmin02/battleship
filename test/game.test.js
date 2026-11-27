const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const Rules = require('../public/shared');

// A1-A3, B1-B2, C1, D1  (ช่องว่าง เช่น E5 = 24)
const FLEET = [
  { size: 3, r: 0, c: 0, dir: 'h' },
  { size: 2, r: 1, c: 0, dir: 'h' },
  { size: 1, r: 2, c: 0, dir: 'h' },
  { size: 1, r: 3, c: 0, dir: 'h' },
];
const SHIP_CELLS = FLEET.flatMap((s) => Rules.cellsOf(s));

function setup(count = 2, settings = {}) {
  const game = new Game('TEST');
  const players = Array.from({ length: count }, (_, i) => game.addPlayer(`P${i + 1}`));
  game.updateSettings(players[0].id, { startBullets: 3, ...settings });
  game.start(players[0].id);
  for (const p of players) game.placeShips(p.id, FLEET);
  return { game, players };
}

function reveal(game) {
  let guard = 500;
  while (game.phase === 'reveal') {
    game.step();
    assert.ok(guard-- > 0, 'reveal ไม่จบ');
  }
}

const at = (player, ...cells) => cells.map((cell) => ({ target: player.id, cell }));

test('ตรวจการวางเรือ', () => {
  assert.ok(Rules.isValidFleet(FLEET));
  assert.ok(!Rules.isValidFleet(FLEET.slice(1)), 'เรือไม่ครบ');
  assert.ok(!Rules.isValidFleet([...FLEET.slice(0, 3), { size: 1, r: 0, c: 0, dir: 'h' }]), 'เรือทับกัน');
  assert.ok(!Rules.isValidFleet([{ size: 3, r: 0, c: 3, dir: 'h' }, ...FLEET.slice(1)]), 'ล้นกระดาน');
  assert.ok(!Rules.isValidFleet([...FLEET.slice(0, 3), { size: 2, r: 4, c: 0, dir: 'h' }]), 'ขนาดผิด');
  assert.ok(!Rules.isValidFleet(null));
  for (let i = 0; i < 2000; i++) assert.ok(Rules.isValidFleet(Rules.randomFleet()));
});

test('ยิงพลาด: กระสุนเป็นของเจ้าของกระดาน / ยิงโดน: กระสุนหายไป', () => {
  const { game, players: [a, b] } = setup();
  game.submit(a.id, at(b, 24, 0));
  assert.equal(game.phase, 'command', 'ต้องรอทุกคนส่งก่อน');
  game.submit(b.id, []);
  assert.equal(game.phase, 'reveal');
  reveal(game);
  assert.equal(a.bullets, 1);
  assert.equal(b.bullets, 4);
  assert.deepEqual(b.shots, { 24: 'miss', 0: 'hit' });
  assert.equal(game.phase, 'command');
  assert.equal(game.round, 2);
});

test('ช่องเดียวกันในรอบเดียว: นัดหลังนับว่าพลาด และไม่เปลี่ยนเครื่องหมายเดิม', () => {
  const { game, players: [a, b, c] } = setup(3);
  game.submit(a.id, at(c, 0));
  game.submit(b.id, at(c, 0));
  game.submit(c.id, []);
  reveal(game);
  assert.equal(c.shots[0], 'hit');
  assert.equal(c.bullets, 4);
  assert.equal(a.bullets, 2);
  assert.equal(b.bullets, 2);
});

test('เปิดคำสั่งทีละคน และคนเปิดก่อนหมุนเวียน', () => {
  const { game, players: [a, b] } = setup();
  game.submit(a.id, at(b, 24));
  game.submit(b.id, at(a, 24));
  game.step();
  assert.equal(game.current.shooterId, a.id);
  assert.deepEqual(b.shots, {}, 'จังหวะแรกยังแค่เปิดคำสั่ง');
  reveal(game);
  game.submit(a.id, at(b, 23));
  game.submit(b.id, at(a, 23));
  game.step();
  assert.equal(game.current.shooterId, b.id);
});

test('บอกลำดับผู้ยิงระหว่างเปิดคำสั่ง โดยไม่เผยช่องของคนที่ยังไม่ถึงคิว', () => {
  const { game, players: [a, b, c] } = setup(3);
  assert.equal(game.view(a.id).reveal, null);
  game.submit(a.id, at(b, 24));
  game.submit(b.id, []);
  game.submit(c.id, at(a, 17));
  game.step();
  const view = game.view(b.id);
  assert.deepEqual(view.reveal, { order: [a.id, c.id], waiting: [c.id] });
  assert.ok(!JSON.stringify(view).includes('"cell":17'));
  reveal(game);
  assert.equal(game.view(a.id).reveal, null);
});

test('คำสั่งยิงที่ผิดถูกปฏิเสธ', () => {
  const { game, players: [a, b] } = setup();
  assert.throws(() => game.submit(a.id, at(a, 0)), /เป้าหมาย/);
  assert.throws(() => game.submit(a.id, at(b, 25)), /ช่องยิง/);
  assert.throws(() => game.submit(a.id, at(b, 1.5)), /ช่องยิง/);
  assert.throws(() => game.submit(a.id, at(b, 1, 1)), /ซ้ำ/);
  assert.throws(() => game.submit(a.id, at(b, 1, 2, 3, 4)), /กระสุนไม่พอ/);
  assert.throws(() => game.submit(a.id, [null]), /เป้าหมาย/);
  assert.throws(() => game.submit(a.id, 'x'));
  game.submit(a.id, at(b, 24));
  assert.throws(() => game.submit(a.id, []), /ส่งคำสั่งไปแล้ว/);
  game.submit(b.id, []);
  reveal(game);
  assert.throws(() => game.submit(a.id, at(b, 24)), /ถูกยิงไปแล้ว/);
});

test('มุมมองผู้เล่นไม่เปิดเผยเรือและคำสั่งของคนอื่น', () => {
  const { game, players: [a, b] } = setup();
  game.submit(b.id, at(a, 7));
  const view = game.view(a.id);
  assert.equal(view.players.find((p) => p.id === b.id).ships.length, 0);
  assert.equal(view.players.find((p) => p.id === a.id).ships.length, 4);
  assert.deepEqual(view.myShots, []);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(b.token) && !text.includes(a.token));
  assert.ok(!text.includes('"cell":7'));
});

test('เรือจมแล้วจึงเปิดให้เห็น', () => {
  const { game, players: [a, b] } = setup();
  game.submit(a.id, at(b, 10));
  game.submit(b.id, []);
  reveal(game);
  assert.deepEqual(game.view(a.id).players[1].ships, [FLEET[2]]);
});

test('จมครบทุกลำ = ตกรอบ คนสุดท้ายชนะ', () => {
  const { game, players: [a, b] } = setup(2, { startBullets: 10 });
  game.submit(a.id, at(b, ...SHIP_CELLS));
  game.submit(b.id, []);
  reveal(game);
  assert.equal(game.phase, 'over');
  assert.equal(game.winReason, 'last');
  assert.deepEqual(game.winnerIds, [a.id]);
  assert.equal(b.alive, false);
  assert.equal(game.view(b.id).players[0].ships.length, 4, 'จบเกมแล้วเปิดเรือทั้งหมด');
});

test('ยิงกระดานของคนที่เพิ่งตกรอบ กระสุนหายไป', () => {
  const { game, players: [a, b, c] } = setup(3, { startBullets: 10 });
  game.submit(a.id, at(b, ...SHIP_CELLS));
  game.submit(b.id, []);
  game.submit(c.id, at(b, 24));
  reveal(game);
  assert.equal(b.alive, false);
  assert.equal(b.bullets, 0);
  assert.equal(c.bullets, 9);
  assert.equal(game.phase, 'command');
  assert.equal(b.submitted, true);
});

test('คนที่ตกรอบระหว่างเปิดคำสั่ง คำสั่งที่เขียนไว้ยังยิง', () => {
  const { game, players: [a, b, c] } = setup(3, { startBullets: 10 });
  game.submit(a.id, at(b, ...SHIP_CELLS));
  game.submit(b.id, at(c, 0));
  game.submit(c.id, []);
  reveal(game);
  assert.equal(c.shots[0], 'hit');
});

test('กระสุนหมดทุกคน ตัดสินจากช่องเรือที่เหลือ', () => {
  const { game, players: [a, b] } = setup(2, { startBullets: 1 });
  game.submit(a.id, at(b, 0));
  game.submit(b.id, at(a, 1));
  reveal(game);
  assert.equal(game.phase, 'over');
  assert.equal(game.winReason, 'ammo');
  assert.deepEqual(game.winnerIds, [a.id, b.id]);
});

test('คนไม่มีกระสุนไม่ต้องส่งคำสั่ง', () => {
  const { game, players: [a, b] } = setup(2, { startBullets: 1 });
  game.submit(a.id, at(b, 24));
  game.submit(b.id, []);
  reveal(game);
  assert.equal(a.bullets, 0);
  assert.equal(a.submitted, true);
  game.submit(b.id, []);
  assert.equal(game.phase, 'reveal');
});

test('ไม่มีใครยิง 3 รอบติด เกมจบ', () => {
  const { game, players } = setup();
  for (let round = 0; round < 3; round++) {
    for (const p of players) game.submit(p.id, []);
    reveal(game);
  }
  assert.equal(game.phase, 'over');
  assert.equal(game.winReason, 'idle');
});

test('หมดเวลา: ใช้ช่องที่เลือกค้างไว้ / สุ่มวางเรือให้', () => {
  const { game, players: [a, b] } = setup();
  game.setDraft(a.id, at(b, 24));
  game.lockCommands();
  reveal(game);
  assert.equal(b.shots[24], 'miss');

  const other = new Game('AUTO');
  const host = other.addPlayer('x');
  other.addPlayer('y');
  other.start(host.id);
  other.autoPlace();
  assert.equal(other.phase, 'command');
  assert.ok(other.players.every((p) => Rules.isValidFleet(p.ships)));
});

test('ออกจากเกมกลางคัน', () => {
  const { game, players: [a, b, c] } = setup(3);
  game.submit(a.id, at(c, 24));
  game.submit(b.id, at(c, 23));
  game.removePlayer(c.id);
  assert.equal(game.phase, 'reveal', 'ไม่ต้องรอคนที่ออกแล้ว');
  reveal(game);
  assert.equal(a.bullets, 3, 'นัดที่เล็งคนที่ออกไม่ถูกใช้');
  game.removePlayer(b.id);
  assert.equal(game.phase, 'over');
  assert.deepEqual(game.winnerIds, [a.id]);
  game.removePlayer(999);
});

test('ออกระหว่างกำลังเปิดคำสั่ง', () => {
  const { game, players: [a, b, c] } = setup(3);
  game.submit(a.id, [...at(b, 24), ...at(c, 24)]);
  game.submit(b.id, at(c, 23));
  game.submit(c.id, []);
  game.step();
  game.removePlayer(b.id);
  reveal(game);
  assert.equal(c.shots[24], 'miss');
  assert.equal(c.shots[23], undefined);
  assert.equal(game.phase, 'command');
});

test('หัวห้อง ชื่อซ้ำ จำนวนคน และเล่นอีกรอบ', () => {
  const game = new Game('ROOM');
  const a = game.addPlayer('  เอ  ');
  assert.equal(a.name, 'เอ');
  assert.throws(() => game.start(a.id), /อย่างน้อย/);
  const b = game.addPlayer('เอ');
  assert.equal(b.name, 'เอ (2)');
  assert.throws(() => game.start(b.id), /หัวห้อง/);
  assert.throws(() => game.addPlayer('   '), /ชื่อ/);
  assert.throws(() => game.updateSettings(a.id, { startBullets: 99 }));
  for (let i = 0; i < 6; i++) game.addPlayer(`p${i}`);
  assert.throws(() => game.addPlayer('เกิน'), /ห้องเต็ม/);

  game.start(a.id);
  assert.throws(() => game.addPlayer('สาย'), /เริ่มเกมไปแล้ว/);
  game.autoPlace();
  for (const p of game.players.slice(1)) game.removePlayer(p.id);
  assert.equal(game.phase, 'over');
  game.rematch(a.id);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 1);
  assert.deepEqual(a.shots, {});

  game.removePlayer(a.id);
  assert.equal(game.hostId, null);
});

test('จำลองเกมสุ่มจำนวนมาก ต้องจบเสมอและกระสุนไม่เพิ่ม', () => {
  for (let n = 0; n < 300; n++) {
    const count = 2 + (n % 7);
    const game = new Game('SIM');
    const players = Array.from({ length: count }, (_, i) => game.addPlayer(`s${i}`));
    game.start(players[0].id);
    game.autoPlace();
    let total = count * game.settings.startBullets;
    let rounds = 0;
    while (game.phase !== 'over') {
      assert.ok(++rounds < 500, 'เกมไม่จบ');
      for (const p of game.players.filter((x) => x.alive && !x.submitted)) {
        if (game.phase !== 'command') break;
        const options = game.players
          .filter((v) => v.alive && v !== p)
          .flatMap((v) => Array.from({ length: 25 }, (_, cell) => ({ target: v.id, cell })).filter((s) => !v.shots[s.cell]))
          .sort(() => Math.random() - 0.5);
        game.submit(p.id, options.slice(0, Math.floor(Math.random() * (p.bullets + 1))));
      }
      reveal(game);
      const now = game.players.reduce((sum, p) => sum + p.bullets, 0);
      assert.ok(now <= total && game.players.every((p) => p.bullets >= 0));
      total = now;
    }
    assert.ok(game.winnerIds.length >= 1);
  }
});
