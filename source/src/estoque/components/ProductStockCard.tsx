import { useCapabilities } from "../lib/hooks";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { stockApi } from "../api";
import type { CompanyFilter } from "../api/contract";
import { CurveBadge, Status } from "./shared";
import { money, quantity } from "../lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
export function ProductStockCard({
  productId,
  companyId,
}: {
  productId: string;
  companyId: CompanyFilter;
}) {
  const caps = useCapabilities();
  const q = useQuery({
    queryKey: ["stock", "product", companyId, productId],
    queryFn: () =>
      stockApi.positions({ companyId, productId, page: 0, sortBy: "name", sortDir: "asc" }),
    retry: false,
  });
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap justify-between gap-3 p-5">
        <h2 className="text-lg font-semibold">Estoque por local</h2>
        <Link
          to="/estoque/posicoes"
          search={(prev) => ({ ...prev, productId })}
          className="text-sm text-primary underline"
        >
          Abrir posições →
        </Link>
      </div>
      <div className="px-5">
        <Status
          loading={q.isPending || caps.isPending}
          error={q.error || caps.error}
          retry={() => {
            q.refetch();
            caps.refetch();
          }}
        />
      </div>
      {q.data && caps.data && (
        <Table className="min-w-[600px]">
          <TableHeader>
            <TableRow>
              <TableHead>Local</TableHead>
              <TableHead>Físico</TableHead>
              <TableHead>Reservado</TableHead>
              <TableHead>Pendente</TableHead>
              {caps.data.viewCost && (
                <>
                  <TableHead>CMC</TableHead>
                  <TableHead>Valor a custo</TableHead>
                </>
              )}
              <TableHead>Curva</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.locationName ?? p.locationCode}</TableCell>
                <TableCell>{quantity(p.physicalQty)}</TableCell>
                <TableCell>{quantity(p.reservedQty)}</TableCell>
                <TableCell>{quantity(p.pendingQty)}</TableCell>
                {caps.data?.viewCost && (
                  <>
                    <TableCell>{money(p.unitCost)}</TableCell>
                    <TableCell>{money(p.costValue)}</TableCell>
                  </>
                )}
                <TableCell>
                  <CurveBadge curve={p.curve} />
                </TableCell>
              </TableRow>
            ))}
            {q.data.total === 0 && (
              <TableRow>
                <TableCell colSpan={7}>A primeira leitura do estoque ainda não terminou</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
