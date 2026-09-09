export const MODULE_ID = "pf2e-hero-slots";
export const SYMBOLS = Object.freeze([
  { id: "cherry", label: "Вишня", glyph: "🍒" },
  { id: "lemon", label: "Лимон", glyph: "🍋" },
  { id: "grapes", label: "Виноград", glyph: "🍇" },
  { id: "seven", label: "Семёрка", glyph: "7" }
]);

export function validateRerolls(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Число перебросов должно быть целым: от 0 до 100.");
  }
  return value;
}

export function spinSymbols(random = Math.random) {
  return Array.from({ length: 3 }, () => {
    const n = random();
    if (!Number.isFinite(n) || n < 0 || n >= 1) throw new Error("Ошибка генератора случайных чисел.");
    return SYMBOLS[Math.floor(n * SYMBOLS.length)].id;
  });
}

export function isWin(symbols) {
  return Array.isArray(symbols) && symbols.length === 3 &&
    SYMBOLS.some(s => s.id === symbols[0]) && symbols.every(s => s === symbols[0]);
}

export function heroAward(resource) {
  if (!resource || !Number.isInteger(resource.value) || !Number.isInteger(resource.max) ||
      resource.value < 0 || resource.max < 0) throw new Error("У персонажа нет корректного запаса героических очков.");
  const awarded = resource.value < resource.max ? 1 : 0;
  return { awarded, value: resource.value + awarded, capped: awarded === 0 };
}

export function createRound(id, rerolls, users, now = Date.now()) {
  validateRerolls(rerolls);
  return {
    id, active: true, rerolls, total: rerolls + 1, createdAt: now,
    entries: Object.fromEntries(users.filter(u => !u.isGM).map(u => [u.id, {
      userId: u.id, actorId: u.character?.id ?? null, used: 0, wins: 0, awarded: 0, last: null
    }]))
  };
}
