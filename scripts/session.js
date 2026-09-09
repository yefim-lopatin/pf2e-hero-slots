import { MODULE_ID, createRound, spinSymbols, isWin, heroAward, validateRerolls } from "./rules.js";

// Only the elected GM mutates the round. The sender ID comes from Foundry's
// authenticated socket envelope, never from fields supplied by a player.
export class SlotsSession {
  constructor(env) {
    this.env = env;
    this.queue = Promise.resolve();
  }

  handle(senderId, request) {
    const work = this.queue.then(() => this._handle(senderId, request));
    this.queue = work.catch(() => {});
    return work;
  }

  assertAuthority() {
    if (!this.env.isAuthority()) throw new Error("Дождитесь подключения ведущего ГМ.");
  }

  async save(state) {
    this.assertAuthority();
    await this.env.save(structuredClone(state));
  }

  async _handle(senderId, request) {
    this.assertAuthority();
    const user = this.env.users().find(u => u.id === senderId);
    if (!user?.active) throw new Error("Игрок не подключён.");
    if (!request || !["start", "end", "spin", "recover"].includes(request.action)) throw new Error("Неизвестное действие.");
    if (request.action !== "spin" && !user.isGM) throw new Error("Только ГМ может управлять розыгрышем.");
    let state = structuredClone(this.env.state());
    if (state) await this.recover(state);
    this.assertAuthority();

    if (request.action === "recover") return state;
    if (request.action === "start") {
      if (state?.active) throw new Error("Сначала завершите текущий розыгрыш.");
      validateRerolls(request.rerolls);
      state = createRound(this.env.id(), request.rerolls, this.env.users());
      await this.save(state);
      return state;
    }
    if (!state || request.roundId !== state.id) throw new Error("Этот розыгрыш уже закончился. Откройте текущее окно.");
    if (request.action === "end") {
      state.active = false;
      await this.save(state);
      return state;
    }
    if (user.isGM) throw new Error("ГМ управляет розыгрышем; крутить барабаны могут игроки.");
    const entry = state.entries[user.id];
    if (!entry) throw new Error("Вы не участвуете в этом розыгрыше. Попросите ГМ начать новый.");
    if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(request.requestId)) throw new Error("Некорректный номер запроса.");
    if (entry.last?.requestId === request.requestId) return state;
    if (!state.active) throw new Error("ГМ завершил розыгрыш.");
    if (!Number.isInteger(request.expectedUsed) || request.expectedUsed !== entry.used) throw new Error("Результат уже изменился. Дождитесь обновления окна.");
    if (entry.used >= state.total) throw new Error("Все попытки использованы.");
    const actor = this.env.actor(entry.actorId);
    if (!actor || actor.type !== "character" || user.character?.id !== actor.id || !this.env.owns(actor, user)) {
      throw new Error("ГМ должен назначить вам персонажа PF2e с правом владельца и начать новый розыгрыш.");
    }
    heroAward(actor.system.resources?.heroPoints);
    const symbols = spinSymbols(this.env.random);
    entry.used += 1;
    entry.last = {
      requestId: request.requestId, symbols, win: isWin(symbols), status: "pending",
      awarded: 0, capped: false, at: this.env.now()
    };
    // Persist the consumed attempt and the actual outcome before touching the actor.
    // Recovery can replay this transaction, but cannot draw another outcome.
    await this.save(state);
    await this.settle(state, entry);
    return state;
  }

  async recover(state) {
    for (const entry of Object.values(state.entries)) {
      if (entry.last?.status === "pending") await this.settle(state, entry);
    }
  }

  async settle(state, entry) {
    this.assertAuthority();
    const result = entry.last;
    if (result.status !== "pending") return;
    if (result.win) {
      const actor = this.env.actor(entry.actorId);
      if (!actor) {
        result.note = "Персонаж удалён: очко не начислено.";
      } else {
        const receipt = actor.getFlag(MODULE_ID, "lastAward");
        if (receipt?.roundId === state.id && receipt.requestId === result.requestId) {
          result.awarded = receipt.awarded;
          result.capped = receipt.capped;
        } else {
          const award = heroAward(actor.system.resources?.heroPoints);
          this.assertAuthority();
          // PF2e resource and receipt are written in the SAME Actor update.
          // If saving the round fails afterwards, recovery will not award twice.
          await actor.update({
            ...(award.awarded ? { "system.resources.heroPoints.value": award.value } : {}),
            [`flags.${MODULE_ID}.lastAward`]: {
              roundId: state.id, requestId: result.requestId, awarded: award.awarded, capped: award.capped
            }
          });
          result.awarded = award.awarded;
          result.capped = award.capped;
        }
      }
      entry.wins += 1;
      entry.awarded += result.awarded;
    }
    result.status = "complete";
    await this.save(state);
  }
}
