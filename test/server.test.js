// เล่นจริงผ่าน socket ตั้งแต่สร้างห้องจนจบเกม
const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createApp } = require('../server');
const Rules = require('../public/shared');

async function start(t, options = {}) {
  const app = createApp({ delays: { start: 5, open: 5, shot: 5, idle: 5 }, ...options });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const url = `http://localhost:${app.server.address().port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await app.close();
  });

  async function client() {
    const socket = io(url, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);
    const c = { socket, state: null };
    socket.on('state', (state) => { c.state = state; });
    c.send = (event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);
    c.until = (check) => new Promise((resolve, reject) => {
      if (c.state && check(c.state)) return resolve(c.state);
      const timer = setTimeout(() => reject(new Error('รอสถานะนานเกินไป')), 3000);
      const listener = (state) => {
        if (!check(state)) return;
        clearTimeout(timer);
        socket.off('state', listener);
        resolve(state);
      };
      socket.on('state', listener);
    });
    await new Promise((resolve) => socket.on('connect', resolve));
    return c;
  }
  return { app, url, client };
}

test('สร้างห้อง เข้าห้อง และเล่นจนจบ', async (t) => {
  const { url, client } = await start(t);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.match((await fetch(`${url}/img/hero`)).headers.get('content-type'), /^image\//);
  for (const file of ['/', '/app.js', '/shared.js', '/styles.css', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(url + file)).status, 200, file);
  }

  const a = await client();
  const b = await client();
  const created = await a.send('create', { name: 'A' });
  assert.ok(created.ok);
  assert.match(created.code, /^[A-Z2-9]{4}$/);
  assert.equal((await b.send('join', { code: 'ZZZZ', name: 'B' })).ok, false);
  const joined = await b.send('join', { code: created.code.toLowerCase(), name: 'B' });
  assert.ok(joined.ok);

  assert.equal((await b.send('start')).ok, false);
  assert.ok((await a.send('settings', { startBullets: 10 })).ok);
  assert.ok((await a.send('start')).ok);
  const fleet = Rules.randomFleet();
  await a.send('place', { ships: fleet });
  await b.send('place', { ships: fleet });
  await a.until((s) => s.phase === 'command');
  assert.equal(a.state.players[1].ships.length, 0);

  const shots = fleet.flatMap((s) => Rules.cellsOf(s)).map((cell) => ({ target: joined.playerId, cell }));
  assert.ok((await a.send('submit', { shots })).ok);
  assert.ok((await b.send('submit', { shots: [] })).ok);
  const over = await b.until((s) => s.phase === 'over');
  assert.deepEqual(over.winnerIds, [created.playerId]);

  assert.ok((await a.send('rematch')).ok);
  await b.until((s) => s.phase === 'lobby');
});

test('หลุดแล้วกลับเข้าที่นั่งเดิมได้ และข้อมูลแปลกๆ ไม่ทำให้เซิร์ฟเวอร์ล่ม', async (t) => {
  const { client } = await start(t);
  const a = await client();
  const b = await client();
  const room = await a.send('create', { name: 'A' });
  const seat = await b.send('join', { code: room.code, name: 'B' });
  await a.send('start');
  b.socket.disconnect();
  await a.until((s) => s.players[1]?.connected === false);

  const again = await client();
  const back = await again.send('join', { code: room.code, token: seat.token });
  assert.equal(back.playerId, seat.playerId);
  await a.until((s) => s.players[1].connected);

  // อีกแท็บที่ใช้ token เดียวกันขณะเจ้าของยังออนไลน์ จะแย่งที่นั่งไม่ได้
  const intruder = await client();
  assert.equal((await intruder.send('join', { code: room.code, name: 'C', token: seat.token })).ok, false);

  for (const payload of [null, 5, 'x', {}, { ships: 'x' }, { shots: [{}] }]) {
    for (const event of ['create', 'join', 'settings', 'place', 'draft', 'submit']) {
      await intruder.send(event, payload);
    }
  }
  intruder.socket.emit('start');
  assert.ok((await again.send('place', { ships: Rules.randomFleet() })).ok);
});

test('หลุดจากห้องรอนานเกินกำหนดถูกนำออก แม้ผ่านการเล่นอีกรอบมาแล้ว', async (t) => {
  const { client } = await start(t, { lobbyGraceMs: 80 });
  const a = await client();
  const b = await client();
  const room = await a.send('create', { name: 'A' });
  await b.send('join', { code: room.code, name: 'B' });
  await a.until((s) => s.players.length === 2);
  b.socket.disconnect();
  await a.until((s) => s.players.length === 1);
});

test('เล่นกับบอทผ่านเซิร์ฟเวอร์จนจบ และเหลือแต่บอทแล้วห้องปิด', async (t) => {
  const { app, client } = await start(t, { botDelayMs: [2, 5] });
  const a = await client();
  const room = await a.send('create', { name: 'A' });
  assert.ok((await a.send('addBot', { level: 'hard' })).ok);
  assert.ok((await a.send('addBot', { level: 'easy' })).ok);
  assert.equal((await a.send('addBot', {})).ok, false);
  assert.equal((await a.send('removeBot', { botId: room.playerId })).ok, false);

  // ผู้เล่นคนไม่ยิง แค่ส่งคำสั่งว่างทุกรอบ ปล่อยให้บอทเล่น
  let sentRound = 0;
  a.socket.on('state', (s) => {
    const me = s.players.find((p) => p.id === s.you);
    if (s.phase === 'command' && me.alive && !me.submitted && s.round > sentRound) {
      sentRound = s.round;
      a.socket.emit('submit', { shots: [] });
    }
  });
  await a.send('start');
  await a.send('place', { ships: Rules.randomFleet() });
  const over = await a.until((s) => s.phase === 'over');
  assert.ok(over.winnerIds.length >= 1);
  assert.ok(over.log.length > 0);

  await a.send('rematch');
  await a.until((s) => s.phase === 'lobby' && s.players.length === 3);
  await a.send('leave');
  assert.equal(app.rooms.size, 0);
});

test('หมดเวลาแล้วเกมเดินต่อเอง และห้องร้างถูกลบ', async (t) => {
  const { app, client } = await start(t, { emptyRoomMs: 50 });
  const a = await client();
  const b = await client();
  const room = await a.send('create', { name: 'A' });
  await b.send('join', { code: room.code, name: 'B' });
  await a.send('start');
  const { game } = app.rooms.get(room.code);
  // ย่นเวลาของช่วงนี้ แล้วกระตุ้นให้ตั้ง timer ใหม่
  game.deadline = Date.now() + 30;
  await b.send('unready');
  await a.until((s) => s.phase === 'command');
  game.deadline = Date.now() + 30;
  await a.send('draft', { shots: [] });
  await a.until((s) => s.round === 2);

  a.socket.disconnect();
  b.socket.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.rooms.size, 0);
});
