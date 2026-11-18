// Cliente do gateway MAG AI (Fase 4). Só no servidor: a chave nunca chega ao navegador.
// Regras: prazo de 45 s, disjuntor curto, nunca registrar o texto dos pedidos nem das respostas.
// Contrato do gateway (mag-ai/gateway): POST /v1/chat {task, messages, max_tokens, stream:false}
// com Authorization: Bearer <chave>; GET /v1/health {status, ollama, model_loaded, queue}.

/** "analisar" usa o segundo modelo do gateway (raciocínio local); as outras usam o rápido. */
export type MagAiTask = "explicar" | "resumir" | "responder" | "classificar" | "analisar";

export interface MagAiOk {
  ok: true;
  content: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  queueMs: number;
  totalMs: number;
}
export interface MagAiFail {
  ok: false;
  /** Vira o status do registro e a mensagem da tela. */
  code: "indisponivel" | "ocupado" | "limite" | "erro";
  retryAfterS: number;
  totalMs: number;
}
export type MagAiResult = MagAiOk | MagAiFail;

export function magAiConfig(): { url: string; key: string } | null {
  const url = (process.env["MAG_AI_URL"] ?? "").replace(/\/+$/, "");
  const key = process.env["MAG_AI_KEY"] ?? "";
  if (!url || !key) return null;
  return { url, key };
}

/** Disjuntor: 3 falhas de rede seguidas abrem por 60 s (resposta imediata "indisponível"). */
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_OPEN_MS = 60_000;

export interface MagAiHealth {
  status: string;
  modelLoaded: boolean;
  queue: number;
  /** O gateway tem o segundo modelo (raciocínio) configurado? */
  deep: boolean;
}

export async function magAiHealth(): Promise<MagAiHealth | null> {
  const cfg = magAiConfig();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/v1/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      status?: string;
      model_loaded?: boolean;
      queue?: number;
      analise?: string;
    };
    return {
      status: typeof j.status === "string" ? j.status : "degraded",
      modelLoaded: j.model_loaded === true,
      queue: Number(j.queue ?? 0),
      deep: j.analise === "on",
    };
  } catch {
    return null;
  }
}

/**
 * Pede uma redação ao MAG AI (sem streaming: a resposta só aparece depois da trava de números).
 * O tamanho da entrada é limitado pelo gateway (aplicação biomie: 4.500 caracteres).
 */
export async function magAiChat(input: {
  task: MagAiTask;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<MagAiResult> {
  const started = Date.now();
  const done = (r: Omit<MagAiFail, "totalMs">): MagAiFail => ({
    ...r,
    totalMs: Date.now() - started,
  });
  const cfg = magAiConfig();
  if (!cfg) return done({ ok: false, code: "indisponivel", retryAfterS: 0 });
  if (Date.now() < breaker.openUntil)
    return done({ ok: false, code: "indisponivel", retryAfterS: 30 });

  let response: Response;
  try {
    response = await fetch(`${cfg.url}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        task: input.task,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        stream: false,
      }),
      // A análise profunda pensa passo a passo: prazo maior (o gateway limita a 200 s por pedido).
      signal: AbortSignal.timeout(
        input.timeoutMs ?? (input.task === "analisar" ? 180_000 : 45_000),
      ),
    });
  } catch {
    breaker.failures += 1;
    if (breaker.failures >= 3) breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    return done({ ok: false, code: "indisponivel", retryAfterS: 30 });
  }
  breaker.failures = 0;

  const retryAfterS = Number(response.headers.get("retry-after") ?? 0) || 0;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) return done({ ok: false, code: "limite", retryAfterS });
    if (response.status === 503) {
      // "busy" (fila cheia) e "upstream_unavailable" chegam os dois como 503.
      return done({ ok: false, code: retryAfterS <= 30 ? "ocupado" : "indisponivel", retryAfterS });
    }
    if (response.status === 504) return done({ ok: false, code: "ocupado", retryAfterS: 15 });
    console.error(`[mag-ai] resposta ${response.status}`);
    return done({ ok: false, code: "erro", retryAfterS });
  }

  try {
    const j = (await response.json()) as {
      content?: string;
      model?: string;
      usage?: { prompt_tokens?: number; output_tokens?: number };
      timings?: { queue_ms?: number };
    };
    if (typeof j.content !== "string" || j.content.length === 0) {
      console.error("[mag-ai] resposta sem conteúdo");
      return done({ ok: false, code: "erro", retryAfterS: 0 });
    }
    return {
      ok: true,
      content: j.content.trim(),
      model: typeof j.model === "string" ? j.model : "",
      promptTokens: Number(j.usage?.prompt_tokens ?? 0),
      outputTokens: Number(j.usage?.output_tokens ?? 0),
      queueMs: Number(j.timings?.queue_ms ?? 0),
      totalMs: Date.now() - started,
    };
  } catch {
    console.error("[mag-ai] resposta ilegível");
    return done({ ok: false, code: "erro", retryAfterS: 0 });
  }
}
