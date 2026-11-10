// Roteador de intenções do assistente: REGRAS FIXAS, nunca o modelo (na Fase 3 ele acertou 3 de 6).
// Fora do catálogo o assistente responde o que sabe fazer, sem chamar a IA.
import type { AiIntent, AiTopic } from "./contract";

/** Minúsculas e sem acento, para casar regra com pergunta escrita de qualquer jeito. */
export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/** Ordem importa: regras mais específicas primeiro ("quem vendeu" antes de "vendeu"). */
const RULES: { intent: AiIntent; test: RegExp }[] = [
  {
    intent: "ranking_vendedores",
    test: /vendedor|equipe|quem (mais )?vend|ranking d?[eao]s? vend/,
  },
  { intent: "ranking_clientes", test: /cliente/ },
  { intent: "ranking_produtos", test: /produto|mais vendid|\bitem/ },
  { intent: "oportunidades_estoque", test: /oportunidad|transfer|remanej|mover estoque/ },
  {
    intent: "estoque_parado",
    test: /parad|encalhad|sem giro|baixo giro|obsolet|obsolesc|excesso|curva [abc]|capital (parado|em estoque)|estoque/,
  },
  {
    intent: "comparacao_periodos",
    test: /compar|anterior|ano passado|mes passado|cresc|caiu|queda|variacao|evolu/,
  },
  {
    // "previsão" sozinha NÃO basta ("previsão do tempo" fica fora do catálogo).
    intent: "ritmo_plano",
    test: /\bmeta\b|\britmo\b|plano de voo|falta (para|pra)|bater|atingi|carteira|previsao d[oe] (mes|ano|faturamento|vendas)/,
  },
  { intent: "explicar_tela", test: /\b(explic|resum[ao]|analis|visao geral|panorama)/ },
  {
    intent: "faturamento_periodo",
    test: /fatur|receita|vendas|vendemos|quanto vend|ticket|nota|pedido|como estamos/,
  },
];

/** Decide a intenção pela pergunta; sem regra casada, devolve null (fora do catálogo). */
export function routeIntent(question: string, _topic: AiTopic): AiIntent | null {
  const q = normalize(question);
  for (const rule of RULES) if (rule.test.test(q)) return rule.intent;
  return null;
}

/** Intenção do botão "Explicar esta tela" conforme a tela. */
export function explainIntentFor(topic: AiTopic): AiIntent {
  if (topic === "estoque") return "estoque_parado";
  if (topic === "vendedores") return "ranking_vendedores";
  if (topic === "clientes") return "ranking_clientes";
  if (topic === "produtos") return "ranking_produtos";
  return "explicar_tela";
}

/** Sugestões por tela (viram chips no balão; cada uma já chega com a intenção certa). */
export function suggestionsFor(topic: AiTopic): { label: string; intent: AiIntent }[] {
  const base: { label: string; intent: AiIntent }[] = [
    { label: "Explicar esta tela", intent: explainIntentFor(topic) },
  ];
  if (topic === "estoque") {
    return [
      ...base,
      { label: "O que está parado?", intent: "estoque_parado" },
      { label: "Oportunidades entre empresas", intent: "oportunidades_estoque" },
    ];
  }
  if (topic === "vendedores") {
    return [
      ...base,
      { label: "Quem vendeu mais no período?", intent: "ranking_vendedores" },
      { label: "Vamos bater a meta?", intent: "ritmo_plano" },
    ];
  }
  if (topic === "plano") {
    return [
      ...base,
      { label: "Vamos bater a meta?", intent: "ritmo_plano" },
      { label: "Comparar com o mês anterior", intent: "comparacao_periodos" },
    ];
  }
  if (topic === "clientes") {
    return [
      ...base,
      { label: "Principais clientes do período", intent: "ranking_clientes" },
      { label: "Como está o faturamento?", intent: "faturamento_periodo" },
    ];
  }
  if (topic === "produtos") {
    return [
      ...base,
      { label: "Produtos mais vendidos", intent: "ranking_produtos" },
      { label: "O que está parado no estoque?", intent: "estoque_parado" },
    ];
  }
  return [
    ...base,
    { label: "Como está o faturamento?", intent: "faturamento_periodo" },
    { label: "Vamos bater a meta?", intent: "ritmo_plano" },
  ];
}

/** Resposta fixa para pergunta fora do catálogo (sem chamar a IA). */
export const CATALOG_TEXT =
  "Ainda não sei responder isso. Posso ajudar com: faturamento do período, comparação com o mês ou o ano anterior, ritmo e meta do Plano de Voo, ranking de vendedores, clientes ou produtos, estoque parado e oportunidades entre empresas. Toque numa sugestão ou reformule a pergunta.";
