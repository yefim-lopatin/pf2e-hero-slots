import { MODULE_ID, SYMBOLS } from "./rules.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const glyphs = ids => ids.map(id => SYMBOLS.find(s => s.id === id) ?? SYMBOLS[0]);

export class SlotsApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-window`, classes: ["hero-slots"],
    window: { title: "Героическая слот-машина", resizable: false },
    position: { width: 500, height: "auto" }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/slots.hbs` } };

  constructor(controller, options = {}) {
    super(options);
    this.controller = controller;
    this.busy = false;
    this.error = "";
  }

  async _prepareContext() {
    const state = this.controller.state;
    const entry = state?.entries?.[game.user.id];
    const result = entry?.last;
    const actor = game.actors.get(entry?.actorId);
    const isGM = game.user.isGM;
    const hasGM = Boolean(game.users.activeGM);
    const pending = result?.status === "pending";
    const remaining = entry && state ? Math.max(0, state.total - entry.used) : 0;
    const validActor = actor?.type === "character" && game.user.character?.id === actor.id &&
      actor.testUserPermission(game.user, "OWNER");
    let headline = "Три одинаковых — одно героическое очко";
    let detail = "Нажми на кнопку, чтобы запустить барабаны.";
    if (!state?.active) { headline = "Розыгрыш завершён"; detail = "Следующий розыгрыш начнёт ГМ."; }
    else if (!entry && !isGM) { headline = "Ты пока не участвуешь"; detail = "Попроси ГМ начать новый розыгрыш."; }
    else if (!validActor && !isGM) { headline = "Нужен назначенный персонаж"; detail = "ГМ должен назначить тебе персонажа с правом владельца и начать новый розыгрыш."; }
    else if (result?.status === "complete") {
      headline = result.win ? "Три в ряд!" : "В этот раз не совпало";
      detail = result.note || (result.awarded ? "+1 героическое очко персонажу" : result.capped
        ? "Героические очки уже на максимуме." : remaining ? "Остались попытки — можно попробовать ещё." : "Все попытки использованы.");
    }
    if (this.busy || pending) { headline = this.busy ? "Пусть повезёт…" : "ГМ сохраняет результат…"; detail = "Повторно нажимать не нужно."; }
    if (!hasGM) { headline = "Ожидаем ГМ"; detail = "Продолжить можно, когда ведущий подключится."; }
    return {
      isGM, state, active: Boolean(state?.active), hasGM, busy: this.busy, error: this.error,
      actorName: actor?.name ?? "Персонаж не назначен", remaining, total: state?.total ?? 0,
      awarded: entry?.awarded ?? 0, heroValue: actor?.system.resources?.heroPoints?.value ?? "—",
      heroMax: actor?.system.resources?.heroPoints?.max ?? "—", headline, detail,
      resultWin: !this.busy && result?.status === "complete" && result.win,
      reels: glyphs(!this.busy && result?.status === "complete" ? result.symbols : ["cherry", "lemon", "seven"]),
      strip: [...SYMBOLS, ...SYMBOLS],
      canSpin: Boolean(state?.active && entry && validActor && remaining && !this.busy && !pending && hasGM),
      spinLabel: this.busy ? "Барабаны вращаются…" : remaining === 0 && entry ? "Попытки закончились" : entry?.used ? "Крутить ещё" : "Испытать удачу",
      rerolls: state?.active ? state.rerolls : game.settings.get(MODULE_ID, "rerolls"),
      hasPending: Object.values(state?.entries ?? {}).some(e => e.last?.status === "pending"),
      roster: Object.values(state?.entries ?? {}).map(e => {
        const u = game.users.get(e.userId);
        const a = game.actors.get(e.actorId);
        return {
          name: u?.name ?? "Удалённый игрок", actor: a?.name ?? "Не назначен персонаж",
          online: Boolean(u?.active), used: e.used, total: state.total, awarded: e.awarded,
          result: e.last?.status === "complete" ? glyphs(e.last.symbols).map(s => s.glyph).join(" ") : e.last ? "Сохранение…" : "Ожидает попытку"
        };
      })
    };
  }

  _onRender() {
    this.element.querySelector("[data-slot-action='spin']")?.addEventListener("click", () => this.spin());
    this.element.querySelector("[data-slot-action='start']")?.addEventListener("click", () => this.run(async () => {
      const input = this.element.querySelector("[name='rerolls']");
      if (!input.reportValidity()) return;
      const rerolls = Number(input.value);
      await this.controller.start(rerolls);
      await game.settings.set(MODULE_ID, "rerolls", rerolls);
    }));
    this.element.querySelector("[data-slot-action='end']")?.addEventListener("click", () => this.run(() => this.controller.end()));
    this.element.querySelector("[data-slot-action='recover']")?.addEventListener("click", () => this.run(() => this.controller.recover()));
  }

  async run(action) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try { await action(); }
    catch (error) { this.error = error.message; }
    finally { this.busy = false; if (this.rendered) await this.render(); }
  }

  async spin() {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    await this.render();
    // The animation only presents the result. Randomness is evaluated once by GM.
    const delay = new Promise(resolve => setTimeout(resolve, matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 1800));
    try { await Promise.all([this.controller.spin(), delay]); }
    catch (error) { this.error = error.message; await delay; }
    finally { this.busy = false; if (this.rendered) await this.render(); }
  }
}
