import type { AuditEvent } from "../api/contract";

export const AUDIT_ACTIONS: Record<string, string> = {
  "user.created": "Usuário criado",
  "role.granted": "Papel concedido",
  "role.revoked": "Papel retirado",
  "company.granted": "Empresa concedida",
  "company.revoked": "Empresa retirada",
  "permission.changed": "Permissão alterada",
  "access.link_issued": "Link de acesso gerado",
  "access.password_issued": "Senha gerada ou alterada",
  "user.blocked": "Bloqueio",
  "user.reactivated": "Reativação",
  "user.deleted": "Exclusão",
  "config.changed": "Configuração alterada",
  "user.updated": "Perfil ou vínculo alterado",
  "sessions.revoked": "Sessões encerradas",
  "access.password_changed": "Senha alterada pelo próprio usuário",
  "user.provisioned": "Perfil criado no primeiro acesso",
  // Eventos gravados por outras partes do BIOMIE.
  "worker.control": "Cargas do Omie pausadas ou retomadas",
  "settings.demo_visibility": "Visibilidade da demonstração",
  "settings.app_base_url": "Endereço do sistema",
  "integration.credentials_set": "Credenciais do Omie gravadas",
  "integration.credentials_encrypted": "Credenciais do Omie gravadas",
  "integration.tested": "Conexão com o Omie testada",
  "integration.match_resolved": "Vínculo Omie × BIOMIE decidido",
  "company.data_source_changed": "Fonte de dados da empresa",
  "integrity.resolve": "Divergência decidida",
  "document.reveal": "CPF/CNPJ completo revelado",
  "finance.export": "Exportação do financeiro",
  "stock.curve.changed": "Curva de estoque alterada",
  "stock.scenario.saved": "Cenário de liquidação salvo",
  "stock.scenario.deleted": "Cenário de liquidação excluído",
  "stock.refresh.requested": "Leitura do estoque solicitada",
  "stock.module.mode": "Liberação do módulo Estoque",
  "stock.reading.toggled": "Leitura do estoque ligada ou desligada",
  "stock.intel.alert_ack": "Alerta do estoque: ciente",
  "stock.lead_time.changed": "Prazo de entrega do fornecedor",
  "stock.preferred_supplier.changed": "Fornecedor principal do produto",
  "stock.supplier_link.changed": "Vínculo produto × fornecedor",
  "stock.replenishment_policy.changed": "Política de reposição",
  "stock.suppliers.import_requested": "Importação de fornecedores solicitada",
  "legacy.identity_import": "Importação do sistema antigo",
  "legacy.targets_teams_import": "Importação do sistema antigo",
  update: "Configuração do Plano de Voo",
  reprocess: "Reprocessamento do Plano de Voo",
  create: "Equipe criada",
  rename: "Equipe renomeada",
  toggle: "Equipe ativada ou desativada",
  addMember: "Vendedor incluído na equipe",
  removeMember: "Vendedor retirado da equipe",
  addManager: "Gestor incluído na equipe",
  removeManager: "Gestor retirado da equipe",
};

export const ENTITY_LABELS: Record<string, string> = {
  user: "Usuário",
  company: "Empresa",
  holiday: "Feriado",
  worker: "Cargas do Omie",
  app_settings: "Configuração",
  company_integrations: "Integração",
  companies: "Empresa",
  customers: "Cliente",
  sales_teams: "Equipe",
  integrity_issues: "Divergência",
  canonical_entity_matches: "Vínculo Omie",
  "metric_config.flight_plan": "Plano de Voo",
  flight_plan_snapshots: "Plano de Voo",
  migration: "Migração",
  authorization: "Autorização",
  stock: "Estoque",
};

const FIELD_LABELS: Record<string, string> = {
  nome: "Nome",
  email: "E-mail",
  papeis: "Papéis",
  empresas: "Empresas",
  permissoes: "Permissões extras",
  status: "Status",
  motivo: "Motivo",
  entrega: "Forma de entrega",
  validoAte: "Válido até",
  trocaObrigatoria: "Troca obrigatória no 1º acesso",
  data: "Data",
  abrangencia: "Abrangência",
  importados: "Importados",
  duplicadosIgnorados: "Duplicados ignorados",
  origem: "Origem",
  usuario: "Nome de usuário",
  empresaPadrao: "Empresa padrão",
  vendedores: "Vendedores do Omie",
  equipes: "Equipes que gerencia",
  dispositivos: "Dispositivos",
  papel: "Papel",
  permissao: "Permissão",
  // Estoque: fornecedores, prazos e política de reposição (0048/0049)
  fornecedor: "Fornecedor",
  produto: "Produto",
  leadTimeDays: "Prazo de entrega (dias corridos)",
  minLot: "Lote mínimo",
  note: "Observação",
  situacao: "Situação",
  principal: "Fornecedor principal",
  omie: "Vínculo do Omie",
  manual: "Vínculo manual",
  reviewDays: "Revisão a cada (dias)",
  serviceLevel: "Nível de serviço",
  maxCoverageDays: "Cobertura máxima (dias)",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Campos cujos valores são identificadores de empresa. */
const COMPANY_FIELDS = new Set(["empresas", "empresaPadrao"]);

/** Chaves que nunca podem ser exibidas (defesa extra: o servidor não deve enviá-las). */
const SECRET_KEY = /(senha|password|secret|token|link|url|value|hash)$/i;

export function sanitizePayload(p?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!p) return p;
  return Object.fromEntries(Object.entries(p).filter(([k]) => !SECRET_KEY.test(k)));
}

export function formatValue(
  v: unknown,
  companyName: (id: string) => string,
  isCompanyField = false,
): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (Array.isArray(v))
    return v.length
      ? v.map((x) => formatValue(x, companyName, isCompanyField)).join(", ")
      : "nenhum";
  if (typeof v === "string") {
    if (isCompanyField && UUID_RE.test(v)) {
      const name = companyName(v);
      return name === v ? "empresa fora do seu alcance" : name;
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString("pt-BR");
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
    return v;
  }
  return JSON.stringify(v);
}

export interface ChangeLine {
  field: string;
  before: string;
  after: string;
}

export function describeChanges(e: AuditEvent, companyName: (id: string) => string): ChangeLine[] {
  const b = sanitizePayload(e.before) ?? {};
  const a = sanitizePayload(e.after) ?? {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  return keys.map((k) => ({
    field: FIELD_LABELS[k] ?? k,
    before: k in b ? formatValue(b[k], companyName, COMPANY_FIELDS.has(k)) : "—",
    after: k in a ? formatValue(a[k], companyName, COMPANY_FIELDS.has(k)) : "—",
  }));
}

export function toCsv(rows: string[][]): string {
  const esc = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "\uFEFF" + rows.map((r) => r.map(esc).join(";")).join("\n");
}
