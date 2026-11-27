// สถานะและกติกาของเกมหนึ่งห้อง ไม่มี timer หรือเครือข่ายในไฟล์นี้ (ดู index.js)
const crypto = require('crypto');
const Rules = require('../public/shared');
const Bot = require('./bot');

const CONFIG = { ...Rules.LIMITS, logSize: 60 };

class GameError extends Error {}

function fail(message) {
  throw new GameError(message);
}

class Game {
  constructor(code, { now = Date.now, random = Math.random } = {}) {
    this.code = code;
    this.now = now;
    this.random = random;
    this.players = [];
    this.hostId = null;
    this.settings = { ...Rules.DEFAULT_SETTINGS };
    this.seq = 0;
    this.nextId = 1;
    this.resetRound();
    this.phase = 'lobby';
  }

  resetRound() {
    this.round = 0;
    this.deadline = null;
    this.turns = [];
    this.order = []; // ลำดับผู้ยิงของรอบที่กำลังเปิดคำสั่ง
    this.current = null;
    this.idleRounds = 0;
    this.winnerIds = [];
    this.winReason = null;
    this.log = [];
    this.lastEvent = null;
  }

  // ---------- ผู้เล่น ----------

  player(id) {
    return this.players.find((p) => p.id === id) || fail('ไม่พบผู้เล่นในห้องนี้');
  }

  findByToken(token) {
    if (!token) return null; // บอทไม่มี token
    return this.players.find((p) => !p.left && p.token === token) || null;
  }

  requireSeat() {
    if (this.phase !== 'lobby') fail('ห้องนี้เริ่มเกมไปแล้ว');
    if (this.players.length >= CONFIG.maxPlayers) fail(`ห้องเต็มแล้ว (สูงสุด ${CONFIG.maxPlayers} คน)`);
  }

  nameTaken(name) {
    return this.players.some((p) => p.name === name);
  }

  seat(fields) {
    const player = { id: this.nextId++, connected: true, left: false, ...fields, ...this.freshState() };
    this.players.push(player);
    return player;
  }

  addPlayer(rawName) {
    this.requireSeat();
    const base = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!base) fail('กรุณาใส่ชื่อ');
    let name = base;
    for (let n = 2; this.nameTaken(name); n++) name = `${base} (${n})`;

    const player = this.seat({ name, token: crypto.randomBytes(16).toString('hex'), isBot: false, level: null });
    if (this.hostId === null) this.hostId = player.id;
    return player;
  }

  // ---------- บอท ----------

  addBot(hostId, level) {
    this.requireHost(hostId);
    this.requireSeat();
    if (!Bot.LEVELS.includes(level)) fail('ระดับบอทไม่ถูกต้อง');
    let n = 1;
    while (this.nameTaken(`บอท ${n}`)) n++;
    return this.seat({ name: `บอท ${n}`, token: null, isBot: true, level });
  }

  removeBot(hostId, botId) {
    this.requireHost(hostId);
    if (this.phase !== 'lobby') fail('นำบอทออกได้เฉพาะในห้องรอ');
    if (!this.players.some((p) => p.id === botId && p.isBot)) fail('ไม่พบบอทตัวนี้');
    this.removePlayer(botId);
  }

  /** บอทที่ยังไม่ได้ส่งคำสั่งในรอบนี้ */
  pendingBots() {
    if (this.phase !== 'command') return [];
    return this.players.filter((p) => p.isBot && p.alive && !p.submitted);
  }

  botAct(id) {
    const bot = this.player(id);
    if (!bot.isBot) fail('ผู้เล่นนี้ไม่ใช่บอท');
    this.submit(id, Bot.decideShots(this.view(id), bot.level, this.random));
  }

  hasHumans() {
    return this.players.some((p) => !p.isBot && !p.left);
  }

  freshState() {
    return { ships: [], ready: false, bullets: 0, shots: {}, alive: true, draft: [], command: [], submitted: false };
  }

  setConnected(id, connected) {
    this.player(id).connected = connected;
  }

  /** ย้ายหัวห้องให้คนที่ยังออนไลน์ ถ้าหัวห้องปัจจุบันไม่อยู่แล้ว */
  ensureHost() {
    const host = this.players.find((p) => p.id === this.hostId);
    if (host && !host.left && host.connected) return;
    const present = this.players.filter((p) => !p.left && !p.isBot);
    const next = present.find((p) => p.connected) || present[0];
    this.hostId = next ? next.id : null;
  }

  /** ผู้เล่นออกจากห้อง (ใช้ได้ทุกช่วงของเกม) */
  removePlayer(id) {
    const player = this.players.find((p) => p.id === id);
    if (!player || player.left) return;

    if (this.phase === 'lobby' || this.phase === 'placing') {
      this.players = this.players.filter((p) => p !== player);
      this.ensureHost();
      if (this.phase === 'placing') {
        if (this.players.length < CONFIG.minPlayers) this.toLobby();
        else this.maybeBeginBattle();
      }
      return;
    }

    // ระหว่างเกม: เก็บกระดานไว้ให้คนอื่นเห็น แต่ถือว่าตกรอบ
    const wasAlive = player.alive;
    player.left = true;
    player.connected = false;
    this.ensureHost();
    if (this.phase === 'over') return;

    player.alive = false;
    player.bullets = 0;
    this.turns = this.turns.filter((t) => t.shooterId !== id);
    if (this.current) {
      if (this.current.shooterId === id) this.current = null;
      else this.current.pending = this.current.pending.filter((s) => s.target !== id);
    }
    if (wasAlive) this.emit({ type: 'left', playerId: id });
    if (this.checkLastStanding()) return;
    if (this.phase === 'command') this.maybeReveal();
  }

  // ---------- ห้องรอ ----------

  requireHost(id) {
    if (id !== this.hostId) fail('เฉพาะหัวห้องเท่านั้น');
  }

  updateSettings(id, settings = {}) {
    this.requireHost(id);
    if (this.phase !== 'lobby') fail('เปลี่ยนการตั้งค่าได้เฉพาะในห้องรอ');
    const { startBullets, commandSeconds } = settings || {};
    if (startBullets !== undefined) {
      if (!Number.isInteger(startBullets) || startBullets < CONFIG.minStartBullets || startBullets > CONFIG.maxStartBullets) {
        fail('จำนวนกระสุนไม่ถูกต้อง');
      }
      this.settings.startBullets = startBullets;
    }
    if (commandSeconds !== undefined) {
      if (!CONFIG.commandSeconds.includes(commandSeconds)) fail('เวลาไม่ถูกต้อง');
      this.settings.commandSeconds = commandSeconds;
    }
  }

  start(id) {
    this.requireHost(id);
    if (this.phase !== 'lobby') fail('เกมเริ่มไปแล้ว');
    if (this.players.length < CONFIG.minPlayers) fail(`ต้องมีผู้เล่นอย่างน้อย ${CONFIG.minPlayers} คน`);
    this.resetRound();
    for (const p of this.players) {
      Object.assign(p, this.freshState(), { bullets: this.settings.startBullets });
      if (p.isBot) Object.assign(p, { ships: Rules.randomFleet(this.random), ready: true });
    }
    this.phase = 'placing';
    this.deadline = this.now() + CONFIG.placingSeconds * 1000;
  }

  toLobby() {
    this.resetRound();
    for (const p of this.players) Object.assign(p, this.freshState());
    this.phase = 'lobby';
  }

  rematch(id) {
    this.requireHost(id);
    if (this.phase !== 'over') fail('เกมยังไม่จบ');
    this.players = this.players.filter((p) => !p.left && p.connected);
    this.ensureHost();
    this.toLobby();
  }

  // ---------- วางเรือ ----------

  placeShips(id, ships) {
    if (this.phase !== 'placing') fail('ไม่ใช่ช่วงวางเรือ');
    const player = this.player(id);
    if (!Rules.isValidFleet(ships)) fail('ตำแหน่งเรือไม่ถูกต้อง');
    player.ships = ships.map(({ size, r, c, dir }) => ({ size, r, c, dir }));
    player.ready = true;
    this.maybeBeginBattle();
  }

  unready(id) {
    if (this.phase !== 'placing') fail('ไม่ใช่ช่วงวางเรือ');
    this.player(id).ready = false;
  }

  /** หมดเวลาวางเรือ: คนที่ยังไม่กดพร้อมจะถูกสุ่มวางให้ */
  autoPlace() {
    if (this.phase !== 'placing') return;
    for (const p of this.players) {
      if (!p.ready) {
        p.ships = Rules.randomFleet(this.random);
        p.ready = true;
      }
    }
    this.maybeBeginBattle();
  }

  maybeBeginBattle() {
    if (this.phase === 'placing' && this.players.every((p) => p.ready)) this.startCommand();
  }

  // ---------- เขียนคำสั่งยิง ----------

  startCommand() {
    const alive = this.players.filter((p) => p.alive);
    if (alive.every((p) => p.bullets === 0)) return this.endByShipCells('ammo');
    this.round += 1;
    this.phase = 'command';
    this.turns = [];
    this.current = null;
    this.deadline = this.now() + this.settings.commandSeconds * 1000;
    for (const p of this.players) {
      p.draft = [];
      p.command = [];
      p.submitted = !p.alive || p.bullets === 0;
    }
    this.emit({ type: 'round', round: this.round });
  }

  checkShots(player, shots) {
    if (this.phase !== 'command') fail('ไม่ใช่ช่วงสั่งยิง');
    if (!player.alive) fail('คุณตกรอบแล้ว');
    if (player.submitted) fail('ส่งคำสั่งไปแล้ว');
    if (!Array.isArray(shots)) fail('คำสั่งยิงไม่ถูกต้อง');
    if (shots.length > player.bullets) fail('กระสุนไม่พอ');
    const seen = new Set();
    return shots.map((shot) => {
      const { target, cell } = shot || {};
      const victim = this.players.find((p) => p.id === target);
      if (!victim || !victim.alive || victim === player) fail('เป้าหมายไม่ถูกต้อง');
      if (!Number.isInteger(cell) || cell < 0 || cell >= Rules.SIZE * Rules.SIZE) fail('ช่องยิงไม่ถูกต้อง');
      if (victim.shots[cell]) fail('ช่องนี้ถูกยิงไปแล้ว');
      const key = `${target}:${cell}`;
      if (seen.has(key)) fail('เลือกช่องซ้ำ');
      seen.add(key);
      return { target, cell };
    });
  }

  /** เก็บช่องที่เลือกค้างไว้ ถ้าหมดเวลาจะใช้ชุดนี้ */
  setDraft(id, shots) {
    const player = this.player(id);
    player.draft = this.checkShots(player, shots);
  }

  submit(id, shots) {
    const player = this.player(id);
    player.command = this.checkShots(player, shots);
    player.draft = [];
    player.submitted = true;
    this.maybeReveal();
  }

  maybeReveal() {
    if (this.phase === 'command' && this.players.every((p) => !p.alive || p.submitted)) this.startReveal();
  }

  /** หมดเวลาสั่งยิง */
  lockCommands() {
    if (this.phase !== 'command') return;
    for (const p of this.players) {
      if (p.alive && !p.submitted) {
        // เป้าที่ออกจากห้องไประหว่างนี้ต้องตัดทิ้ง
        p.command = p.draft.filter((s) => this.players.some((v) => v.id === s.target && v.alive));
        p.draft = [];
        p.submitted = true;
      }
    }
    this.startReveal();
  }

  // ---------- เปิดคำสั่ง ----------

  startReveal() {
    this.phase = 'reveal';
    this.deadline = null;
    this.current = null;
    // คนที่ได้เปิดก่อนหมุนเวียนไปทุกรอบ
    const offset = (this.round - 1) % this.players.length;
    const order = [...this.players.slice(offset), ...this.players.slice(0, offset)];
    this.turns = order
      .filter((p) => p.alive && p.command.length > 0)
      .map((p) => ({ shooterId: p.id, shots: p.command }));
    this.order = this.turns.map((t) => t.shooterId);
    this.idleRounds = this.turns.length ? 0 : this.idleRounds + 1;
    this.emit(this.turns.length ? { type: 'reveal' } : { type: 'idle', count: this.idleRounds });
  }

  /** เดินการเปิดคำสั่งหนึ่งจังหวะ: เปิดคำสั่งของคนถัดไป, ยิงหนึ่งนัด หรือจบรอบ */
  step() {
    if (this.phase !== 'reveal') return;

    if (this.current && this.current.pending.length) {
      this.fire(this.current.shooterId, this.current.pending.shift());
      return;
    }

    this.current = null;
    while (this.turns.length) {
      const { shooterId, shots } = this.turns.shift();
      const pending = shots.filter((s) => !this.player(s.target).left);
      if (!pending.length) continue;
      this.current = { shooterId, pending };
      this.emit({ type: 'open', shooterId, count: pending.length });
      return;
    }

    if (this.idleRounds >= CONFIG.idleRoundsToEnd) this.endByShipCells('idle');
    else this.startCommand();
  }

  fire(shooterId, { target, cell }) {
    const shooter = this.player(shooterId);
    const victim = this.player(target);
    shooter.bullets = Math.max(0, shooter.bullets - 1);

    const repeat = Boolean(victim.shots[cell]);
    const ship = victim.ships.find((s) => Rules.cellsOf(s).includes(cell));
    const hit = !repeat && Boolean(ship);
    if (!repeat) victim.shots[cell] = hit ? 'hit' : 'miss';

    const event = { type: 'shot', shooterId, target, cell, result: hit ? 'hit' : 'miss', repeat };

    if (hit) {
      // นัดที่โดนเรือหายไปจากเกม
      if (this.isSunk(victim, ship)) event.sunk = ship.size;
      if (victim.ships.every((s) => this.isSunk(victim, s))) {
        victim.alive = false;
        victim.bullets = 0;
        event.eliminated = true;
      }
    } else if (victim.alive) {
      // นัดที่พลาดเป็นของเจ้าของกระดานทันที
      victim.bullets += 1;
      event.transferred = true;
    }

    this.emit(event);
    if (event.eliminated) this.checkLastStanding();
  }

  isSunk(player, ship) {
    return Rules.cellsOf(ship).every((cell) => player.shots[cell] === 'hit');
  }

  shipCellsLeft(player) {
    return player.ships.flatMap((s) => Rules.cellsOf(s)).filter((cell) => player.shots[cell] !== 'hit').length;
  }

  // ---------- จบเกม ----------

  checkLastStanding() {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length > 1) return false;
    this.finish(alive.map((p) => p.id), 'last');
    return true;
  }

  endByShipCells(reason) {
    const alive = this.players.filter((p) => p.alive);
    const best = Math.max(...alive.map((p) => this.shipCellsLeft(p)));
    this.finish(alive.filter((p) => this.shipCellsLeft(p) === best).map((p) => p.id), reason);
  }

  finish(winnerIds, reason) {
    this.phase = 'over';
    this.deadline = null;
    this.turns = [];
    this.current = null;
    this.winnerIds = winnerIds;
    this.winReason = reason;
    this.emit({ type: 'over', winnerIds, reason });
  }

  emit(event) {
    this.lastEvent = { seq: ++this.seq, ...event };
    // เก็บชื่อไว้ในบันทึกด้วย เพื่อให้อ่านได้แม้ผู้เล่นออกไปแล้ว
    const names = Object.fromEntries(this.players.map((p) => [p.id, p.name]));
    this.log.push({ ...this.lastEvent, names });
    if (this.log.length > CONFIG.logSize) this.log.shift();
  }

  // ---------- มุมมองของผู้เล่นแต่ละคน ----------

  /** ข้อมูลที่ส่งให้เบราว์เซอร์ ต้องไม่มีตำแหน่งเรือหรือคำสั่งลับของคนอื่น */
  view(viewerId) {
    const viewer = this.players.find((p) => p.id === viewerId);
    return {
      code: this.code,
      phase: this.phase,
      you: viewerId,
      hostId: this.hostId,
      settings: { ...this.settings },
      limits: CONFIG,
      round: this.round,
      timeLeftMs: this.deadline ? Math.max(0, this.deadline - this.now()) : null,
      players: this.players.map((p) => {
        const showAll = p.id === viewerId || this.phase === 'over';
        return {
          id: p.id,
          name: p.name,
          isBot: p.isBot,
          level: p.level,
          connected: p.connected,
          left: p.left,
          alive: p.alive,
          bullets: p.bullets,
          ready: p.ready,
          submitted: p.submitted,
          shots: { ...p.shots },
          ships: showAll ? p.ships : p.ships.filter((s) => this.isSunk(p, s)),
          cellsLeft: p.ships.length ? this.shipCellsLeft(p) : null,
        };
      }),
      myShots: viewer ? (viewer.submitted ? viewer.command : viewer.draft) : [],
      current: this.current ? { shooterId: this.current.shooterId, pending: this.current.pending.slice() } : null,
      // บอกแค่ว่าใครยิงลำดับไหน ช่องที่จะยิงของคนที่ยังไม่ถึงคิวไม่ถูกส่งไป
      reveal: this.phase === 'reveal' ? { order: this.order.slice(), waiting: this.turns.map((t) => t.shooterId) } : null,
      lastEvent: this.lastEvent,
      log: this.log,
      winnerIds: this.winnerIds,
      winReason: this.winReason,
    };
  }
}

module.exports = { Game, GameError, CONFIG };
