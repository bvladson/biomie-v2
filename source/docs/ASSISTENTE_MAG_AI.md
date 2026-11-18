# Assistente MAG AI no BIOMIE (Fase 4 — migração 0052)

O balão flutuante "Assistente BIOMIE" responde perguntas sobre os números do BI usando a IA local da
MAG (MAG AI: Ollama `qwen3.5:0.8b-q8_0` atrás de um gateway interno na VPS). Segue o plano aprovado em
`mag-ai/docs/fase2-plano.md` §6 e as recomendações do relatório da Fase 3 (07/11/2026).

## Princípios (não mudar sem nova decisão)

1. **A IA não acessa o banco.** O BIOMIE calcula os indicadores E as conclusões (meta batida sim/não,
   diferenças, variações) pelas mesmas leituras das telas, com a sessão do usuário (RLS). A IA só
   redige. Vendedor só vê os próprios números porque a consulta usa a sessão dele.
2. **A intenção vem de regras, nunca do modelo** (na Fase 3 ele classificou 3 de 6). Catálogo fechado
   em `src/lib/ai/intents.ts`; fora dele, resposta fixa com o que dá para perguntar.
3. **Trava de números** (`src/lib/ai/verify.ts`): todo número da resposta precisa existir nos fatos
   (tolerância de formatação; inteiros 0–31 e anos passam). Número estranho → a resposta é DESCARTADA
   e entra um texto-modelo com os próprios fatos.
4. **Registro só de metadados** em `private.ai_requests` (usuário, empresa, intenção, status, tempos,
   tokens, avaliação útil/não útil). Nunca o texto da pergunta nem da resposta. Retenção de 90 dias
   aplicada a cada registro novo, dentro de `ai_request_log` (a VPS não tem pg_cron: o deploy troca a
   0003 por uma versão sem ele).
5. **Liberação por etapas** pela chave `ai_assistant` no `metric_config` (desligada por padrão):
   SUPER_ADMIN (piloto) → ADMIN/GESTOR → VENDEDOR, cada etapa com aprovação. Admin › "Assistente (IA)".

## Peças

| camada | arquivo |
|---|---|
| contrato e tipos | `src/lib/ai/contract.ts` |
| intenções (regras + sugestões por tela) | `src/lib/ai/intents.ts` |
| fatos (montagem pura, testável) | `src/lib/ai/facts-format.ts` |
| fatos (busca com a sessão do usuário) | `src/lib/ai/facts.server.ts` |
| trava de números | `src/lib/ai/verify.ts` |
| cliente do gateway (chave só no servidor) | `src/lib/ai/mag-ai.server.ts` |
| funções de servidor | `src/lib/ai.functions.ts` |
| balão | `src/components/ai/AssistantBalloon.tsx` (montado no `_shell`) |
| admin | `src/components/admin/AssistantTab.tsx` |
| banco | `drizzle/migrations/0052_assistente_mag_ai.sql` (+ rollback e suíte `verify_ai_requests.sql`) |

## Análise profunda (18/11/2026)

Segundo caminho no mesmo balão, com um **segundo modelo local de raciocínio** (DeepSeek-R1 compacto),
escolhido pelo botão "Análise profunda". Nada sai do servidor em nenhum dos dois modos.

| | Resposta rápida | Análise profunda |
|---|---|---|
| modelo | `MAG_AI_MODEL` (qwen3.5 0.8b) | `MAG_AI_MODEL_ANALISE` (deepseek-r1 1.5b) |
| tarefa no gateway | explicar / responder | `analisar` (`think: true`, contexto 4096) |
| fatos | o pacote da intenção (até 14 linhas) | pacote + tendência + ritmo + indicadores + vendedores (até 34) |
| tempo | 9 a 14 s | 1 a 2 min |
| número fora dos fatos | resposta DESCARTADA (entram os fatos) | texto MARCADO com ⚠ e aviso (status `marcada`) |
| formato | 1 a 4 frases | Leitura / Causas prováveis / O que fazer |

Por que marcar em vez de descartar: na análise o raciocínio é o produto. Descartar tudo por um
arredondamento devolveria uma ferramenta inútil; marcar deixa o texto legível e mostra exatamente o
que não foi conferido contra o BI. Os números oficiais seguem sendo os das telas.

O botão só aparece quando o gateway responde `analise: "on"` no `/v1/health` — ou seja, quando o
segundo modelo está instalado. Sem ele, a tarefa `analisar` é recusada (`task_not_allowed`) e o balão
continua só com o modo rápido.

Instalação do segundo modelo (projeto `mag-ai`, na VPS):

    bash ops/mag-ai.sh preparar-analise      # compose novo, gateway 0.2.0, tarefa liberada no apps.json
    bash ops/mag-ai.sh modelo-analise        # baixa pela rede temporária e REGISTRA o manifesto
    bash ops/mag-ai.sh subir && bash ops/mag-ai.sh testar

Para desligar só a análise profunda: tirar `MAG_AI_MODEL_ANALISE` do `/opt/mag-ai/.env` e subir o
gateway de novo. O botão desaparece; o modo rápido não é afetado.

## Limites herdados do gateway (aplicação `biomie`)

6 pedidos/min, 300/dia, 4.500 caracteres de entrada, 400 tokens de saída, 60 s de prazo, fila 2.
Modelo com contexto 2.048 → fatos limitados a 14 linhas / ~2.400 caracteres (`clampFacts`).
Tempos medidos na Fase 3: quente 9–14 s; primeiro pedido após 2 min ocioso ~45 s (a tela avisa).

## Infra e operação

- O serviço **web** entra na rede `mag-ai_biomie` e fala com `http://mag-ai:8080`. O worker não usa IA.
- `MAG_AI_URL`/`MAG_AI_KEY` vêm do `stack.env` (chave de `/srv/mag-ai/CREDENCIAIS.txt`; nunca no
  repositório). Sem elas o balão nem aparece e nada é chamado.
- `ops/21_activate_release.py` cria a rede vazia se o MAG AI não estiver instalado (o BIOMIE nunca
  deixa de subir por causa da IA).
- Operação: `ops/59_assistente.py status | env-on | env-off | flag on|off [--papeis=…]`.
- Navegador: `ops/29_smoke.py --ai [--ai-mode off|on]` (`ops/browser/assistant-smoke.cjs`).

## Desligar / voltar

- Imediato, sem deploy: `flag off` (ou Admin › Assistente) — o balão some para todos.
- Sem variáveis (`env-off`): recria só o web; o balão some.
- Release: a 0052 é só acréscimo; reativar a release anterior já basta
  (`deploy/db/rollback/0052_assistente_mag_ai.down.sql` limpa o banco se for preciso).
