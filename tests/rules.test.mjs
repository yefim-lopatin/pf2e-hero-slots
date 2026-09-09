import test from "node:test";
import assert from "node:assert/strict";
import { SYMBOLS, spinSymbols, isWin, heroAward, createRound, validateRerolls } from "../scripts/rules.js";

test("Все 64 комбинации: выигрывают ровно четыре тройных совпадения", () => {
  let wins = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) {
    const numbers = [a / 4, b / 4, c / 4];
    const symbols = spinSymbols(() => numbers.shift());
    assert.deepEqual(symbols, [SYMBOLS[a].id, SYMBOLS[b].id, SYMBOLS[c].id]);
    assert.equal(isWin(symbols), a === b && b === c);
    if (isWin(symbols)) wins++;
  }
  assert.equal(wins, 4);
  assert.equal(isWin(["fake", "fake", "fake"]), false);
  assert.equal(isWin(["cherry", "cherry"]), false);
});

test("Одна начальная попытка плюс указанное число перебросов", () => {
  const users = [{ id: "gm", isGM: true }, { id: "player", character: { id: "actor" } }];
  assert.equal(createRound("r", 0, users).total, 1);
  assert.equal(createRound("r", 3, users).total, 4);
  assert.equal(createRound("r", 100, users).total, 101);
  assert.equal(createRound("r", 0, users).entries.gm, undefined);
  for (const v of [-1, 101, 0.5, "3", NaN, Infinity]) assert.throws(() => validateRerolls(v));
});

test("Начисление учитывает максимум, в том числе нулевой и изменённый системой", () => {
  assert.deepEqual(heroAward({ value: 2, max: 3 }), { value: 3, awarded: 1, capped: false });
  assert.deepEqual(heroAward({ value: 3, max: 3 }), { value: 3, awarded: 0, capped: true });
  assert.deepEqual(heroAward({ value: 0, max: 0 }), { value: 0, awarded: 0, capped: true });
  assert.deepEqual(heroAward({ value: 3, max: 5 }), { value: 4, awarded: 1, capped: false });
  assert.equal(heroAward({ value: 4, max: 3 }).value, 4);
  assert.throws(() => heroAward({ value: 2 }));
});
