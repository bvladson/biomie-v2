import type {
  StockApi,
  StockCapabilities,
  StockPosition,
  CompanyFilter,
  PositionQuery,
  SavedScenario,
  Curve,
  StockApiError,
} from "../api/contract";
import { ALL_CURVES, belowMin, hasStock, summarize, validateScenario } from "../lib/simulation";
import { positionsCsv, simulationCsv } from "../lib/export";
export const COMPANIES = [
  { id: "uni", name: "UNI DESIGN" },
  { id: "filial", name: "MAG FILIAL" },
  { id: "matriz", name: "MAGAZINE DOS MOVEIS - MATRIZ" },
  { id: "ergo", name: "ERGO OFFICE" },
  { id: "expert", name: "EXPERT SERVICOS" },
];
export type MockRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "DIRETORIA"
  | "GESTOR"
  | "FINANCEIRO"
  | "ANALISTA"
  | "VENDEDOR"
  | "VIEWER";
export type MockState = "normal" | "empty" | "error" | "stale";
const roles: Record<MockRole, StockCapabilities> = {
  SUPER_ADMIN: { viewCost: true, classify: true, saveScenarios: true, export: true, refresh: true },
  ADMIN: { viewCost: true, classify: true, saveScenarios: true, export: true, refresh: true },
  DIRETORIA: { viewCost: true, classify: true, saveScenarios: true, export: true, refresh: false },
  GESTOR: { viewCost: true, classify: true, saveScenarios: true, export: false, refresh: false },
  FINANCEIRO: {
    viewCost: true,
    classify: false,
    saveScenarios: true,
    export: true,
    refresh: false,
  },
  ANALISTA: {
    viewCost: true,
    classify: false,
    saveScenarios: false,
    export: false,
    refresh: false,
  },
  VENDEDOR: {
    viewCost: false,
    classify: false,
    saveScenarios: false,
    export: false,
    refresh: false,
  },
  VIEWER: { viewCost: false, classify: false, saveScenarios: false, export: false, refresh: false },
};
const names = [
  "Cadeira York presidente",
  "Armário baixo 2 portas",
  "Mesa de trabalho 120 cm",
  "Cadeira Roma",
  "Gaveteiro 3 gavetas",
  "Mesa de reunião 200 cm",
  "Cadeira Light",
  "Estante semiaberta",
  "Mesa executiva 30 mm",
  "Cadeira importada — linha anterior",
  "Mesa de trabalho 140 cm",
  "Nicho com porta",
];
export function makePositions(count = 300): StockPosition[] {
  return Array.from({ length: count }, (_, i) => {
    const company = COMPANIES[Math.floor(i / 60) % 5] ?? COMPANIES[0];
    if (!company) throw new Error("Empresa demo ausente");
    const n = i % 60,
      product = Math.floor(n / 3),
      cost = 120 + product * 23.5;
    const qty = n === 2 ? -3.5 : 12 + ((n * 13) % 150) + (n % 7 === 0 ? 0.5 : 0);
    return {
      id: `${company.id}-p${product}-l${n % 3}-${Math.floor(i / 300)}`,
      companyId: company.id,
      companyName: company.name,
      productId: `${company.id}-p${product}`,
      omieProductId: String(10000 + product),
      sku: `MAG-${String(product + 1).padStart(3, "0")}`,
      name: `${names[product % names.length]}${product >= 12 ? " · Linha Plus" : ""}`,
      family: product % 3 === 0 ? "Cadeiras" : product % 3 === 1 ? "Armazenamento" : "Mesas",
      locationCode: `L${n % 3}`,
      locationName: ["Depósito central", "Showroom", "Expedição"][n % 3] ?? null,
      curve: ALL_CURVES[product % 5] ?? "U",
      physicalQty: qty,
      reservedQty: n % 9,
      pendingQty: n % 13,
      unitCost: cost,
      costValue: qty * cost,
      salePrice: product === 3 ? 0 : Math.round(cost * 1.85 * 100) / 100,
      minQty: n % 10 === 0 ? 40 : null,
    };
  });
}
function fail(code: StockApiError["code"], message: string): never {
  throw { code, message } satisfies StockApiError;
}
export function createMockApi(initialRole: MockRole = "SUPER_ADMIN", count = 300, latency = 280) {
  let role = initialRole,
    state: MockState = "normal";
  const positions = makePositions(count);
  let scenarios: SavedScenario[] = [];
  const refreshes = new Map<string, number>();
  const allowed = () => {
    if (role === "VIEWER") fail("forbidden", "Seu perfil não tem acesso ao Estoque.");
  };
  const gate = async () => {
    await new Promise((resolve) => setTimeout(resolve, latency));
    allowed();
    if (state === "error")
      fail("unavailable", "A leitura do estoque não está disponível. Tente de novo.");
  };
  const scope = (company: CompanyFilter) => {
    if (company !== "all" && !COMPANIES.some((c) => c.id === company))
      fail("forbidden", "Empresa fora do seu acesso.");
    return state === "empty"
      ? []
      : positions.filter((p) => company === "all" || p.companyId === company);
  };
  const redact = (p: StockPosition): StockPosition =>
    roles[role].viewCost ? { ...p } : { ...p, unitCost: null, costValue: null, salePrice: null };
  const filtered = (q: Omit<PositionQuery, "page">) => {
    let rows = scope(q.companyId).filter(
      (p) =>
        (!q.search || `${p.name} ${p.sku}`.toLowerCase().includes(q.search.toLowerCase())) &&
        (!q.curve || q.curve === "all" || p.curve === q.curve) &&
        (!q.locationCode || p.locationCode === q.locationCode) &&
        (!q.family || p.family === q.family) &&
        (!q.onlyNegative || p.physicalQty < 0) &&
        (!q.hideZero || hasStock(p)) &&
        (!q.belowMin || belowMin(p)) &&
        (!q.productId || p.productId === q.productId),
    );
    const key =
      q.sortBy === "costValue" && !roles[role].viewCost ? "name" : (q.sortBy ?? "costValue");
    rows = [...rows].sort((a, b) => {
      const av = a[key] ?? 0,
        bv = b[key] ?? 0;
      const v =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv, "pt-BR")
          : Number(av) - Number(bv);
      return q.sortDir === "asc" ? v : -v;
    });
    return rows;
  };
  const readAt = () =>
    new Date(Date.now() - (state === "stale" ? 8 * 3600000 : 25 * 60000)).toISOString();
  const api: StockApi = {
    async capabilities() {
      await gate();
      return { ...roles[role] };
    },
    async overview(companyId) {
      await gate();
      const rows = scope(companyId);
      return {
        ...summarize(rows, roles[role].viewCost),
        readings: COMPANIES.filter((c) => companyId === "all" || c.id === companyId).map((c) => ({
          companyId: c.id,
          companyName: c.name,
          readAt: state === "empty" ? null : readAt(),
          positions: rows.filter((p) => p.companyId === c.id).length,
          status: state === "empty" ? "missing" : state === "stale" ? "stale" : "ok",
          inProgress: false,
          lastError: null,
        })),
      };
    },
    async positions(q) {
      await gate();
      if (!Number.isInteger(q.page) || q.page < 0) fail("invalid", "Página inválida.");
      const rows = filtered(q);
      return { rows: rows.slice(q.page * 100, (q.page + 1) * 100).map(redact), total: rows.length };
    },
    async filterOptions(companyId) {
      await gate();
      const rows = scope(companyId);
      return {
        locations: [...new Set(rows.map((p) => p.locationCode))].map((code) => ({
          code,
          name: rows.find((p) => p.locationCode === code)?.locationName ?? null,
        })),
        families: [...new Set(rows.flatMap((p) => (p.family ? [p.family] : [])))],
      };
    },
    async setCurve({ positionIds, curve }) {
      await gate();
      if (!roles[role].classify) fail("forbidden", "Você não pode classificar curvas.");
      if (
        !ALL_CURVES.includes(curve) ||
        positionIds.length === 0 ||
        positionIds.some((id) => !positions.some((p) => p.id === id))
      )
        fail("invalid", "Selecione posições válidas e uma curva.");
      const selected = positions.filter((p) => positionIds.includes(p.id));
      const keys = new Set(selected.map((p) => `${p.companyId}:${p.omieProductId}`));
      let updated = 0;
      positions.forEach((p) => {
        if (keys.has(`${p.companyId}:${p.omieProductId}`)) {
          p.curve = curve;
          updated++;
        }
      });
      return { updated };
    },
    async simulationBase(companyId) {
      await gate();
      if (!roles[role].viewCost)
        fail("forbidden", "Seu perfil pode ver quantidades, mas não custos ou simulações.");
      return {
        items: scope(companyId).map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          curve: p.curve,
          qty: p.physicalQty,
          cost: p.unitCost ?? 0,
          price: p.salePrice ?? 0,
          companyName: p.companyName,
          locationName: p.locationName ?? p.locationCode,
        })),
        readAt: state === "empty" ? null : readAt(),
      };
    },
    async listScenarios() {
      await gate();
      if (!roles[role].viewCost)
        fail("forbidden", "Cenários restritos a perfis com acesso a custo.");
      return structuredClone(scenarios);
    },
    async saveScenario(input) {
      await gate();
      if (!roles[role].saveScenarios) fail("forbidden", "Você não pode salvar cenários.");
      if (!validateScenario(input) || !input.name.trim() || input.name.trim().length > 60)
        fail("invalid", "Informe um nome de até 60 caracteres e percentuais válidos.");
      const old = scenarios.find((s) => s.id === input.id);
      if (input.id && !old) fail("invalid", "Cenário não encontrado.");
      if (!old && scenarios.length >= 5)
        fail("invalid", "Você já tem 5 cenários. Exclua um antes de salvar outro.");
      const saved: SavedScenario = {
        id: old?.id ?? crypto.randomUUID(),
        name: input.name.trim(),
        cuts: { ...input.cuts },
        discount: input.discount,
        updatedAt: new Date().toISOString(),
      };
      scenarios = [...scenarios.filter((s) => s.id !== saved.id), saved];
      return structuredClone(saved);
    },
    async deleteScenario(id) {
      await gate();
      if (!roles[role].saveScenarios) fail("forbidden", "Você não pode excluir cenários.");
      if (!scenarios.some((s) => s.id === id)) fail("invalid", "Cenário não encontrado.");
      scenarios = scenarios.filter((s) => s.id !== id);
    },
    async exportCsv(input) {
      await gate();
      if (!roles[role].export) fail("forbidden", "Você não pode exportar estoque.");
      if (input.kind === "positions")
        return {
          fileName: "estoque-posicoes-demo.csv",
          csv: positionsCsv(filtered(input.query).map(redact), roles[role].viewCost),
        };
      if (!roles[role].viewCost) fail("forbidden", "Você não pode exportar simulação.");
      const base = scope(input.companyId).map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        curve: p.curve,
        qty: p.physicalQty,
        cost: p.unitCost ?? 0,
        price: p.salePrice ?? 0,
        companyName: p.companyName,
        locationName: p.locationName ?? p.locationCode,
      }));
      return { fileName: "estoque-simulacao-demo.csv", csv: simulationCsv(base, input.scenario) };
    },
    async requestRefresh(companyId) {
      await gate();
      if (!roles[role].refresh) fail("forbidden", "Você não pode solicitar leitura.");
      scope(companyId);
      const next = refreshes.get(companyId) ?? 0;
      if (Date.now() < next) return { queued: false, nextAllowedAt: new Date(next).toISOString() };
      const nextTime = Date.now() + 60000;
      refreshes.set(companyId, nextTime);
      return { queued: true, nextAllowedAt: new Date(nextTime).toISOString(), inProgress: true };
    },
  };
  return {
    api,
    configure(nextRole: MockRole, nextState: MockState) {
      role = nextRole;
      state = nextState;
    },
  };
}
export const mockStock = createMockApi();
