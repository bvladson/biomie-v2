/**
 * Balão flutuante do assistente MAG AI (Fase 4). Só aparece com a feature 'ai_assistant' (chave no
 * banco + perfil liberado). A resposta chega inteira DEPOIS da trava de números — enquanto espera, a
 * tela mostra etapas; o primeiro uso avisa que a IA está sendo carregada (~45 s, medido na Fase 3).
 * Os fatos usados (os mesmos números da tela) ficam visíveis embaixo de cada resposta.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { aiAsk, aiAvailability, aiRate } from "@/lib/ai.functions";
import type { AiAnswer, AiAvailability, AiIntent, AiTopic } from "@/lib/ai/contract";
import { suggestionsFor } from "@/lib/ai/intents";
import { appContextQuery } from "@/lib/queries";
import { useGlobalFilters } from "@/hooks/use-filters";
import { cn } from "@/lib/utils";

function topicOf(pathname: string): AiTopic {
  if (pathname.startsWith("/estoque")) return "estoque";
  if (pathname.startsWith("/vendedores")) return "vendedores";
  if (pathname.startsWith("/plano-de-voo")) return "plano";
  if (pathname.startsWith("/clientes")) return "clientes";
  if (pathname.startsWith("/produtos")) return "produtos";
  if (pathname.startsWith("/vendas") || pathname.startsWith("/cockpit")) return "vendas";
  return "geral";
}

interface ChatItem {
  question: string;
  answer: AiAnswer | null; // null = em andamento
  rated: boolean | null;
}

const STAGES = ["Consultando os fatos…", "Redigindo com a IA local…", "Conferindo os números…"];

function AnswerBlock({ item, onRate }: { item: ChatItem; onRate: (useful: boolean) => void }) {
  const a = item.answer;
  if (!a) return null;
  const soft = a.status !== "ok" && a.status !== "descartada" && a.status !== "fora_catalogo";
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
      {a.status === "descartada" && (
        <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-500">
          <AlertTriangle className="size-3" /> Resposta da IA descartada pela conferência de números
        </p>
      )}
      <p className="whitespace-pre-wrap">{a.text}</p>
      {soft && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Os números da tela continuam valendo.
        </p>
      )}
      {a.facts.length > 0 && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className="size-3" /> Números usados ({a.facts.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-0.5 border-l-2 border-border pl-2 text-[11px] text-muted-foreground">
              {a.facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {a.requestId && a.status === "ok" && (
        <div className="mt-2 flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Ajudou?</span>
          <button
            type="button"
            aria-label="Resposta útil"
            disabled={item.rated !== null}
            onClick={() => onRate(true)}
            className={cn(
              "rounded p-1 hover:bg-accent disabled:pointer-events-none",
              item.rated === true ? "text-emerald-600" : "text-muted-foreground",
            )}
          >
            <ThumbsUp className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Resposta não ajudou"
            disabled={item.rated !== null}
            onClick={() => onRate(false)}
            className={cn(
              "rounded p-1 hover:bg-accent disabled:pointer-events-none",
              item.rated === false ? "text-red-500" : "text-muted-foreground",
            )}
          >
            <ThumbsDown className="size-3.5" />
          </button>
          {item.rated !== null && (
            <span className="text-[11px] text-muted-foreground">Obrigado!</span>
          )}
        </div>
      )}
    </div>
  );
}

export function AssistantBalloon() {
  const { data: ctx } = useSuspenseQuery(appContextQuery());
  const { resolved } = useGlobalFilters();
  const askFn = useServerFn(aiAsk);
  const availabilityFn = useServerFn(aiAvailability);
  const rateFn = useServerFn(aiRate);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<AiAvailability | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [slowHint, setSlowHint] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const topic = topicOf(pathname);
  const suggestions = useMemo(() => suggestionsFor(topic), [topic]);
  const enabled = (ctx.features ?? []).includes("ai_assistant");

  useEffect(() => {
    if (!open || availability) return;
    availabilityFn()
      .then(setAvailability)
      .catch(() => setAvailability({ enabled: true, reachable: "degraded", firstUseSlow: true }));
  }, [open, availability, availabilityFn]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [items, busy, stage]);

  if (!enabled || !resolved) return null;

  // Os mesmos filtros resolvidos que as telas usam (AnalyticsQuery), menos a empresa (vai à parte).
  const filters = {
    ...(resolved.period ? { period: resolved.period } : {}),
    ...(resolved.channel ? { channel: resolved.channel } : {}),
    ...(resolved.branch ? { branch: resolved.branch } : {}),
    ...(resolved.seller ? { seller: resolved.seller } : {}),
    ...(resolved.state ? { state: resolved.state } : {}),
    ...(resolved.city ? { city: resolved.city } : {}),
    ...(resolved.category ? { category: resolved.category } : {}),
  };

  const ask = async (text: string, intent?: AiIntent) => {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion("");
    setBusy(true);
    setStage(0);
    setSlowHint(false);
    setItems((prev) => [...prev, { question: q, answer: null, rated: null }]);
    const t1 = setTimeout(() => setStage(1), 1800);
    const t2 = setTimeout(() => setStage(2), 9000);
    const t3 = setTimeout(() => setSlowHint(true), 7000);
    try {
      const answer = await askFn({
        data: {
          companyId: resolved.company,
          topic,
          question: q,
          ...(intent ? { intent } : {}),
          filters,
        },
      });
      setItems((prev) => prev.map((it, i) => (i === prev.length - 1 ? { ...it, answer } : it)));
    } catch (error) {
      // Mostra a causa real (e registra no console): esconder o erro atrás de um texto genérico
      // custou um ciclo inteiro de diagnóstico na homologação de 11/11.
      const raw = error instanceof Error ? error.message : String(error);
      console.error("[assistente] pergunta falhou:", raw);
      const coded = /ai::([\s\S]+)/.exec(raw)?.[1];
      const message = coded
        ? coded
        : raw
          ? `Não consegui responder agora (erro técnico: ${raw.slice(0, 240)}). Os números continuam na tela.`
          : "Não foi possível falar com o assistente agora. Os números continuam na tela.";
      setItems((prev) =>
        prev.map((it, i) =>
          i === prev.length - 1
            ? {
                ...it,
                answer: {
                  status: "erro",
                  text: message,
                  facts: [],
                  requestId: null,
                  intent: null,
                  model: null,
                  totalMs: 0,
                  flagged: 0,
                },
              }
            : it,
        ),
      );
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      setBusy(false);
      setSlowHint(false);
    }
  };

  const rate = (index: number, useful: boolean) => {
    const item = items[index];
    if (!item?.answer?.requestId) return;
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, rated: useful } : it)));
    rateFn({ data: { requestId: item.answer.requestId, useful } }).catch(() => undefined);
  };

  return (
    <>
      {open && (
        <div
          className="fixed bottom-20 right-4 z-50 flex max-h-[min(34rem,calc(100dvh-7rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl md:bottom-24 md:right-6"
          role="dialog"
          aria-label="Assistente BIOMIE"
        >
          <div className="flex items-center gap-2 border-b bg-primary px-3 py-2.5 text-primary-foreground">
            <Sparkles className="size-4" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight">Assistente BIOMIE</p>
              <p className="truncate text-[11px] leading-tight opacity-85">
                IA local da MAG · responde só com os números desta tela
              </p>
            </div>
            <button
              type="button"
              aria-label="Fechar assistente"
              onClick={() => setOpen(false)}
              className="rounded p-1 hover:bg-primary-foreground/15"
            >
              <X className="size-4" />
            </button>
          </div>

          {availability && availability.reachable !== "ok" && (
            <p className="border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              {availability.reachable === "off"
                ? "A IA está desligada neste ambiente; mostro só os números da tela."
                : "A IA está acordando; o primeiro pedido pode levar até 1 minuto."}
            </p>
          )}

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {items.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Pergunte sobre os números desta tela, ou toque numa sugestão. Eu respondo com os
                mesmos valores que o BIOMIE calcula — nunca invento números.
              </p>
            )}
            {items.map((item, i) => (
              <div key={i} className="space-y-1.5">
                <p className="ml-6 rounded-lg bg-primary/10 px-3 py-1.5 text-right text-sm">
                  {item.question}
                </p>
                {item.answer ? (
                  <AnswerBlock item={item} onRate={(useful) => rate(i, useful)} />
                ) : (
                  <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {STAGES[stage]}
                    {slowHint && (availability?.firstUseSlow ?? true) && (
                      <span className="opacity-75">(primeiro uso: a IA carrega em até 1 min)</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5 border-t px-3 pt-2">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={busy}
                onClick={() => void ask(s.label, s.intent)}
                className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
              >
                {s.label}
              </button>
            ))}
          </div>

          <form
            className="flex items-end gap-2 px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(question);
                }
              }}
              rows={1}
              maxLength={280}
              placeholder="Escreva sua pergunta…"
              aria-label="Pergunta ao assistente"
              className="max-h-24 min-h-9 flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0"
              disabled={busy || !question.trim()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </form>
        </div>
      )}

      <button
        type="button"
        aria-label={open ? "Fechar o assistente BIOMIE" : "Abrir o assistente BIOMIE"}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed bottom-4 right-4 z-50 flex size-12 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105 md:bottom-6 md:right-6",
          "bg-primary text-primary-foreground",
        )}
      >
        {open ? <X className="size-5" /> : <Sparkles className="size-5" />}
      </button>
    </>
  );
}
