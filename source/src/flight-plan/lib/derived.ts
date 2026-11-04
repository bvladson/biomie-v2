/**
 * Única conversão de exibição feita fora da API: referência mensal ÷ dias úteis.
 * Mantida aqui (não no componente) para o contrato fixo não precisar mudar.
 */
export const perWorkday = (amount: number, workdays: number) =>
  workdays > 0 ? Math.round((amount / workdays) * 100) / 100 : null;
