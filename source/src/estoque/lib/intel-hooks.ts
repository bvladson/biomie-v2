/** Ganchos da Inteligência do Estoque compartilhados entre as telas. */
import { useQueryClient } from "@tanstack/react-query";

/** Recarrega o detalhe do produto e as listas de alertas depois de uma ciência. */
export function useAlertRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ["stock", "intel", "product"] });
    void client.invalidateQueries({ queryKey: ["stock", "intel", "alerts"] });
  };
}
