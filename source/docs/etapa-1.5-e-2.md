# Etapa 1.5 (hardening) e Etapa 2 (Vendas + Vendedor 360)

## Lint — erro remanescente em arquivo protegido
- Arquivo: `src/integrations/supabase/previewAuthStorage.ts` (linha 54)
- Regra: `prefer-const` ('timer' is never reassigned)
- Origem: arquivo gerado automaticamente pela plataforma (integração de autenticação do preview).
- Motivo de não correção: é regenerado pela plataforma; edições manuais são descartadas e é proibido editá-lo.
- Não pertence ao código da aplicação. Todo o restante de `src/` passa no lint sem erros (apenas avisos de fast-refresh em componentes de UI gerados).

## Recuperação de senha
- Envio real de e-mail depende do serviço de e-mail de autenticação da plataforma (sem domínio próprio configurado = remetente padrão, com limite de envio).
- Testado: solicitação para e-mail inexistente responde OK sem revelar se a conta existe; link expirado/já usado mostra "Link inválido ou expirado" com caminho para novo pedido.
- Links de recuperação são de uso único e expiram (comportamento do serviço de autenticação).
- Não testado ponta a ponta: clique no link real e troca de senha — o projeto ainda não tem nenhuma conta, e a plataforma bloqueia a criação de contas de teste por chave administrativa.

## Logout
- Botão "Sair" cancela consultas, limpa o cache, encerra a sessão e redireciona para /auth; páginas protegidas não são renderizadas no servidor e revalidam a sessão ao abrir (voltar no navegador redireciona para /auth).
- Não testado pela interface nesta etapa pelo mesmo motivo (nenhuma conta existente).

## Snapshot diário
- pg_cron `biomie-flight-plan-snapshots` às 08:15 UTC (05:15 Brasília) chama a rota do job na URL estável do preview. Após publicar, trocar para a URL de produção.
- Idempotente (substitui empresa+data; índice único empresa+vendedor+data). Execuções em `job_runs`, visíveis em Administração → Jobs.
- Limitação: reprocessar data passada usa a carteira atual (não há histórico de pedidos).

## Limitações conhecidas
- Notas demo têm só data de competência (Data = Competência).
- Cockpit ainda usa a Meta Ativa (nível ACTIVE) fixa; Plano de Voo, Vendas e Vendedor 360 usam o nível escolhido em Administração.
- Equipes (escopo GESTOR) ainda não existem.
