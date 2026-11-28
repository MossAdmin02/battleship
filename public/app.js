/* global io, Rules */
(() => {
  const socket = io();
  const root = document.getElementById('app');

  let state = null; // มุมมองล่าสุดจากเซิร์ฟเวอร์
  let deadline = null; // เวลาหมดตามนาฬิกาเครื่องนี้
  let seenSeq = 0; // เหตุการณ์ล่าสุดที่เล่นแอนิเมชันไปแล้ว
  let freshEvent = null;
  let selected = []; // ช่องที่เลือกจะยิง [{target, cell}]
  let selectedRound = null;
  let targetView = null; // ผู้เล่นที่กำลังเปิดกระดานดูตอนสั่งยิง
  const folds = { own: false, all: false, over: true, log: false }; // ส่วนที่หุบ/กางได้: กางอยู่หรือไม่
  let scrollAfterRender = null; // selector ที่ต้องเลื่อนจอไปหาหลังวาดหน้าใหม่
  let fleet = []; // เรือที่กำลังจัดวาง
  let holding = null; // index ใน Rules.FLEET ของเรือที่กำลังจะวาง
  let direction = 'h';
  let homeError = '';
  let homeTab = null; // แผงที่เปิดอยู่บนหน้าแรก: 'start' | 'mode' | 'settings'

  // ---------- เก็บข้อมูลในเครื่อง ----------

  function read(storage, key) {
    try { return window[storage].getItem(key); } catch { return null; }
  }
  function write(storage, key, value) {
    try {
      if (value === null) window[storage].removeItem(key);
      else window[storage].setItem(key, value);
    } catch { /* โหมดส่วนตัวบางแบบเขียนไม่ได้ */ }
  }

  const urlCode = () => (new URLSearchParams(location.search).get('room') || '').toUpperCase();

  /** ค่าตั้งห้องที่ผู้ใช้บันทึกไว้ในเมนูตั้งค่า (เฉพาะค่าที่ยังใช้ได้) */
  function savedSettings() {
    const { minStartBullets, maxStartBullets, commandSeconds } = Rules.LIMITS;
    const out = {};
    const bullets = Number(read('localStorage', 'startBullets'));
    if (bullets >= minStartBullets && bullets <= maxStartBullets) out.startBullets = bullets;
    const seconds = Number(read('localStorage', 'commandSeconds'));
    if (commandSeconds.includes(seconds)) out.commandSeconds = seconds;
    if (read('localStorage', 'autoBullet') === 'on') out.autoBullet = true;
    return out;
  }

  const applyEffects = () => document.body.classList.toggle('no-fx', read('localStorage', 'effects') === 'off');

  const bulletChoices = () => Array.from(
    { length: Rules.LIMITS.maxStartBullets - Rules.LIMITS.minStartBullets + 1 },
    (_, i) => Rules.LIMITS.minStartBullets + i,
  );

  function setUrlCode(code) {
    history.replaceState(null, '', code ? `?room=${code}` : location.pathname);
  }

  // ---------- สร้าง DOM (ข้อความจากผู้เล่นใส่เป็น text node เสมอ) ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.flat().filter((c) => c !== false && c !== null && c !== undefined));
    return el;
  }

  function svg(markup) {
    const holder = document.createElement('template');
    holder.innerHTML = markup; // ใช้กับรูปคงที่ในไฟล์นี้เท่านั้น
    return holder.content.firstChild;
  }

  let toastTimer = null;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /** ส่งคำสั่งแล้วรอคำตอบ ถ้าเงียบ (เช่น เซิร์ฟเวอร์เป็นรุ่นเก่ากว่าหน้าเว็บ) ต้องบอกผู้ใช้ */
  function emit(event, payload, done) {
    socket.timeout(5000).emit(event, payload || {}, (timedOut, res) => {
      done(timedOut ? { ok: false, error: 'เซิร์ฟเวอร์ไม่ตอบ ลองปิดแล้วเปิดเซิร์ฟเวอร์ใหม่ และรีเฟรชหน้านี้' } : res);
    });
  }

  function send(event, payload, onOk) {
    if (!socket.connected) return toast('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    emit(event, payload, (res) => {
      if (!res.ok) toast(res.error);
      else if (onOk) onOk(res);
    });
  }

  // ---------- เข้า/ออกห้อง ----------

  const request = (event, payload) => new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
    emit(event, payload, (res) => (res.ok ? resolve(res) : reject(new Error(res.error))));
  });

  /** สร้างห้อง ถ้าระบุ bots จะเติมบอทแล้วเริ่มเกมทันที */
  async function createRoom(name, bots) {
    try {
      entered(await request('create', { name }));
      const settings = savedSettings();
      if (Object.keys(settings).length) await request('settings', settings);
      if (!bots) return;
      for (let i = 0; i < bots.count; i++) await request('addBot', { level: bots.level });
      await request('start');
    } catch (error) {
      toast(error.message);
    }
  }

  function entered(res) {
    homeError = '';
    write('sessionStorage', `seat:${res.code}`, res.token);
    write('localStorage', `seat:${res.code}`, res.token);
    setUrlCode(res.code);
  }

  function join(code, name, onFail) {
    const own = read('sessionStorage', `seat:${code}`);
    emit('join', { code, name, token: own || read('localStorage', `seat:${code}`), sameTab: Boolean(own) }, (res) => {
      if (res.ok) entered(res);
      else onFail(res.error);
    });
  }

  function goHome(message = '') {
    state = null;
    homeError = message;
    homeTab = message ? 'start' : null;
    seenSeq = 0;
    render();
  }

  function leaveRoom() {
    const playing = state && ['command', 'reveal'].includes(state.phase) && me()?.alive;
    if (playing && !window.confirm('ออกตอนนี้ถือว่าตกรอบ ยืนยันออกจากห้อง?')) return;
    const { code } = state;
    send('leave', {}, () => {
      write('sessionStorage', `seat:${code}`, null);
      write('localStorage', `seat:${code}`, null);
      setUrlCode('');
      goHome();
    });
  }

  socket.on('connect', () => {
    document.getElementById('offline').hidden = true;
    const code = state?.code || urlCode();
    // กลับเข้าห้องอัตโนมัติเมื่อมีที่นั่งเดิมอยู่
    if (code && (read('sessionStorage', `seat:${code}`) || state)) {
      join(code, read('localStorage', 'name') || '', (error) => {
        write('sessionStorage', `seat:${code}`, null);
        goHome(error);
      });
    }
  });

  socket.on('disconnect', () => { document.getElementById('offline').hidden = false; });

  socket.on('replaced', () => {
    setUrlCode('');
    goHome('ที่นั่งนี้ถูกเปิดใช้ในหน้าต่างอื่น');
  });

  socket.on('state', (next) => {
    const first = !state || state.code !== next.code;
    const previousPhase = first ? null : state.phase;
    state = next;
    deadline = next.timeLeftMs === null ? null : Date.now() + next.timeLeftMs;

    const seq = next.lastEvent?.seq || 0;
    freshEvent = !first && seq > seenSeq ? next.lastEvent : null;
    seenSeq = seq;

    if (next.phase === 'placing' && previousPhase !== 'placing') {
      const mine = me();
      fleet = mine.ready ? mine.ships.slice() : [];
      holding = mine.ready ? null : 0;
      direction = 'h';
    }
    if (next.phase === 'command') {
      const mine = me();
      const newRound = previousPhase !== 'command' || selectedRound !== next.round;
      if (newRound) {
        // เริ่มรอบใหม่: หุบกระดานเป้าไว้ก่อน เว้นแต่เหลือคู่ต่อสู้คนเดียว
        const enemies = next.players.filter((p) => p.id !== next.you && p.alive);
        targetView = enemies.length === 1 ? enemies[0].id : null;
        if (targetView !== null) scrollAfterRender = '.stage';
      }
      if (newRound || mine.submitted) {
        selected = next.myShots.slice();
        selectedRound = next.round;
      }
      // ตัดเป้าที่ใช้ไม่ได้แล้ว (เช่น เจ้าของกระดานออกจากห้อง)
      selected = selected.filter((s) => player(s.target)?.alive);
      if (!player(targetView)) targetView = null;
    }
    if (next.phase === 'over' && previousPhase !== 'over') folds.over = true;
    if (previousPhase !== next.phase) window.scrollTo({ top: 0, behavior: 'smooth' });
    // เลื่อนจอตามกระดานที่เพิ่งถูกยิง
    if (freshEvent?.type === 'shot' && next.phase === 'reveal') scrollAfterRender = '.stage';
    render();
  });

  const me = () => state.players.find((p) => p.id === state.you);
  const player = (id) => state.players.find((p) => p.id === id);
  const isHost = () => state.hostId === state.you;
  const displayName = (p) => (p.isBot ? `🤖 ${p.name}` : p.name);
  const BOT_LEVELS = { easy: 'ง่าย', hard: 'เก่ง' };

  // ---------- กระดาน ----------

  const MARK = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 1v38M1 20h38" class="cross"/><circle cx="20" cy="20" r="15" class="outer"/><circle cx="20" cy="20" r="8.5" class="ring"/><circle cx="20" cy="20" r="3" class="dot"/></svg>';

  // ยานมองจากด้านบน หัวชี้ไปทางขวา ยาว 100 หน่วยต่อช่อง
  const SHIP_ART = {
    1: '<path class="hull" d="M94 50L62 38L44 16H22L32 38L14 40V60L32 62L22 84H44L62 62Z"/>'
      + '<ellipse class="deck" cx="55" cy="50" rx="15" ry="8"/><path class="thrust" d="M7 44V56"/>',
    2: '<path class="hull" d="M195 50L162 34L120 30L98 12H62L72 30H28L12 38V62L28 70H72L62 88H98L120 70L162 66Z"/>'
      + '<rect class="deck" x="38" y="40" width="54" height="20" rx="5"/><path class="deck" d="M104 38H128V62H104Z"/>'
      + '<ellipse class="deck" cx="153" cy="50" rx="17" ry="8"/><path class="thrust" d="M7 41V47M7 53V59"/>',
    3: '<path class="hull" d="M296 50L268 36L224 32L208 20H164L148 7H98L110 24H46L36 31H13V69H36L46 76H110L98 93H148L164 80H208L224 68L268 64Z"/>'
      + '<rect class="deck" x="44" y="36" width="56" height="28" rx="5"/><rect class="deck" x="112" y="30" width="62" height="40" rx="6"/>'
      + '<circle class="deck" cx="143" cy="50" r="11"/><circle class="deck" cx="198" cy="50" r="9"/><circle class="deck" cx="229" cy="50" r="7"/>'
      + '<path class="deck" d="M205 50H219M235 50H250M252 44L276 50L252 56Z"/><path class="thrust" d="M7 35V41M7 47V53M7 59V65"/>',
  };

  function shipShape(ship) {
    const length = ship.size * 100;
    const vertical = ship.dir === 'v';
    const box = vertical ? `0 0 100 ${length}` : `0 0 ${length} 100`;
    const turn = vertical ? 'transform="translate(100 0) rotate(90)"' : '';
    const el = h('div', { class: 'ship' }, svg(`<svg viewBox="${box}" aria-hidden="true"><g ${turn}>${SHIP_ART[ship.size]}</g></svg>`));
    el.style.left = `${ship.c * 20}%`;
    el.style.top = `${ship.r * 20}%`;
    el.style.width = `${(vertical ? 1 : ship.size) * 20}%`;
    el.style.height = `${(vertical ? ship.size : 1) * 20}%`;
    return el;
  }

  /** ตาราง 5×5 พร้อมยานและเครื่องหมาย: overlay(cell) คืน {mark, label, title} หรือ null */
  function boardGrid({ ships = [], overlay = () => null, onCell, canClick, owner, focusKey = 'place' }) {
    const cells = [];
    for (let cell = 0; cell < Rules.SIZE * Rules.SIZE; cell++) {
      const info = overlay(cell);
      const clickable = Boolean(onCell) && (!canClick || canClick(cell));
      const status = info ? ` ${info.title}` : '';
      cells.push(h(clickable ? 'button' : 'div', {
        class: `cell${clickable ? ' clickable' : ''}`,
        type: clickable ? 'button' : null,
        'data-cell': cell,
        'data-focus': clickable ? `${focusKey}-${cell}` : null,
        'aria-label': clickable || info ? `${owner} ช่อง ${Rules.cellName(cell)}${status}` : null,
        onclick: clickable ? () => onCell(cell) : null,
      }, info && h('span', { class: `mark ${info.mark}` }, svg(MARK), info.label && h('b', null, info.label))));
    }
    return h('div', { class: 'frame' },
      h('div', { class: 'corner' }),
      h('div', { class: 'cols' }, [1, 2, 3, 4, 5].map((n) => h('span', null, String(n)))),
      h('div', { class: 'rows' }, [...Rules.ROWS].map((r) => h('span', null, r))),
      h('div', { class: 'sea' }, ships.map(shipShape), h('div', { class: 'cells' }, cells)),
    );
  }

  /** ป้ายสถานะสั้นๆ ของผู้เล่น */
  function badgeFor(p) {
    if (state.phase === 'over') return state.winnerIds.includes(p.id) ? '🏆 ชนะ' : '💀 แพ้';
    if (p.left) return 'ออกแล้ว';
    if (!p.alive) return 'ตกรอบ';
    if (!p.connected) return 'หลุด';
    if (state.phase === 'command') return p.submitted ? '✓ ส่งแล้ว' : 'กำลังเขียน…';
    return null;
  }

  function playerBoard(p) {
    const own = p.id === state.you;
    const targeting = state.phase === 'command' && !own && p.alive && me().alive && !me().submitted;
    const shooting = state.phase === 'reveal' && state.current?.shooterId === p.id;
    const event = freshEvent?.type === 'shot' && freshEvent.target === p.id ? freshEvent : null;

    const overlay = (cell) => {
      const pendingShot = state.current?.pending.some((s) => s.target === p.id && s.cell === cell);
      if (pendingShot) return { mark: 'pending', title: 'กำลังจะถูกยิง' };
      const result = p.shots[cell];
      if (result) {
        const fresh = event && event.cell === cell ? ' fresh' : '';
        return { mark: `${result}${fresh}`, title: result === 'hit' ? 'โดนเรือ' : 'ยิงพลาด' };
      }
      if (state.phase === 'command') {
        const index = selected.findIndex((s) => s.target === p.id && s.cell === cell);
        if (index >= 0) return { mark: 'aim', label: String(index + 1), title: 'เลือกไว้' };
      }
      return null;
    };

    const badge = badgeFor(p);
    let outcome = '';
    if (state.phase === 'over') outcome = state.winnerIds.includes(p.id) ? ' win' : ' lose';
    const classes = ['board', own && 'own', !p.alive && 'dead', targeting && 'targetable', shooting && 'shooting', event && `struck-${event.result}`];
    return h('section', { class: classes.filter(Boolean).join(' '), 'data-player': p.id },
      boardGrid({
        owner: p.name,
        focusKey: `cell-${p.id}`,
        ships: p.ships,
        overlay,
        onCell: targeting ? (cell) => toggleShot(p.id, cell) : null,
        canClick: (cell) => !p.shots[cell],
      }),
      h('div', { class: 'info' },
        h('span', { class: 'bullets', title: 'กระสุน' }, `● ${p.bullets}`),
        badge && h('span', { class: `badge${outcome}` }, badge),
        h('span', { class: 'nametag' }, own ? `${p.name} (คุณ)` : displayName(p)),
      ),
    );
  }

  function toggleShot(target, cell) {
    const index = selected.findIndex((s) => s.target === target && s.cell === cell);
    if (index >= 0) selected.splice(index, 1);
    else if (selected.length >= me().bullets) return toast(`คุณมีกระสุน ${me().bullets} นัด (กดช่องเดิมเพื่อยกเลิก)`);
    else selected.push({ target, cell });
    send('draft', { shots: selected });
    render();
  }

  // ---------- เลือกเป้า และดูการเปิดคำสั่ง ----------

  const nameOf = (id) => {
    if (id === state.you) return 'คุณ';
    const p = player(id);
    return p ? displayName(p) : '?';
  };

  /** ส่วนที่กดหัวเพื่อหุบ/กางได้ */
  function fold(key, title, content, info) {
    const open = folds[key];
    return h('section', { class: `fold${open ? ' open' : ''}`, 'data-fold': key },
      h('button', {
        type: 'button',
        class: 'fold-head',
        'aria-expanded': String(open),
        'data-focus': `fold-${key}`,
        onclick: () => {
          folds[key] = !folds[key];
          if (folds[key]) scrollAfterRender = `[data-fold="${key}"]`;
          render();
        },
      }, h('span', null, `${open ? '▾' : '▸'} ${title}`), info && h('small', null, info)),
      open && h('div', { class: 'fold-body' }, content()),
    );
  }

  /** ภาพย่อของกระดาน ช่วยตัดสินใจก่อนเปิดดูกระดานจริง */
  function miniBoard(p) {
    return h('span', { class: 'mini', 'aria-hidden': 'true' }, Array.from({ length: Rules.SIZE * Rules.SIZE }, (_, cell) => {
      const aimed = selected.some((s) => s.target === p.id && s.cell === cell);
      return h('i', { class: p.shots[cell] || (aimed ? 'aim' : '') });
    }));
  }

  function pickTarget(id) {
    targetView = targetView === id ? null : id; // กดคนเดิมซ้ำ = หุบ
    if (targetView !== null) scrollAfterRender = '.stage';
    render();
  }

  function targetPicker(players) {
    return h('div', { class: 'picker', role: 'group', 'aria-label': 'เลือกผู้เล่นเพื่อเปิดกระดาน' },
      players.filter((p) => p.id !== state.you).map((p) => {
        const aimed = selected.filter((s) => s.target === p.id).length;
        const active = targetView === p.id;
        return h('button', {
          type: 'button',
          class: `pick${active ? ' active' : ''}${p.alive ? '' : ' dead'}`,
          'aria-pressed': String(active),
          'data-pick': p.id,
          'data-focus': `pick-${p.id}`,
          onclick: () => pickTarget(p.id),
        },
        miniBoard(p),
        h('span', { class: 'pick-text' },
          h('b', null, displayName(p)),
          h('small', null, `● ${p.bullets} · ยาน ${p.cellsLeft} ช่อง`),
          h('small', { class: 'pick-state' }, badgeFor(p) || ''),
        ),
        aimed > 0 && h('em', { class: 'count' }, `เล็ง ${aimed}`));
      }),
    );
  }

  function targetStage() {
    const p = player(targetView);
    if (!p) {
      const canShoot = me().alive && !me().submitted;
      return h('p', { class: 'prompt' }, canShoot ? '👆 เลือกคนที่จะโจมตี แล้วกระดานจะเปิดขึ้น' : '👆 เลือกผู้เล่นเพื่อดูกระดาน');
    }
    return h('section', { class: 'panel stage' },
      h('div', { class: 'stage-head' },
        h('h2', null, `🎯 ${displayName(p)}`),
        timer(),
        h('button', { type: 'button', class: 'close', 'data-focus': 'close', onclick: closeTarget }, 'หุบกระดาน ✕'),
      ),
      playerBoard(p),
    );
  }

  /** หุบแล้วพากลับไปที่รายชื่อ จะได้เลือกคนใหม่ได้ทันที */
  function closeTarget() {
    targetView = null;
    scrollAfterRender = '.picker';
    render();
  }

  /** รายการช่องที่เลือกไว้ทุกกระดาน (เพราะเปิดดูได้ทีละคน) กดเพื่อยกเลิกได้ก่อนส่ง */
  function aimList() {
    if (!selected.length) return null;
    const locked = me().submitted;
    return h('div', { class: 'chips aims', role: 'group', 'aria-label': 'คำสั่งยิงของคุณ' }, selected.map((s, i) => {
      const text = `${i + 1}. ${nameOf(s.target)} ${Rules.cellName(s.cell)}`;
      if (locked) return h('span', { class: 'chip aim' }, text);
      return h('button', {
        type: 'button',
        class: 'chip aim',
        'aria-label': `ยกเลิก ${text}`,
        'data-focus': `aim-${s.target}-${s.cell}`,
        onclick: () => toggleShot(s.target, s.cell),
      }, `${text} ✕`);
    }));
  }

  /** ลำดับผู้ยิงของรอบนี้ ใครยิงแล้ว กำลังยิง หรือรออยู่ */
  function turnStrip() {
    const { order = [], waiting = [] } = state.reveal || {};
    if (!order.length) return null;
    return h('ol', { class: 'turns', 'aria-label': 'ลำดับการเปิดคำสั่ง' }, order.map((id) => {
      let status = 'done';
      if (state.current?.shooterId === id) status = 'now';
      else if (waiting.includes(id)) status = 'wait';
      const icon = { done: '✓ ', now: '▶ ', wait: '' }[status];
      return h('li', { class: status, 'aria-current': status === 'now' ? 'step' : null }, `${icon}${nameOf(id)}`);
    }));
  }

  /** แสดงทีละคน: ใครกำลังยิง ยิงใส่ใคร และกระดานที่กำลังถูกยิง */
  function revealStage() {
    const shooterId = state.current?.shooterId;
    const last = state.lastEvent;
    if (shooterId === undefined) {
      return h('p', { class: 'prompt' }, last.type === 'idle' ? 'รอบนี้ไม่มีใครยิง' : 'กำลังเปิดคำสั่ง…');
    }
    const opened = state.log.filter((e) => e.type === 'open' && e.shooterId === shooterId).pop()?.seq ?? Infinity;
    const fired = state.log.filter((e) => e.type === 'shot' && e.shooterId === shooterId && e.seq > opened);
    const { pending } = state.current;
    const targetId = last.type === 'shot' ? last.target : pending[0]?.target ?? fired[fired.length - 1]?.target;
    const target = player(targetId);

    const side = (label, id, kind) => h('span', { class: `who ${kind}` }, h('small', null, label), h('b', null, nameOf(id)));
    const chip = (shot, kind, note) => h('span', { class: `chip ${kind}` }, `${nameOf(shot.target)} ${Rules.cellName(shot.cell)} ${note}`);

    return h('section', { class: 'panel stage' },
      h('div', { class: 'versus' },
        side('ผู้ยิง', shooterId, 'shooter'),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '➜'),
        target && side('เป้าหมาย', targetId, 'victim'),
      ),
      h('div', { class: 'chips' },
        fired.map((s) => chip(s, s.result, s.result === 'hit'
          ? `💥 โดน${s.sunk ? ' · เรือจม' : ''}${s.eliminated ? ' · ตกรอบ' : ''}`
          : '✖ พลาด')),
        pending.map((s) => chip(s, 'wait', '…')),
      ),
      target && playerBoard(target),
    );
  }

  // ---------- หน้าแรก ----------

  /** ช่องใส่ชื่อ พร้อมตัวช่วยตรวจว่าใส่แล้วก่อนทำคำสั่งต่อ */
  function nameField(error) {
    const input = h('input', { id: 'name', maxlength: 16, placeholder: 'ชื่อของคุณ', autocomplete: 'nickname', value: read('localStorage', 'name') || '' });
    input.addEventListener('input', () => write('localStorage', 'name', input.value.trim() || null));
    return {
      element: h('label', { class: 'field' }, 'ชื่อผู้เล่น', input),
      withName(action) {
        const name = input.value.trim();
        if (!name) {
          error.textContent = 'กรุณาใส่ชื่อก่อน';
          return input.focus();
        }
        write('localStorage', 'name', name);
        action(name);
      },
    };
  }

  function startPanel() {
    const error = h('p', { class: 'error', role: 'alert' }, homeError);
    const name = nameField(error);
    const codeInput = h('input', { id: 'code', maxlength: 4, placeholder: 'รหัสห้อง', 'aria-label': 'รหัสห้อง', autocapitalize: 'characters', autocomplete: 'off', value: urlCode() });

    const create = () => name.withName((value) => createRoom(value));
    const enter = (event) => {
      event.preventDefault();
      const code = codeInput.value.trim().toUpperCase();
      if (!code) return create();
      name.withName((value) => join(code, value, (message) => { error.textContent = message; }));
    };

    const invited = Boolean(urlCode());
    const joinRow = h('div', { class: 'row' }, codeInput, h('button', { type: 'submit', class: invited ? 'primary' : '' }, 'เข้าห้อง'));
    const createButton = h('button', { type: 'button', class: invited ? '' : 'primary', onclick: create }, 'สร้างห้องใหม่');

    return h('div', { class: 'panel' },
      h('button', { type: 'button', class: 'ghost back', onclick: () => openTab(null) }, '← กลับหน้าหลัก'),
      h('form', { onsubmit: enter },
        name.element,
        invited ? [joinRow, h('div', { class: 'or' }, 'หรือ'), createButton]
          : [createButton, h('div', { class: 'or' }, 'หรือเข้าห้องของเพื่อน'), joinRow],
        error,
      ),
    );
  }

  function modePanel() {
    const error = h('p', { class: 'error', role: 'alert' });
    const name = nameField(error);
    const count = h('select', { id: 'bot-count' }, Array.from(
      { length: Rules.LIMITS.maxPlayers - 1 },
      (_, i) => h('option', { value: i + 1, selected: i + 1 === 3 }, `${i + 1} ตัว`),
    ));
    const level = h('select', { id: 'bot-level' }, Object.entries(BOT_LEVELS).map(
      ([value, label]) => h('option', { value, selected: value === 'hard' }, label),
    ));

    return h('div', { class: 'panel' },
      h('h2', null, 'โหมดการเล่น'),
      name.element,
      h('section', { class: 'mode' },
        h('h3', null, '👥 เล่นกับเพื่อน'),
        h('p', null, 'สร้างห้องหรือเข้าห้องด้วยรหัส เล่นได้ 2–8 คน เติมบอทในห้องได้'),
        h('button', { type: 'button', onclick: () => openTab('start') }, 'สร้าง / เข้าห้อง'),
      ),
      h('section', { class: 'mode' },
        h('h3', null, '🤖 เล่นกับบอท'),
        h('label', { class: 'setting' }, 'จำนวนบอท', count),
        h('label', { class: 'setting' }, 'ความเก่ง', level),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => name.withName((value) => createRoom(value, { count: Number(count.value), level: level.value })),
        }, 'เริ่มเล่นกับบอท'),
      ),
      error,
    );
  }

  /** สวิตช์เพิ่มกระสุนอัตโนมัติ ใช้ทั้งหน้าตั้งค่าและห้องรอ */
  function autoBulletSwitch(checked, attrs) {
    return h('label', { class: 'setting switch' },
      h('span', null, 'เพิ่มกระสุน 1 นัดทุกรอบ', h('small', null, 'ตั้งแต่รอบที่ 2 ทุกคนที่ยังรอดได้เพิ่มอัตโนมัติ')),
      h('input', { type: 'checkbox', checked, ...attrs }),
    );
  }

  function settingsPanel() {
    const current = { ...Rules.DEFAULT_SETTINGS, ...savedSettings() };
    const name = nameField(h('p'));
    const select = (key, label, values, format) => h('label', { class: 'setting' }, label,
      h('select', { onchange: (e) => write('localStorage', key, e.target.value) },
        values.map((v) => h('option', { value: v, selected: v === current[key] }, format(v)))),
    );
    return h('div', { class: 'panel' },
      h('h2', null, 'ตั้งค่า'),
      name.element,
      select('startBullets', 'กระสุนเริ่มต้นของห้องที่ฉันสร้าง', bulletChoices(), (v) => `${v} นัด`),
      select('commandSeconds', 'เวลาเขียนคำสั่งยิง', Rules.LIMITS.commandSeconds, (v) => `${v} วินาที`),
      autoBulletSwitch(current.autoBullet, {
        onchange: (e) => write('localStorage', 'autoBullet', e.target.checked ? 'on' : null),
      }),
      h('label', { class: 'setting switch' }, 'เอฟเฟกต์เคลื่อนไหว', h('input', {
        type: 'checkbox',
        checked: read('localStorage', 'effects') !== 'off',
        onchange: (e) => {
          write('localStorage', 'effects', e.target.checked ? null : 'off');
          applyEffects();
        },
      })),
      h('p', { class: 'muted' }, 'บันทึกในเครื่องนี้โดยอัตโนมัติ'),
    );
  }

  function openTab(id) {
    homeTab = homeTab === id ? null : id;
    homeError = '';
    if (homeTab) scrollAfterRender = '.home .panel';
    render();
  }

  function homeView() {
    const menu = (id, title, subtitle, extra = '') => h('button', {
      type: 'button',
      class: `menu ${extra}${homeTab === id ? ' active' : ''}`,
      'data-tab': id,
      'aria-expanded': String(homeTab === id),
      onclick: () => openTab(id),
    }, h('b', null, title), h('small', null, subtitle));
    const panels = { start: startPanel, mode: modePanel, settings: settingsPanel };

    // กดเข้าเล่นแล้ว เหลือเฉพาะแผงเข้าห้อง ไม่มีภาพยาน เมนู และกติกา
    if (homeTab === 'start') return h('div', { class: 'home' }, startPanel());

    return h('div', { class: 'home' },
      h('div', { class: 'hero' }, h('img', { src: 'img/hero', width: 700, height: 360, alt: 'ยานรบกลางอวกาศ' })),
      h('nav', { class: 'mainmenu', 'aria-label': 'เมนูหลัก' },
        menu('mode', 'โหมดการเล่น', 'GAME MODE'),
        menu('start', 'START GAME', 'เข้าเล่น', 'start'),
        menu('settings', 'ตั้งค่า', 'SETTINGS'),
      ),
      homeTab && panels[homeTab](),
      h('div', { class: 'panel' }, rulesBox(false)),
    );
  }

  function rulesBox(open) {
    return h('details', { class: 'rules', open },
      h('summary', null, 'กติกา'),
      h('ol', null,
        h('li', null, 'เล่น 2–8 คน คนละ 1 กระดาน 5×5 วางเรือ 4 ลำ (ขนาด 3, 2, 1, 1 ช่อง) ตรงไหนก็ได้'),
        h('li', null, 'ช่วงสั่งยิง: ทุกคนเลือกช่องบนกระดานคนอื่นแบบลับๆ จะยิงกี่นัดก็ได้ตามกระสุนที่มี หรือเก็บไว้ก็ได้'),
        h('li', null, 'ช่วงเปิดคำสั่ง: เปิดทีละคน'),
        h('li', null, h('b', null, 'ยิงพลาด'), ' กระสุนนัดนั้นเป็นของเจ้าของกระดานทันที'),
        h('li', null, h('b', null, 'ยิงโดน'), ' กระสุนนัดนั้นหายไปจากเกม'),
        h('li', null, 'ยิงช่องที่เพิ่งถูกคนอื่นยิงไปก่อนในรอบเดียวกัน นับว่าพลาด'),
        h('li', null, 'เรือจมครบทุกลำ = ตกรอบ คนสุดท้ายที่รอดเป็นผู้ชนะ'),
        h('li', null, 'ถ้ากระสุนหมดทุกคน หรือไม่มีใครยิง 3 รอบติด คนที่เหลือช่องเรือมากที่สุดชนะ'),
        h('li', null, 'ถ้าห้องเปิด "เพิ่มกระสุน 1 นัดทุกรอบ" ตั้งแต่รอบที่ 2 ทุกคนที่ยังรอดได้กระสุนเพิ่มคนละ 1 นัด'),
        h('li', null, 'หัวห้องเพิ่มบอทได้ บอทเห็นข้อมูลเท่าผู้เล่นคนหนึ่ง ไม่รู้ตำแหน่งเรือที่ซ่อนอยู่'),
      ),
    );
  }

  // ---------- ห้องรอ ----------

  function copyLink(link) {
    const fallback = () => window.prompt('คัดลอกลิงก์นี้ส่งให้เพื่อน', link);
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(link).then(() => toast('คัดลอกลิงก์แล้ว'), fallback);
  }

  function lobbyView() {
    const { limits, settings, players } = state;
    const link = `${location.origin}${location.pathname}?room=${state.code}`;
    const host = isHost();

    const select = (key, label, values, format) => h('label', { class: 'setting' }, label,
      h('select', {
        disabled: !host,
        onchange: (e) => send('settings', { [key]: Number(e.target.value) }),
      }, values.map((v) => h('option', { value: v, selected: v === settings[key] }, format(v)))),
    );
    const enough = players.length >= limits.minPlayers;

    return h('div', { class: 'panel lobby' },
      h('p', { class: 'muted' }, 'รหัสห้อง'),
      h('div', { class: 'code' }, state.code),
      h('button', { type: 'button', onclick: () => copyLink(link) }, 'คัดลอกลิงก์ชวนเพื่อน'),
      h('h2', null, `ผู้เล่น ${players.length}/${limits.maxPlayers}`),
      h('ul', { class: 'players' }, players.map((p) => h('li', { class: p.connected ? '' : 'away' },
        h('span', null, displayName(p)),
        h('span', { class: 'tags' },
          p.id === state.hostId && h('em', null, 'หัวห้อง'),
          p.id === state.you && h('em', null, 'คุณ'),
          p.isBot && h('em', null, BOT_LEVELS[p.level]),
          !p.connected && h('em', null, 'หลุด'),
          p.isBot && host && h('button', {
            type: 'button',
            class: 'remove',
            'aria-label': `นำ ${p.name} ออก`,
            onclick: () => send('removeBot', { botId: p.id }),
          }, '✕'),
        ),
      ))),
      host && h('div', { class: 'row' }, Object.entries(BOT_LEVELS).map(([level, label]) => h('button', {
        type: 'button',
        disabled: players.length >= limits.maxPlayers,
        onclick: () => send('addBot', { level }),
      }, `+ บอท${label}`))),
      select('startBullets', 'กระสุนเริ่มต้นต่อคน', bulletChoices(), (v) => `${v} นัด`),
      !settings.autoBullet && settings.startBullets < Rules.DEFAULT_SETTINGS.startBullets
        && h('p', { class: 'note' }, 'กระสุนน้อย เกมมักจบเพราะกระสุนหมดก่อนเหลือผู้รอดคนเดียว'),
      select('commandSeconds', 'เวลาเขียนคำสั่งยิง', limits.commandSeconds, (v) => `${v} วินาที`),
      autoBulletSwitch(settings.autoBullet, {
        disabled: !host,
        'data-focus': 'auto-bullet',
        onchange: (e) => send('settings', { autoBullet: e.target.checked }),
      }),
      host
        ? h('button', { type: 'button', class: 'primary', disabled: !enough, onclick: () => send('start') }, enough ? 'เริ่มเกม' : `รอผู้เล่นอย่างน้อย ${limits.minPlayers} คน`)
        : h('p', { class: 'muted' }, 'รอหัวห้องกดเริ่มเกม…'),
      h('button', { type: 'button', class: 'ghost', onclick: leaveRoom }, 'ออกจากห้อง'),
      rulesBox(false),
    );
  }

  // ---------- วางเรือ ----------

  function placingView() {
    const mine = me();
    const placedAt = (index) => fleet.find((s) => s.slot === index) || null;
    // เรือที่เซิร์ฟเวอร์ส่งกลับมาไม่มี slot ให้จับคู่ตามลำดับขนาด
    if (fleet.some((s) => s.slot === undefined)) {
      fleet = fleet.slice().sort((a, b) => b.size - a.size).map((s, slot) => ({ ...s, slot }));
    }

    const nextFree = () => {
      const index = Rules.FLEET.findIndex((_, i) => !placedAt(i));
      return index < 0 ? null : index;
    };

    function clickCell(cell) {
      const r = Math.floor(cell / Rules.SIZE);
      const c = cell % Rules.SIZE;
      const under = fleet.find((s) => Rules.cellsOf(s).includes(cell));
      if (under) { // หยิบเรือขึ้นมาย้าย
        fleet = fleet.filter((s) => s !== under);
        holding = under.slot;
        direction = under.size === 1 ? direction : under.dir;
        return render();
      }
      if (holding === null) return;
      const size = Rules.FLEET[holding];
      const dir = size === 1 ? 'h' : direction;
      // เลื่อนเข้ามาให้อยู่ในกระดานถ้ากดใกล้ขอบ
      const ship = {
        slot: holding,
        size,
        dir,
        r: dir === 'v' ? Math.min(r, Rules.SIZE - size) : r,
        c: dir === 'h' ? Math.min(c, Rules.SIZE - size) : c,
      };
      if (!Rules.canPlace(fleet, ship)) return toast('วางตรงนี้ไม่ได้ เรือทับกัน');
      fleet.push(ship);
      holding = nextFree();
      render();
    }

    const complete = fleet.length === Rules.FLEET.length;
    const waiting = state.players.filter((p) => !p.ready);

    const controls = mine.ready
      ? [
        h('p', { class: 'muted' }, `พร้อมแล้ว รอ ${waiting.map((p) => p.name).join(', ')}`),
        h('button', { type: 'button', onclick: () => send('unready', {}, () => { holding = null; }) }, 'แก้ตำแหน่งเรือ'),
      ]
      : [
        h('p', null, 'เลือกเรือ แล้วกดช่องบนกระดาน (กดเรือที่วางแล้วเพื่อย้าย)'),
        h('div', { class: 'tray' }, Rules.FLEET.map((size, i) => h('button', {
          type: 'button',
          class: `${holding === i ? 'holding' : ''}${placedAt(i) ? ' used' : ''}`,
          'aria-pressed': String(holding === i),
          'aria-label': `เรือขนาด ${size} ช่อง${placedAt(i) ? ' วางแล้ว' : ''}`,
          onclick: () => {
            fleet = fleet.filter((s) => s.slot !== i);
            holding = i;
            render();
          },
        }, Array.from({ length: size }, () => h('i'))))),
        h('div', { class: 'row' },
          h('button', { type: 'button', onclick: () => { direction = direction === 'h' ? 'v' : 'h'; render(); } }, direction === 'h' ? 'แนวนอน ↔' : 'แนวตั้ง ↕'),
          h('button', { type: 'button', onclick: () => { fleet = Rules.randomFleet().map((s, slot) => ({ ...s, slot })); holding = null; render(); } }, 'สุ่มวาง'),
          h('button', { type: 'button', onclick: () => { fleet = []; holding = 0; render(); } }, 'ล้าง'),
        ),
        h('button', {
          type: 'button',
          class: 'primary',
          disabled: !complete,
          onclick: () => send('place', { ships: fleet }),
        }, 'พร้อมแล้ว'),
        h('p', { class: 'muted' }, 'หมดเวลาแล้วยังไม่กดพร้อม ระบบจะสุ่มวางให้'),
      ];

    return h('div', { class: 'panel placing' },
      h('div', { class: 'status' }, h('strong', null, 'วางเรือของคุณ'), timer()),
      h('section', { class: 'board own' },
        boardGrid({ owner: mine.name, ships: fleet, onCell: mine.ready ? null : clickCell }),
        h('div', { class: 'info' }, h('span', { class: 'nametag' }, mine.name)),
      ),
      controls,
      h('button', { type: 'button', class: 'ghost', onclick: leaveRoom }, 'ออกจากห้อง'),
    );
  }

  // ---------- ระหว่างเกม ----------

  function timer() {
    const el = h('span', { class: 'timer', role: 'timer' });
    tick(el);
    return el;
  }

  function tick(el) {
    if (deadline === null) return;
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = `⏱ ${seconds} วินาที`;
    el.classList.toggle('low', seconds <= 10);
  }
  setInterval(() => document.querySelectorAll('.timer').forEach(tick), 250);

  /** แปลงเหตุการณ์เป็นข้อความ */
  function describe(event, names) {
    const name = (id) => (id === state.you ? 'คุณ' : names[id] ?? player(id)?.name ?? '?');
    switch (event.type) {
      case 'round': return `— รอบที่ ${event.round} —${event.refill ? ' ทุกคนได้กระสุน +1' : ''}`;
      case 'reveal': return 'ทุกคนส่งคำสั่งแล้ว เริ่มเปิดคำสั่ง';
      case 'idle': return `รอบนี้ไม่มีใครยิง (ติดต่อกัน ${event.count}/${state.limits.idleRoundsToEnd})`;
      case 'open': return `เปิดคำสั่งของ ${name(event.shooterId)} — ยิง ${event.count} นัด`;
      case 'left': return `${name(event.playerId)} ออกจากเกม`;
      case 'over': return 'จบเกม';
      case 'shot': {
        let text = `${name(event.shooterId)} ยิง ${name(event.target)} ช่อง ${Rules.cellName(event.cell)} — `;
        if (event.result === 'hit') {
          text += '💥 โดน!';
          if (event.sunk) text += ` เรือขนาด ${event.sunk} จม`;
          if (event.eliminated) text += ` ${name(event.target)} ตกรอบ`;
        } else {
          text += event.repeat ? 'ช่องซ้ำ นับว่าพลาด' : 'พลาด';
          if (event.transferred) text += ` กระสุนเป็นของ ${name(event.target)}`;
        }
        return text;
      }
      default: return '';
    }
  }

  function statusBar() {
    if (state.phase === 'reveal') return null; // ช่วงเปิดคำสั่ง แถบลำดับผู้ยิงกับกระดานบอกครบแล้ว
    const mine = me();
    if (state.phase === 'command') {
      const waiting = state.players.filter((p) => p.alive && !p.submitted);
      let title = `รอบที่ ${state.round} · เขียนคำสั่งยิง`;
      let hint = targetView === null ? 'เลือกคนที่จะโจมตี' : 'กดช่องบนกระดานเพื่อเล็ง เปลี่ยนคนได้ตลอด';
      if (!mine.alive) hint = 'คุณตกรอบแล้ว รอดูต่อได้เลย';
      else if (mine.submitted) hint = `รอ ${waiting.map((p) => p.name).join(', ')}`;
      else if (mine.bullets === 0) hint = 'คุณไม่มีกระสุนในรอบนี้';
      const refilled = state.settings.autoBullet && state.round > 1 && mine.alive;
      return h('div', { class: 'status' },
        h('div', null,
          h('strong', null, title),
          refilled && h('em', { class: 'refill' }, '● +1 กระสุน'),
          h('p', null, hint),
        ),
        timer());
    }
    // จบเกม
    const winners = state.winnerIds.map((id) => player(id)?.name).filter(Boolean);
    return h('div', { class: 'status over' },
      h('div', null,
        h('strong', null, winners.length > 1 ? `🏆 เสมอกัน: ${winners.join(', ')}` : `🏆 ${winners[0] || '-'} ชนะ!`),
        h('p', null, WIN_REASONS[state.winReason]),
      ),
      rematchControl(),
    );
  }

  // ---------- ผลจบเกม ----------

  const WIN_REASONS = {
    last: 'รอดเป็นคนสุดท้าย',
    ammo: 'กระสุนหมดทุกคน ตัดสินจากช่องเรือที่เหลือ',
    idle: 'ไม่มีใครยิงหลายรอบติด ตัดสินจากช่องเรือที่เหลือ',
  };

  function rematchControl() {
    return isHost()
      ? h('button', { type: 'button', class: 'primary', onclick: () => send('rematch') }, 'เล่นอีกรอบ')
      : h('p', { class: 'muted' }, 'รอหัวห้องกดเล่นอีกรอบ');
  }

  const TROPHY = '<svg class="trophy" viewBox="0 0 120 120" aria-hidden="true">'
    + '<defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset="0.45" stop-color="#ffc933"/><stop offset="1" stop-color="#b8720a"/></linearGradient></defs>'
    + '<path d="M32 24H15c0 21 9 32 27 35M88 24h17c0 21-9 32-27 35" fill="none" stroke="url(#gold)" stroke-width="8" stroke-linecap="round"/>'
    + '<g fill="url(#gold)" stroke="#6b4204" stroke-width="2.5" stroke-linejoin="round">'
    + '<path d="M52 74h16v18H52z"/><path d="M40 90h40v11H40z"/><path d="M30 101h60v13H30z"/><path d="M29 12h62v30c0 21-13 36-31 36S29 63 29 42z"/></g>'
    + '<path fill="#fffbe6" d="M60 24l4.7 10.5 11.4 1.2-8.5 7.7 2.4 11.2L60 48.9l-10 5.7 2.4-11.2-8.5-7.7 11.4-1.2z"/></svg>';

  const resultDialog = document.getElementById('result');
  let resultClosed = false; // ปิดหน้าต่างผลของเกมนี้ไปแล้ว
  let resultKey = ''; // วาดเนื้อหาใหม่เฉพาะเมื่อข้อมูลที่แสดงเปลี่ยน
  // ปิดเพราะเริ่มเกมใหม่หรือออกจากห้อง ไม่นับว่าผู้เล่นปิดเอง
  resultDialog.addEventListener('close', () => { if (state?.phase === 'over') resultClosed = true; });

  function resultContent(won) {
    const winners = state.players.filter((p) => state.winnerIds.includes(p.id));
    const losers = state.players.filter((p) => !state.winnerIds.includes(p.id));
    const draw = winners.length > 1;
    let verdict = '💀 คุณแพ้';
    if (won) verdict = draw ? '🤝 คุณเสมอ' : '🎉 คุณชนะ!';
    return [
      svg(TROPHY),
      h('p', { class: 'result-label' }, draw ? 'เสมอกัน' : 'ผู้ชนะ'),
      h('h2', { id: 'result-title' }, winners.map(displayName).join(', ') || '-'),
      h('p', { class: 'muted' }, WIN_REASONS[state.winReason]),
      h('p', { class: `verdict ${won ? 'win' : 'lose'}` }, verdict),
      losers.length > 0 && h('ul', { class: 'losers', 'aria-label': 'ผู้แพ้' },
        losers.map((p) => h('li', null, `💀 ${p.id === state.you ? 'คุณ' : displayName(p)} แพ้`))),
      h('div', { class: 'result-actions' },
        rematchControl(),
        h('button', { type: 'button', onclick: () => resultDialog.close() }, 'ดูกระดาน'),
      ),
    ].filter(Boolean);
  }

  /** เปิดหน้าต่างผลเมื่อเกมจบ และปิดเมื่อออกจากช่วงจบเกม */
  function syncResult() {
    if (state?.phase !== 'over') {
      resultClosed = false;
      resultKey = '';
      if (resultDialog.open) resultDialog.close();
      return;
    }
    if (resultClosed) return;
    const key = JSON.stringify([state.code, state.you, state.hostId, state.winnerIds, state.players.map((p) => p.name)]);
    if (key !== resultKey) {
      resultKey = key;
      const won = state.winnerIds.includes(state.you);
      resultDialog.classList.toggle('lose', !won);
      resultDialog.replaceChildren(...resultContent(won));
    }
    if (!resultDialog.open) resultDialog.showModal();
  }

  function actionBar() {
    const mine = me();
    if (state.phase !== 'command' || !mine.alive || mine.bullets === 0) return null;
    if (mine.submitted) {
      return h('div', { class: 'actions' }, aimList(), h('span', null, `✓ ส่งคำสั่งแล้ว (${selected.length} นัด)`));
    }
    return h('div', { class: 'actions' },
      aimList(),
      h('div', { class: 'actions-row' },
        h('span', null, `เล็งแล้ว ${selected.length}/${mine.bullets} นัด`),
        h('button', {
          type: 'button',
          disabled: !selected.length,
          onclick: () => { selected = []; send('draft', { shots: [] }); render(); },
        }, 'ล้าง'),
        h('button', { type: 'button', class: 'primary', onclick: () => send('submit', { shots: selected }) },
          selected.length ? `ส่งคำสั่ง ${selected.length} นัด` : 'ไม่ยิงรอบนี้'),
      ),
    );
  }

  function gameView() {
    const mine = state.players.findIndex((p) => p.id === state.you);
    // กระดานตัวเองขึ้นก่อน ที่เหลือเรียงตามลำดับที่นั่ง
    const ordered = [...state.players.slice(mine), ...state.players.slice(0, mine)];
    const allBoards = () => h('div', { class: 'boards' }, ordered.map(playerBoard));
    const ownBoard = () => fold(
      'own',
      'กระดานของคุณ',
      () => h('div', { class: 'solo' }, playerBoard(me())),
      `● ${me().bullets} · ยาน ${me().cellsLeft} ช่อง`,
    );

    let body;
    if (state.phase === 'command') {
      body = [targetPicker(ordered), targetStage(), actionBar(), ownBoard()];
    } else if (state.phase === 'reveal') {
      body = [turnStrip(), revealStage(), ownBoard(), fold('all', 'กระดานทั้งหมด', allBoards)];
    } else {
      body = [fold('over', 'กระดานทั้งหมด', allBoards)];
    }

    const crowded = state.players.length >= 5 ? ' crowded' : '';
    return h('div', { class: `game phase-${state.phase}${crowded}` },
      statusBar(),
      body,
      fold('log', '📜 บันทึกเกม', () => h('div', { class: 'log' },
        h('ul', null, state.log.slice().reverse().map((e) => h('li', { class: e.type }, describe(e, e.names)))),
      )),
      h('div', { class: 'footer' },
        h('span', null, `ห้อง ${state.code}`),
        h('button', { type: 'button', class: 'ghost', onclick: leaveRoom }, 'ออกจากห้อง'),
      ),
    );
  }

  // ถ้าวาดหน้าใหม่ขณะนิ้วยังกดปุ่มอยู่ การกดนั้นจะหาย (บอทและเพื่อนส่งคำสั่งได้ทุกเมื่อ) จึงรอให้ปล่อยก่อน
  let pressing = false;
  let renderPending = false;
  let releaseTimer = null;
  const release = (delay) => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      pressing = false;
      if (renderPending) render();
    }, delay);
  };
  root.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('button')) return;
    pressing = true;
    release(1500); // กันค้างถ้าไม่ได้รับเหตุการณ์ปล่อย
  }, true);
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, () => { if (pressing) release(60); }, true);
  }

  function render() {
    if (pressing) {
      renderPending = true;
      return;
    }
    renderPending = false;
    let view;
    if (!state) view = homeView();
    else if (state.phase === 'lobby') view = lobbyView();
    else if (state.phase === 'placing') view = placingView();
    else view = gameView();

    // คง focus ของปุ่มเดิมหลังวาดใหม่ (สำหรับคนเล่นด้วยคีย์บอร์ด)
    const focusKey = document.activeElement?.dataset?.focus;
    document.body.dataset.screen = state ? state.phase : 'home';
    // รายการที่เลื่อนได้ ต้องอยู่ตำแหน่งเดิมหลังวาดใหม่
    const scrollers = ['.aims', '.log ul'].map((selector) => {
      const el = root.querySelector(selector);
      return [selector, el?.scrollLeft || 0, el?.scrollTop || 0];
    });
    root.replaceChildren(view);
    for (const [selector, left, top] of scrollers) root.querySelector(selector)?.scrollTo(left, top);
    if (focusKey) root.querySelector(`[data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
    if (scrollAfterRender) {
      // ตอนเล็ง ดันกระดานขึ้นชิดขอบบน ให้แถบคำสั่งใต้กระดานอยู่ในจอด้วย
      const block = state?.phase === 'command' && scrollAfterRender === '.stage' ? 'start' : 'nearest';
      root.querySelector(scrollAfterRender)?.scrollIntoView({ block, behavior: 'smooth' });
      scrollAfterRender = null;
    }
    syncResult();
  }

  applyEffects();
  if (urlCode()) homeTab = 'start'; // เข้ามาจากลิงก์ชวน
  render();
})();
