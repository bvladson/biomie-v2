/** FlightPlanApi ligado às funções de servidor do BIOMIE (as regras são aplicadas no banco). */
import type { Company, FlightPlanApi, Me } from "./contract";
import * as fn from "@/lib/flight-plan-v2.functions";

const CODED = /^fp::([\s\S]+)$/;
const GENERIC = "Não foi possível carregar o Plano de Voo. Tente de novo.";

/** O servidor manda "fp::mensagem"; qualquer outra falha (rede, sessão) vira a mensagem genérica. */
export function toFlightPlanError(error: unknown): Error {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  const coded = CODED.exec(message);
  return new Error(coded ? coded[1]! : GENERIC);
}

function guarded<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await call(...args);
    } catch (error) {
      throw toFlightPlanError(error);
    }
  };
}

/** Contexto do usuário numa leitura só. Sem cache aqui: este módulo também roda no servidor. */
export const bootstrap = guarded(() => fn.fpBootstrap());

export const serverFlightPlanApi: FlightPlanApi = {
  me: async () => (await bootstrap()).me,
  listCompanies: async () => (await bootstrap()).companies,
  listSellers: guarded((companyId) => fn.fpListSellers({ data: { companyId } })),
  getPlan: guarded((q) => fn.fpGetPlan({ data: q })),
  getSnapshots: guarded((q) => fn.fpGetSnapshots({ data: q })),
  setCommit: guarded((q, amount, note) =>
    fn.fpSetCommit({ data: { query: q, amount, note } }).then(() => undefined),
  ),
  getTargets: guarded((companyId, month) => fn.fpGetTargets({ data: { companyId, month } })),
  previewTargets: guarded((companyId, month, changes) =>
    fn.fpPreviewTargets({ data: { companyId, month, changes } }),
  ),
  saveTargets: guarded((companyId, month, changes) =>
    fn.fpSaveTargets({ data: { companyId, month, changes } }),
  ),
  getYear: guarded((companyId, year, channel, sellerId) =>
    fn.fpGetYear({
      data: { companyId, year, ...(channel ? { channel } : {}), ...(sellerId ? { sellerId } : {}) },
    }),
  ),
  listInitiatives: guarded((q) => fn.fpListInitiatives({ data: q })),
  saveInitiative: guarded((input) => fn.fpSaveInitiative({ data: input })),
  setInitiativeStatus: guarded((id, status, realizedAmount, note) =>
    fn.fpSetInitiativeStatus({ data: { id, status, realizedAmount, note } }),
  ),
  getTargetLists: guarded((q) => fn.fpGetTargetLists({ data: q })),
  listAlerts: guarded((q) => fn.fpListAlerts({ data: q })),
  setAlertState: guarded((key, state, note, initiativeId, query) =>
    fn.fpSetAlertState({
      data: {
        key,
        state,
        note,
        ...(initiativeId ? { initiativeId } : {}),
        ...(query ? { query } : {}),
      },
    }),
  ),
  getWeeklyReview: guarded((q, weekStart) =>
    fn.fpGetWeeklyReview({ data: { query: q, weekStart } }),
  ),
  addDecision: guarded((q, weekStart, text) =>
    fn.fpAddDecision({ data: { query: q, weekStart, text } }).then(() => undefined),
  ),
  listHistory: guarded((companyId, area) =>
    fn.fpListHistory({ data: { companyId, ...(area ? { area } : {}) } }),
  ),
};
