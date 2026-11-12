// Assistente MAG AI (Fase 4, 10/11/2026). Contrato entre o balão, as funções de servidor e o gateway.
// Princípios do plano aprovado (mag-ai/docs/fase2-plano.md §6): o BIOMIE calcula os indicadores e as
// conclusões com a sessão do usuário; a IA local só redige; a intenção vem de regras (nunca do modelo);
// todo número da resposta precisa existir nos fatos; o registro guarda só metadados.

/** Catálogo fechado de intenções. Fora dele, o assistente responde o que sabe fazer. */
export const AI_INTENTS = [
  "explicar_tela",
  "faturamento_periodo",
  "comparacao_periodos",
  "ritmo_plano",
  "previsao_mes",
  "historico_meses",
  "tendencia",
  "ranking_vendedores",
  "ranking_clientes",
  "ranking_produtos",
  "estoque_parado",
  "oportunidades_estoque",
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

/** Tela em que o balão está (decide fatos e sugestões; não restringe a pergunta). */
export type AiTopic =
  "geral" | "vendas" | "vendedores" | "clientes" | "produtos" | "plano" | "estoque";

/** Filtros globais da tela que mudam os fatos (mesmos nomes do AnalyticsQuery). */
export interface AiFilters {
  period?: string /* AAAA-MM */;
  channel?: string;
  branch?: string;
  seller?: string;
  state?: string;
  city?: string;
  category?: string;
}

export interface AiAskInput {
  companyId: string;
  topic: AiTopic;
  question: string;
  intent?: AiIntent;
  filters?: AiFilters;
}

export type AiAnswerStatus =
  | "ok"
  | "descartada" // número fora dos fatos: entra o texto-modelo com os fatos
  | "fora_catalogo"
  | "indisponivel"
  | "ocupado"
  | "limite"
  | "erro";

export interface AiAnswer {
  status: AiAnswerStatus;
  text: string;
  /** Fatos usados (os mesmos números da tela), para o bloco "números usados". */
  facts: string[];
  requestId: string | null;
  intent: AiIntent | null;
  model: string | null;
  totalMs: number;
  /** Quantos números a trava descartou (0 quando status "ok"). */
  flagged: number;
}

export interface AiAvailability {
  /** Chave ai_assistant ligada para este usuário (o balão só aparece com a feature). */
  enabled: boolean;
  /** Gateway configurado e respondendo. "off" = sem configuração; a tela continua com os números. */
  reachable: "ok" | "degraded" | "off";
  /** Modelo descarregado: o primeiro pedido leva ~45 s. */
  firstUseSlow: boolean;
}

/** JSON simples (o resumo vem pronto do banco; os valores são contagens e médias). */
export type AiJson = string | number | boolean | null | AiJson[] | { [key: string]: AiJson };

export interface AiAdminState {
  enabled: boolean;
  roles: string[];
  summary: { [key: string]: AiJson } | null;
}
