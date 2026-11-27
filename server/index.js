const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ตัดตัวที่อ่านสับสน (I O 0 1)

const DEFAULTS = {
  // จังหวะการเปิดคำสั่ง (มิลลิวินาที)
  delays: { start: 1200, open: 1600, shot: 1600, idle: 2200 },
  botDelayMs: [600, 1600], // บอทแต่ละตัว "คิด" นานเท่าไรก่อนส่งคำสั่ง (ต่ำสุด, สูงสุด)
  lobbyGraceMs: 30_000, // หลุดนานเกินนี้ในห้องรอจะถูกนำออก
  emptyRoomMs: 10 * 60_000, // ห้องที่ไม่มีใครออนไลน์จะถูกลบ
  maxRooms: 500,
};

function createApp(options = {}) {
  const config = { ...DEFAULTS, ...options, delays: { ...DEFAULTS.delays, ...options.delays } };
  const app = express();
  app.disable('x-powered-by');
  const publicDir = path.join(__dirname, '..', 'public');
  // ภาพหน้าแรก: ถ้าวางไฟล์ภาพจริงชื่อ hero.webp/png/jpg ไว้ จะใช้แทนภาพวาดเริ่มต้น
  app.get('/img/hero', (req, res) => {
    const file = ['hero.webp', 'hero.png', 'hero.jpg', 'hero.svg']
      .map((name) => path.join(publicDir, 'img', name))
      .find((candidate) => fs.existsSync(candidate));
    if (file) res.sendFile(file);
    else res.sendStatus(404);
  });
  app.use(express.static(publicDir));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });
  const rooms = new Map(); // code -> { game, sockets: Map<playerId, socket>, timer, timerKey, emptyTimer, graceTimers }

  function newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function createRoom() {
    if (rooms.size >= config.maxRooms) throw new GameError('มีห้องเปิดอยู่มากเกินไป ลองใหม่ภายหลัง');
    const room = {
      game: new Game(newCode()),
      sockets: new Map(),
      graceTimers: new Map(),
      timer: null,
      timerKey: null,
      botTimer: null,
      emptyTimer: null,
    };
    rooms.set(room.game.code, room);
    return room;
  }

  function destroyRoom(room) {
    clearTimeout(room.timer);
    clearTimeout(room.botTimer);
    clearTimeout(room.emptyTimer);
    for (const timer of room.graceTimers.values()) clearTimeout(timer);
    rooms.delete(room.game.code);
  }

  /** ตั้ง timer ของช่วงเกมปัจจุบัน (ไม่รีเซ็ตถ้ายังอยู่จังหวะเดิม) */
  function schedule(room) {
    const { game } = room;
    let key = null;
    let delay = 0;
    let action = null;

    if (game.phase === 'placing' || game.phase === 'command') {
      key = `${game.phase}:${game.deadline}`;
      delay = game.deadline - Date.now();
      action = () => (game.phase === 'placing' ? game.autoPlace() : game.lockCommands());
    } else if (game.phase === 'reveal') {
      // ใช้จำนวนจังหวะที่เหลือเป็น key เพื่อไม่ให้เหตุการณ์อื่นเลื่อนเวลาออกไป
      const pending = game.current ? game.current.pending.length : 0;
      key = `reveal:${game.round}:${game.turns.length}:${pending}:${game.current?.shooterId}`;
      const type = game.lastEvent?.type;
      delay = type === 'reveal' ? config.delays.start : config.delays[type] ?? config.delays.shot;
      action = () => game.step();
    }

    if (key === room.timerKey) return;
    clearTimeout(room.timer);
    room.timerKey = key;
    if (!action) return;
    room.timer = setTimeout(() => {
      room.timerKey = null;
      try {
        action();
      } catch (err) {
        console.error(`[room ${game.code}]`, err);
      }
      update(room);
    }, Math.max(0, delay));
  }

  /** ให้บอทส่งคำสั่งทีละตัว เว้นจังหวะให้ดูเป็นธรรมชาติ */
  function scheduleBots(room) {
    if (!room.game.pendingBots().length) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
      return;
    }
    if (room.botTimer) return;
    const [min, max] = config.botDelayMs;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      const bot = room.game.pendingBots()[0];
      if (!bot) return;
      try {
        room.game.botAct(bot.id);
      } catch (err) {
        console.error(`[room ${room.game.code}] บอท`, err);
        room.game.submit(bot.id, []);
      }
      update(room);
    }, min + Math.random() * (max - min));
  }

  function update(room) {
    if (!rooms.has(room.game.code)) return;
    schedule(room);
    scheduleBots(room);
    for (const [playerId, socket] of room.sockets) socket.emit('state', room.game.view(playerId));
    watchAbsent(room);
    watchEmpty(room);
  }

  /** คนที่หลุดอยู่จะได้เวลารอช่วงหนึ่ง: ในห้องรอจะถูกนำออก ระหว่างเกมจะย้ายหัวห้อง */
  function watchAbsent(room) {
    for (const player of room.game.players) {
      if (player.connected || player.left) continue;
      const existing = room.graceTimers.get(player.id);
      // หมดเวลารอไปแล้วระหว่างเกม: นับใหม่เฉพาะเมื่อกลับมาที่ห้องรอ
      if (existing && !(existing === 'expired' && room.game.phase === 'lobby')) continue;
      const timer = setTimeout(() => {
        const { game } = room;
        room.graceTimers.set(player.id, 'expired');
        if (game.phase === 'lobby') {
          room.graceTimers.delete(player.id);
          game.removePlayer(player.id);
          if (!game.hasHumans()) return destroyRoom(room);
        } else {
          game.ensureHost();
        }
        update(room);
      }, config.lobbyGraceMs);
      room.graceTimers.set(player.id, timer);
    }
  }

  function watchEmpty(room) {
    if (room.sockets.size > 0) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    } else if (!room.emptyTimer) {
      room.emptyTimer = setTimeout(() => destroyRoom(room), config.emptyRoomMs);
    }
  }

  function attach(socket, room, player) {
    const previous = room.sockets.get(player.id);
    if (previous && previous !== socket) {
      previous.data = {};
      previous.emit('replaced');
    }
    clearTimeout(room.graceTimers.get(player.id));
    room.graceTimers.delete(player.id);
    room.sockets.set(player.id, socket);
    socket.data = { code: room.game.code, playerId: player.id };
    room.game.setConnected(player.id, true);
    return { code: room.game.code, token: player.token, playerId: player.id };
  }

  /** ออกจากห้องปัจจุบันแบบตั้งใจ */
  function leave(socket) {
    const { code, playerId } = socket.data;
    socket.data = {};
    const room = rooms.get(code);
    if (!room) return;
    room.sockets.delete(playerId);
    room.game.removePlayer(playerId);
    if (!room.game.hasHumans()) destroyRoom(room); // เหลือแต่บอทก็ปิดห้อง
    else update(room);
  }

  /** การเชื่อมต่อหลุด: ยังเก็บที่นั่งไว้ให้กลับเข้ามาได้ */
  function disconnect(socket) {
    const { code, playerId } = socket.data;
    const room = rooms.get(code);
    if (!room || room.sockets.get(playerId) !== socket) return;
    room.sockets.delete(playerId);
    room.game.setConnected(playerId, false);
    update(room);
  }

  io.on('connection', (socket) => {
    socket.data = {};

    function on(event, handler) {
      socket.on(event, (...args) => {
        const reply = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
        try {
          reply({ ok: true, ...handler(args[0] || {}) });
        } catch (err) {
          if (!(err instanceof GameError)) console.error(`[${event}]`, err);
          reply({ ok: false, error: err instanceof GameError ? err.message : 'เกิดข้อผิดพลาด' });
        }
      });
    }

    /** คำสั่งของผู้เล่นที่อยู่ในห้องแล้ว */
    function inRoom(event, handler) {
      on(event, (payload) => {
        const room = rooms.get(socket.data.code);
        if (!room) throw new GameError('คุณไม่ได้อยู่ในห้อง');
        handler(room.game, socket.data.playerId, payload);
        update(room);
        return {};
      });
    }

    on('create', ({ name }) => {
      if (!String(name ?? '').trim()) throw new GameError('กรุณาใส่ชื่อ');
      leave(socket);
      const room = createRoom();
      const result = attach(socket, room, room.game.addPlayer(name));
      update(room);
      return result;
    });

    on('join', ({ code, name, token, sameTab }) => {
      const room = rooms.get(String(code ?? '').trim().toUpperCase());
      if (!room) throw new GameError('ไม่พบห้องนี้');

      // กลับเข้าที่นั่งเดิม: แท็บเดิม หรือเจ้าของที่นั่งหลุดอยู่
      const seat = typeof token === 'string' ? room.game.findByToken(token) : null;
      if (seat && (sameTab || !room.sockets.has(seat.id))) {
        if (socket.data.code && (socket.data.code !== room.game.code || socket.data.playerId !== seat.id)) leave(socket);
        const result = attach(socket, room, seat);
        update(room);
        return result;
      }

      if (socket.data.code === room.game.code) throw new GameError('คุณอยู่ในห้องนี้แล้ว');
      const player = room.game.addPlayer(name);
      leave(socket);
      const result = attach(socket, room, player);
      update(room);
      return result;
    });

    on('leave', () => {
      leave(socket);
      return {};
    });

    inRoom('settings', (game, id, payload) => game.updateSettings(id, payload));
    inRoom('addBot', (game, id, { level }) => game.addBot(id, level));
    inRoom('removeBot', (game, id, { botId }) => game.removeBot(id, botId));
    inRoom('start', (game, id) => game.start(id));
    inRoom('place', (game, id, { ships }) => game.placeShips(id, ships));
    inRoom('unready', (game, id) => game.unready(id));
    inRoom('draft', (game, id, { shots }) => game.setDraft(id, shots));
    inRoom('submit', (game, id, { shots }) => game.submit(id, shots));
    inRoom('rematch', (game, id) => game.rematch(id));

    socket.on('disconnect', () => disconnect(socket));
  });

  function close() {
    for (const room of [...rooms.values()]) destroyRoom(room);
    return new Promise((resolve) => io.close(() => resolve()));
  }

  return { app, server, io, rooms, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `พอร์ต ${port} ถูกใช้อยู่ ลองตั้งค่า PORT เป็นเลขอื่น` : err);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`เปิดเกมได้ที่  http://localhost:${port}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`เครื่องอื่นในวง LAN: http://${net.address}:${port}`);
      }
    }
  });
}

module.exports = { createApp };
