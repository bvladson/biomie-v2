import { createFileRoute } from "@tanstack/react-router";
import type { Curve } from "@/estoque/api/contract";
import { PositionsPage } from "@/estoque/pages/PositionsPage";

const CURVES: readonly string[] = ["A", "B", "C", "D", "U"];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface PositionsSearch {
  curve?: Curve | undefined;
  onlyNegative?: boolean | undefined;
  belowMin?: boolean | undefined;
  productId?: string | undefined;
}

export const Route = createFileRoute("/_authenticated/_shell/estoque/posicoes")({
  validateSearch: (search: Record<string, unknown>): PositionsSearch => ({
    curve:
      typeof search["curve"] === "string" && CURVES.includes(search["curve"])
        ? (search["curve"] as Curve)
        : undefined,
    onlyNegative: search["onlyNegative"] === true ? true : undefined,
    belowMin: search["belowMin"] === true ? true : undefined,
    productId:
      typeof search["productId"] === "string" && UUID.test(search["productId"])
        ? search["productId"]
        : undefined,
  }),
  component: PositionsPage,
});
