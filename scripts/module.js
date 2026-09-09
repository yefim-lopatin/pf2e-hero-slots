import { MODULE_ID, validateRerolls } from "./rules.js";
import { SlotsSession } from "./session.js";
import { SlotsApplication } from "./app.js";

const CHANNEL = `module.${MODULE_ID}`;
let controller;

class SlotsController {
  constructor() {
    this.application = null;
    this.pending = new Map();
    this.openedRound = null;
    this.session = new SlotsSession({
      isAuthority: () => game.user.isGM && game.users.activeGM?.id === game.user.id,
      users: () => game.users.contents,
      state: () => this.state,
      save: state => game.settings.set(MODULE_ID, "round", state),
      id: () => foundry.utils.randomID(), now: () => Date.now(),
      random: () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296,
      actor: id => game.actors.get(id),
      owns: (actor, user) => actor.testUserPermission(user, "OWNER")
    });
    game.socket.on(CHANNEL, (message, senderId) => this.onSocket(message, senderId));
  }

  get state() { return game.settings.get(MODULE_ID, "round"); }

  open() {
    if (!game.user.isGM && !this.state?.active) {
      ui.notifications.info("Розыгрыш ещё не запущен. Его начинает ГМ.");
      return null;
    }
    this.application ??= new SlotsApplication(this);
    const application = this.application;
    application.render({ force: true }).then(() => {
      if (application.rendered) application.bringToFront();
    }).catch(error => ui.notifications.error(`Слот-машина: ${error.message}`));
    return this.application;
  }

  refresh() {
    const state = this.state;
    if (state?.active && state.id !== this.openedRound) {
      this.openedRound = state.id;
      this.open();
    } else if (this.application?.rendered) {
      this.application.render().catch(error => console.error(MODULE_ID, error));
    }
    ui.controls?.render({ force: true });
  }

  async request(action, payload = {}) {
    const gm = game.users.activeGM;
    if (!gm) throw new Error("ГМ не подключён. Попытка не потрачена.");
    const request = { action, ...payload };
    if (gm.id === game.user.id) return this.session.handle(game.user.id, request);
    const rpcId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new Error("ГМ не ответил. Проверь результат в окне: повторное открытие не расходует попытку."));
      }, 15000);
      this.pending.set(rpcId, { resolve, reject, timer, gmId: gm.id });
      game.socket.emit(CHANNEL, { kind: "request", rpcId, request }, { recipients: [gm.id] });
    });
  }

  async onSocket(message, senderId) {
    if (!message || typeof senderId !== "string") return;
    if (message.kind === "response") {
      const pending = this.pending.get(message.rpcId);
      if (!pending || senderId !== pending.gmId || !game.users.get(senderId)?.isGM) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.rpcId);
      message.ok ? pending.resolve() : pending.reject(new Error(message.error || "Не удалось обработать попытку."));
      return;
    }
    if (message.kind !== "request" || game.users.activeGM?.id !== game.user.id || !game.user.isGM) return;
    if (typeof message.rpcId !== "string" || message.rpcId.length > 80) return;
    let response;
    try {
      await this.session.handle(senderId, message.request);
      response = { kind: "response", rpcId: message.rpcId, ok: true };
    } catch (error) {
      response = { kind: "response", rpcId: message.rpcId, ok: false, error: error.message };
    }
    game.socket.emit(CHANNEL, response, { recipients: [senderId] });
  }

  start(rerolls = game.settings.get(MODULE_ID, "rerolls")) {
    if (!game.user.isGM) return Promise.reject(new Error("Запустить розыгрыш может только ГМ."));
    validateRerolls(rerolls);
    return this.request("start", { rerolls });
  }

  end() {
    if (!game.user.isGM) return Promise.reject(new Error("Завершить розыгрыш может только ГМ."));
    return this.request("end", { roundId: this.state?.id });
  }

  spin() {
    const state = this.state;
    return this.request("spin", {
      roundId: state?.id, expectedUsed: state?.entries?.[game.user.id]?.used,
      requestId: foundry.utils.randomID()
    });
  }

  recover() { return this.request("recover"); }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "round", {
    scope: "world", config: false, type: Object, default: null, onChange: () => controller?.refresh()
  });
  game.settings.register(MODULE_ID, "rerolls", {
    name: "Дополнительные перебросы", hint: "К одной начальной попытке добавляется указанное число перебросов. Применяется к следующему розыгрышу.",
    scope: "world", config: true, type: Number, default: 0, range: { min: 0, max: 100, step: 1 }
  });
});

Hooks.on("getSceneControlButtons", controls => {
  controls[MODULE_ID] = {
    name: MODULE_ID, title: "Героическая слот-машина", icon: "fa-solid fa-dice", order: 98,
    onChange: (_event, active) => { if (active) controller?.open(); },
    tools: { open: { name: "open", title: game.user.isGM ? "Управлять розыгрышем" : "Открыть слот-машину", icon: "fa-solid fa-dice", button: true, order: 0, onChange: () => controller?.open() } }
  };
});

Hooks.on("renderSettings", (_app, element) => {
  if (!game.user.isGM) return;
  const root = element instanceof HTMLElement ? element : element[0];
  if (!root || root.querySelector(".hero-slots-settings-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hero-slots-settings-button";
  button.innerHTML = '<i class="fa-solid fa-dice" aria-hidden="true"></i> Героическая слот-машина';
  button.addEventListener("click", () => controller?.open());
  (root.querySelector("#game-settings") ?? root).append(button);
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    if (game.user.isGM) ui.notifications.error("Героическая слот-машина работает только с PF2e.");
    return;
  }
  controller = new SlotsController();
  game.modules.get(MODULE_ID).api = Object.freeze({
    open: () => controller.open(), start: rerolls => controller.start(rerolls),
    end: () => controller.end(), recover: () => controller.recover()
  });
  controller.refresh();
  const recover = () => {
    controller.refresh();
    if (game.user.isGM && game.users.activeGM?.id === game.user.id) {
      controller.recover().catch(error => ui.notifications.error(`Слот-машина: ${error.message}`));
    }
  };
  Hooks.on("userConnected", recover);
  Hooks.on("updateUser", () => controller.refresh());
  Hooks.on("updateActor", actor => {
    if (Object.values(controller.state?.entries ?? {}).some(e => e.actorId === actor.id)) controller.refresh();
  });
  recover();
});
