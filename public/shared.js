// กติกาเรื่องกระดานและการวางเรือ ใช้ร่วมกันทั้งเซิร์ฟเวอร์และเบราว์เซอร์
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(this, function () {
  const SIZE = 5;
  const FLEET = [3, 2, 1, 1];
  const ROWS = 'ABCDE';
  const LIMITS = {
    minPlayers: 2,
    maxPlayers: 8,
    minStartBullets: 1,
    maxStartBullets: 10,
    commandSeconds: [30, 60, 90, 180],
    placingSeconds: 120,
    idleRoundsToEnd: 3, // ไม่มีใครยิงติดต่อกันกี่รอบแล้วจบเกม
  };
  // กระสุนต่ำกว่านี้มาก เกมจะจบเพราะกระสุนหมดก่อนมีใครจมครบ (ยิงโดน 7 ครั้งจึงจมหมดหนึ่งคน)
  // autoBullet: ตั้งแต่รอบที่ 2 ทุกคนที่ยังรอดได้กระสุนเพิ่ม 1 นัดทุกรอบ
  const DEFAULT_SETTINGS = { startBullets: 8, commandSeconds: 60, autoBullet: false };

  /** ช่องที่เรือครอบครอง (index 0..24) หรือ null ถ้าข้อมูลผิดหรือล้นกระดาน */
  function cellsOf(ship) {
    if (!ship) return null;
    const { size, r, c, dir } = ship;
    if (![size, r, c].every(Number.isInteger)) return null;
    if (size < 1 || (dir !== 'h' && dir !== 'v')) return null;
    const cells = [];
    for (let i = 0; i < size; i++) {
      const row = dir === 'v' ? r + i : r;
      const col = dir === 'h' ? c + i : c;
      if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
      cells.push(row * SIZE + col);
    }
    return cells;
  }

  /** วาง ship เพิ่มได้ไหม โดยไม่ล้นกระดานและไม่ทับเรือใน ships (เรือชิดกันได้) */
  function canPlace(ships, ship) {
    const cells = cellsOf(ship);
    if (!cells) return false;
    const used = new Set(ships.flatMap((s) => cellsOf(s) || []));
    return cells.every((cell) => !used.has(cell));
  }

  function isValidFleet(ships) {
    if (!Array.isArray(ships) || ships.length !== FLEET.length) return false;
    const placed = [];
    for (const ship of ships) {
      if (!canPlace(placed, ship)) return false;
      placed.push(ship);
    }
    const sizes = placed.map((s) => s.size).sort((a, b) => b - a);
    return sizes.every((size, i) => size === FLEET[i]);
  }

  function randomFleet(random = Math.random) {
    const ships = [];
    for (const size of FLEET) {
      const options = [];
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          for (const dir of size === 1 ? ['h'] : ['h', 'v']) {
            const ship = { size, r, c, dir };
            if (canPlace(ships, ship)) options.push(ship);
          }
        }
      }
      ships.push(options[Math.floor(random() * options.length)]);
    }
    return ships;
  }

  function cellName(cell) {
    return ROWS[Math.floor(cell / SIZE)] + ((cell % SIZE) + 1);
  }

  return { SIZE, FLEET, ROWS, LIMITS, DEFAULT_SETTINGS, cellsOf, canPlace, isValidFleet, randomFleet, cellName };
});
