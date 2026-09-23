import test from "node:test";
import assert from "node:assert/strict";
import { SlotsSession } from "../scripts/session.js";

function fixture() {
  let state = null, counter = 0, random = () => 0, authority = true, failSave = 0, saves = 0, failActor = false;
  const actors = new Map();
  const actor = { id: "hero", type: "character", system: { resources: { heroPoints: { value: 0, max: 3 } } },
    receipt: null, updates: 0,
    getFlag() { return this.receipt; },
    async update(data) {
      if (failActor) throw new Error("actor write failed");
      this.updates++;
      if ("system.resources.heroPoints.value" in data) this.system.resources.heroPoints.value = data["system.resources.heroPoints.value"];
      this.receipt = data["flags.pf2e-hero-slots.lastAward"];
    }
  };
  actors.set(actor.id, actor);
  const users = [{ id: "gm", isGM: true, active: true }, { id: "p1", active: true, character: actor }, { id: "p2", active: true, character: actor }];
  const env = {
    isAuthority: () => authority, users: () => users, state: () => state,
    save: async s => { if (++saves === failSave) throw new Error("state write failed"); state = structuredClone(s); },
    id: () => `round${++counter}`, now: () => 123, random: () => random(),
    actor: id => actors.get(id), owns: () => true
  };
  let session = new SlotsSession(env);
  const f = {
    actor, users, actors, env, get state() { return state; }, get session() { return session; },
    start: n => session.handle("gm", { action: "start", rerolls: n }),
    spin: (user = "p1", requestId = `request${++counter}`, expectedUsed = state.entries[user].used) => session.handle(user, { action: "spin", roundId: state.id, requestId, expectedUsed }),
    reconnect: () => { session = new SlotsSession(env); },
    random: fn => { random = fn; },
    failNextSave: (after = 1) => { failSave = saves + after; },
    failActor: value => { failActor = value; },
    authority: value => { authority = value; }
  };
  return f;
}

test("Игрок не может запустить, завершить или восстановить розыгрыш; ГМ не играет", async () => {
  const f = fixture();
  for (const action of ["start", "end", "recover"]) await assert.rejects(f.session.handle("p1", { action, rerolls: 2 }), /Только ГМ/);
  await f.start(1);
  await assert.rejects(f.session.handle("gm", { action: "spin", roundId: f.state.id }), /крутить барабаны могут игроки/);
  f.authority(false);
  await assert.rejects(f.spin(), /ведущего ГМ/);
});

test("Повторные выигрыши разрешены, максимум соблюдается, лишняя попытка запрещена", async () => {
  const f = fixture();
  await f.start(3);
  for (let i = 0; i < 4; i++) await f.spin();
  assert.equal(f.state.entries.p1.used, 4);
  assert.equal(f.state.entries.p1.wins, 4);
  assert.equal(f.state.entries.p1.awarded, 3);
  assert.equal(f.actor.system.resources.heroPoints.value, 3);
  assert.equal(f.state.entries.p1.last.capped, true);
  await assert.rejects(f.spin(), /Все попытки/);
});

test("Параллельный двойной щелчок и повтор RPC не расходуют две попытки", async () => {
  const f = fixture(); await f.start(3);
  const outcomes = await Promise.allSettled([f.spin("p1", "requestA1", 0), f.spin("p1", "requestA2", 0)]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.state.entries.p1.used, 1);
  await f.spin("p1", "requestA1", 0);
  assert.equal(f.actor.updates, 1);
  assert.equal(f.state.entries.p1.used, 1);
});

test("Разные игроки и общий персонаж обрабатываются последовательно без потери очков", async () => {
  const f = fixture(); await f.start(0);
  await Promise.all([f.spin("p1"), f.spin("p2")]);
  assert.equal(f.actor.system.resources.heroPoints.value, 2);
  assert.equal(f.state.entries.p1.used, 1);
  assert.equal(f.state.entries.p2.used, 1);
});

test("Проигрыш расходует попытку без изменения персонажа; переподключение сохраняет остаток", async () => {
  const f = fixture(); let i = 0; f.random(() => (i++ % 4) / 4); await f.start(1);
  await f.spin(); f.reconnect(); await f.spin();
  assert.equal(f.state.entries.p1.used, 2);
  assert.equal(f.actor.updates, 0);
  await assert.rejects(f.spin(), /Все попытки/);
});

test("Нет персонажа, владения или активного игрока — попытка не расходуется", async () => {
  const f = fixture(); await f.start(1);
  f.users[1].character = null;
  await assert.rejects(f.spin(), /назначить/);
  f.users[1].character = f.actor; f.env.owns = () => false;
  await assert.rejects(f.spin(), /назначить/);
  f.env.owns = () => true; f.users[1].active = false;
  await assert.rejects(f.spin(), /не подключён/);
  assert.equal(f.state.entries.p1.used, 0);
});

test("Неуспешная запись очка восстанавливается с тем же исходом, а не новым броском", async () => {
  const f = fixture(); await f.start(1); f.failActor(true);
  await assert.rejects(f.spin("p1", "recovery01"), /actor write failed/);
  assert.equal(f.state.entries.p1.last.status, "pending");
  f.failActor(false); f.random(() => { throw new Error("Нельзя перебрасывать сохранённый результат"); }); f.reconnect();
  await f.session.handle("gm", { action: "recover" });
  assert.equal(f.actor.system.resources.heroPoints.value, 1);
  assert.equal(f.state.entries.p1.used, 1);
  assert.equal(f.state.entries.p1.last.status, "complete");
});

test("Сбой между записью очка и сохранением розыгрыша не начисляет очко дважды", async () => {
  const f = fixture(); await f.start(1); f.failNextSave(2);
  await assert.rejects(f.spin("p1", "recovery02"), /state write failed/);
  assert.equal(f.actor.system.resources.heroPoints.value, 1);
  assert.equal(f.state.entries.p1.last.status, "pending");
  f.reconnect(); await f.spin("p1", "recovery02", 0);
  assert.equal(f.actor.updates, 1);
  assert.equal(f.state.entries.p1.wins, 1);
  assert.equal(f.state.entries.p1.awarded, 1);
});

test("Сбой до сохранения попытки не меняет персонажа", async () => {
  const f = fixture(); await f.start(0); f.failNextSave();
  await assert.rejects(f.spin(), /state write failed/);
  assert.equal(f.actor.updates, 0);
  assert.equal(f.state.entries.p1.used, 0);
});

test("Активный розыгрыш нельзя перезапустить; старый запрос не действует в новом", async () => {
  const f = fixture(); await f.start(0); const id = f.state.id;
  await assert.rejects(f.start(1), /Сначала завершите/);
  await f.session.handle("gm", { action: "end", roundId: id });
  await assert.rejects(f.spin(), /завершил/);
  await f.start(1);
  await assert.rejects(f.session.handle("p1", { action: "spin", roundId: id, requestId: "oldrequest", expectedUsed: 0 }), /уже закончился/);
  assert.equal(f.state.entries.p1.used, 0);
});


test("Доступ запрещает вращение и заявку; только ГМ меняет настройки", async () => {
  const f = fixture();
  let config = { allowedIds: null, enabled: false, prices: [] };
  f.env.config = () => config;
  f.env.saveConfig = async value => { config = value; };
  const request = { action: "configure", config: { allowedIds: ["p1"], enabled: true, prices: [{ label: "10 урона", attempts: 3 }] } };
  await assert.rejects(f.session.handle("p1", request), /Только ГМ/);
  await f.session.handle("gm", request);
  await f.start(0);
  await assert.rejects(f.spin("p2"), /запретил/);
  await assert.rejects(f.session.handle("p2", { action: "purchase", roundId: f.state.id, priceId: config.prices[0].id }), /не разрешено/);
  assert.equal(f.state.entries.p2.used, 0);
});

test("Цена сохраняется в заявке, решение только ГМ, начисление ровно один раз", async () => {
  const f = fixture();
  const config = { allowedIds: ["p1", "p2"], enabled: true, prices: [{ id: "price", label: "Получить 10 ментального урона", attempts: 3 }] };
  f.env.config = () => config;
  await f.start(0);
  const request = { action: "purchase", roundId: f.state.id, priceId: "price", attempts: 99 };
  await f.session.handle("p1", request);
  assert.equal(f.state.entries.p1.bonus, undefined);
  assert.equal(f.state.purchases[0].attempts, 3);
  await assert.rejects(f.session.handle("p1", request), /Дождитесь/);
  config.prices[0].attempts = 8;
  const decision = { action: "decide", roundId: f.state.id, purchaseId: f.state.purchases[0].id, approve: true };
  await assert.rejects(f.session.handle("p1", decision), /Только ГМ/);
  await Promise.all([f.session.handle("gm", decision), f.session.handle("gm", decision)]);
  assert.equal(f.state.entries.p1.bonus, 3);
  assert.equal(f.state.entries.p2.bonus, undefined);
  for (let i = 0; i < 4; i++) await f.spin();
  await assert.rejects(f.spin(), /Все попытки/);
  await f.session.handle("p1", request);
  const rejected = { ...decision, purchaseId: f.state.purchases[1].id, approve: false };
  await f.session.handle("gm", rejected);
  assert.equal(f.state.entries.p1.bonus, 3);
  await f.session.handle("gm", { ...rejected, approve: true });
  assert.equal(f.state.entries.p1.bonus, 3);
});

test("Закрытый розыгрыш и запрет доступа блокируют одобрение; сбой чата не дублирует начисление", async () => {
  const f = fixture();
  const config = { allowedIds: ["p1"], enabled: true, prices: [{ id: "price", label: "Цена", attempts: 2 }] };
  f.env.config = () => config;
  await f.start(0);
  await f.session.handle("p1", { action: "purchase", roundId: f.state.id, priceId: "price" });
  const decision = { action: "decide", roundId: f.state.id, purchaseId: f.state.purchases[0].id, approve: true };
  config.allowedIds = [];
  await assert.rejects(f.session.handle("gm", decision), /Сначала разрешите/);
  config.allowedIds = ["p1"];
  f.env.publish = async state => { if (state.purchases?.[0].status === "approved") throw new Error("chat failed"); };
  await assert.rejects(f.session.handle("gm", decision), /chat failed/);
  assert.equal(f.state.entries.p1.bonus, 2);
  f.env.publish = async () => {};
  f.reconnect();
  await f.session.handle("gm", decision);
  assert.equal(f.state.entries.p1.bonus, 2);
  await f.session.handle("gm", { action: "end", roundId: f.state.id });
  await assert.rejects(f.session.handle("gm", decision), /завершил/);
});
