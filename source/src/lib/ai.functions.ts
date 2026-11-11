/**
 * Funções de servidor do assistente MAG AI (Fase 4). Fluxo do plano aprovado:
 * intenção por REGRAS (nunca o modelo) → fatos pelas leituras das telas (RLS do usuário) → o modelo só
 * redige → trava de números (número fora dos fatos descarta a resposta) → registro só de metadados.
 * A chave do gateway fica no servidor; quem pode usar vem do banco (ai_assistant_enabled_for_me).
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  AI_INTENTS,
  type AiAdminState,
  type AiAnswer,
  type AiAnswerStatus,
  type AiAvailability,
  type AiFilters,
  type AiJson,
} from "./ai/contract";
import { CATALOG_TEXT, routeIntent } from "./ai/intents";

const noStore = () => setResponseHeader("Cache-Control", "no-store");

/** As funções ai_* da 0052 ainda não estão nos tipos gerados do Supabase (mesmo caminho do Estoque). */
type RpcResult = Promise<{ data: unknown; error: { message?: string } | null }>;
const rpcOf = (db: unknown) => {
  const raw = db as { rpc: (name: string, args?: Record<string, unknown>) => RpcResult };
  return (name: string, args?: Record<string, unknown>): RpcResult => raw.rpc(name, args);
};

const uuid = z.string().uuid();
const topic = z.enum(["geral", "vendas", "vendedores", "clientes", "produtos", "plano", "estoque"]);
const filters = z
  .object({
    period: z.string().max(12).optional(),
    channel: z.string().max(64).optional(),
    branch: z.string().max(64).optional(),
    seller: z.string().max(64).optional(),
    state: z.string().max(4).optional(),
    city: z.string().max(80).optional(),
    category: z.string().max(80).optional(),
  })
  .strict();

const askSchema = z
  .object({
    companyId: uuid,
    topic,
    question: z.string().trim().min(2).max(280),
    intent: z.enum(AI_INTENTS).optional(),
    filters: filters.optional(),
  })
  .strict();

/** Tira as chaves vazias (exactOptionalPropertyTypes: opcional ausente ≠ undefined). */
function cleanFilters(raw: z.infer<typeof filters> | undefined): AiFilters {
  const out: AiFilters = {};
  if (!raw) return out;
  if (raw.period) out.period = raw.period;
  if (raw.channel) out.channel = raw.channel;
  if (raw.branch) out.branch = raw.branch;
  if (raw.seller) out.seller = raw.seller;
  if (raw.state) out.state = raw.state;
  if (raw.city) out.city = raw.city;
  if (raw.category) out.category = raw.category;
  return out;
}

const SYSTEM_RESPONDER = [
  "Você é o assistente do BIOMIE, o BI comercial da MAG. Responda em português do Brasil, em até 4 frases curtas e diretas.",
  "Use somente os FATOS fornecidos e copie os números exatamente como estão escritos.",
  "Não some, não calcule, não estime e não invente números nem percentuais.",
  "As conclusões (meta batida, variações, quanto falta) já estão prontas nos fatos; repita-as como estão.",
  "Se o dado pedido não estiver nos fatos, responda apenas: Não tenho esse dado nesta tela.",
].join(" ");

const SYSTEM_EXPLICAR = [
  "Você é o assistente do BIOMIE, o BI comercial da MAG. Explique a situação em 3 a 5 frases simples, para um gestor com pressa, em português do Brasil.",
  "Use somente os FATOS fornecidos e copie os números exatamente como estão escritos.",
  "Não some, não calcule, não estime e não invente números nem percentuais.",
  "As conclusões (meta batida, variações, quanto falta) já estão prontas nos fatos; repita-as como estão.",
].join(" ");

const FRIENDLY: Record<Exclude<AiAnswerStatus, "ok" | "descartada" | "fora_catalogo">, string> = {
  indisponivel: "A explicação automática está indisponível agora. Os números continuam na tela.",
  ocupado: "A IA está ocupada com outro pedido. Tente de novo em instantes.",
  limite: "A IA atingiu o limite de pedidos por agora. Tente de novo em alguns minutos.",
  erro: "Não consegui falar com a IA agora. Os números continuam na tela.",
};

/** O balão pergunta ao abrir: ligado para mim? gateway no ar? modelo carregado? */
export const aiAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiAvailability> => {
    noStore();
    const { data } = await rpcOf(context.supabase)("ai_assistant_enabled_for_me");
    const enabled = data === true;
    if (!enabled) return { enabled: false, reachable: "off", firstUseSlow: false };
    const { magAiConfig, magAiHealth } = await import("./ai/mag-ai.server");
    if (!magAiConfig()) return { enabled, reachable: "off", firstUseSlow: false };
    const health = await magAiHealth();
    if (!health) return { enabled, reachable: "degraded", firstUseSlow: true };
    return {
      enabled,
      reachable: health.status === "ok" ? "ok" : "degraded",
      firstUseSlow: !health.modelLoaded,
    };
  });

export const aiAsk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => askSchema.parse(raw))
  .handler(async ({ context, data }): Promise<AiAnswer> => {
    noStore();
    const started = Date.now();
    const { supabase, userId } = context;
    const rpc = rpcOf(supabase);

    const { data: enabled } = await rpc("ai_assistant_enabled_for_me");
    if (enabled !== true) throw new Error("ai::O assistente está desligado para o seu usuário.");

    const log = async (
      intent: string,
      status: AiAnswerStatus,
      extra?: {
        model?: string;
        queueMs?: number;
        promptTokens?: number;
        outputTokens?: number;
        flagged?: number;
      },
    ): Promise<string | null> => {
      try {
        const { data: id } = await rpc("ai_request_log", {
          p_company: data.companyId,
          p_intent: intent,
          p_status: status,
          p_model: extra?.model ?? "",
          p_queue_ms: extra?.queueMs ?? 0,
          p_total_ms: Date.now() - started,
          p_prompt_tokens: extra?.promptTokens ?? 0,
          p_output_tokens: extra?.outputTokens ?? 0,
          p_flagged: extra?.flagged ?? 0,
        });
        return typeof id === "string" ? id : null;
      } catch {
        return null; // registro nunca derruba a resposta
      }
    };

    const intent = data.intent ?? routeIntent(data.question, data.topic);
    if (!intent) {
      const requestId = await log("fora_catalogo", "fora_catalogo");
      return {
        status: "fora_catalogo",
        text: CATALOG_TEXT,
        facts: [],
        requestId,
        intent: null,
        model: null,
        totalMs: Date.now() - started,
        flagged: 0,
      };
    }

    const { buildFacts } = await import("./ai/facts.server");
    const bundle = await buildFacts(
      supabase,
      userId,
      intent,
      data.topic,
      data.companyId,
      cleanFilters(data.filters),
    );

    const { magAiChat, magAiConfig } = await import("./ai/mag-ai.server");
    if (!magAiConfig()) {
      const requestId = await log(intent, "indisponivel");
      return {
        status: "indisponivel",
        text: FRIENDLY.indisponivel,
        facts: bundle.lines,
        requestId,
        intent,
        model: null,
        totalMs: Date.now() - started,
        flagged: 0,
      };
    }

    // Chips chegam com a intenção marcada e pedem explicação corrida; pergunta digitada pede resposta direta.
    const explain = intent === "explicar_tela" || data.intent !== undefined;
    const task = explain ? ("explicar" as const) : ("responder" as const);
    const result = await magAiChat({
      task,
      system: explain ? SYSTEM_EXPLICAR : SYSTEM_RESPONDER,
      user: `${bundle.lines.join("\n")}\n\nPERGUNTA: ${data.question}`,
      maxTokens: explain ? 260 : 220,
    });

    if (!result.ok) {
      const requestId = await log(intent, result.code);
      return {
        status: result.code,
        text: FRIENDLY[result.code],
        facts: bundle.lines,
        requestId,
        intent,
        model: null,
        totalMs: Date.now() - started,
        flagged: 0,
      };
    }

    const { verifyAnswer, fallbackText } = await import("./ai/verify");
    const check = verifyAnswer(result.content, bundle.lines);
    const status: AiAnswerStatus = check.ok ? "ok" : "descartada";
    const requestId = await log(intent, status, {
      model: result.model,
      queueMs: result.queueMs,
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      flagged: check.flagged.length,
    });
    return {
      status,
      text: check.ok ? result.content : fallbackText(bundle.lines),
      facts: bundle.lines,
      requestId,
      intent,
      model: result.model || null,
      totalMs: Date.now() - started,
      flagged: check.flagged.length,
    };
  });

export const aiRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z.object({ requestId: uuid, useful: z.boolean().nullable() }).strict().parse(raw),
  )
  .handler(async ({ context, data }) => {
    noStore();
    const { data: ok, error } = await rpcOf(context.supabase)("ai_request_rate", {
      p_id: data.requestId,
      p_useful: data.useful,
    });
    if (error) throw new Error("ai::Não foi possível guardar a avaliação.");
    return { saved: ok === true };
  });

/** Tela do Admin: estado da chave + resumo dos últimos dias (só administradores). */
export const aiAdminGet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiAdminState> => {
    noStore();
    const rpc = rpcOf(context.supabase);
    const { data: cfg, error } = await rpc("ai_assistant_config");
    if (error) throw new Error("ai::Não foi possível ler a configuração.");
    const parsed = (cfg ?? {}) as { enabled?: boolean; roles?: string[] };
    let summary: AiAdminState["summary"] = null;
    const { data: sum } = await rpc("ai_requests_summary", { p_company: null, p_days: 7 });
    if (sum && typeof sum === "object" && !Array.isArray(sum)) {
      summary = sum as { [key: string]: AiJson };
    }
    return {
      enabled: parsed.enabled === true,
      roles: Array.isArray(parsed.roles) ? parsed.roles.map(String) : ["SUPER_ADMIN"],
      summary,
    };
  });

export const aiAdminSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z
      .object({ enabled: z.boolean(), roles: z.array(z.string().max(20)).min(1).max(8) })
      .strict()
      .parse(raw),
  )
  .handler(async ({ context, data }) => {
    noStore();
    const { data: cfg, error } = await rpcOf(context.supabase)("ai_assistant_set", {
      p_enabled: data.enabled,
      p_roles: data.roles,
    });
    if (error) {
      const coded = /ai::([\s\S]+)/.exec(error.message ?? "");
      throw new Error(coded ? `ai::${coded[1]}` : "ai::Não foi possível salvar.");
    }
    return cfg as { enabled: boolean; roles: string[] };
  });
