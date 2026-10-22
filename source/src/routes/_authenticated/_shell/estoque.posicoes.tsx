import { createFileRoute } from "@tanstack/react-router";
import type { Curve } from "@/estoque/api/contract";
import { PositionsPage } from "@/estoque/pages/PositionsPage";

const CURVES: readonly string[] = ["A", "B", "C", "D", "U"];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DAYS = [30, 90, 180, 365] as const;

export interface PositionsSearch {
  curve?: Curve | undefined;
  onlyNegative?: boolean | undefined;
  belowMin?: boolean | undefined;
  productId?: string | undefined;
  view?: "position" | "product" | undefined;
  minDaysWithoutSale?: (typeof DAYS)[number] | undefined;
  onlyNew?: boolean | undefined;
  onlyIncomplete?: boolean | undefined;
  onlyConfirmed?: boolean | undefined;
  soldElsewhere?: boolean | undefined;
  onlyManual?: boolean | undefined;
}

const flag = (v: unknown) => (v === true ? true : undefined);

export const Route = createFileRoute("/_authenticated/_shell/estoque/posicoes")({
  validateSearch: (search: Record<string, unknown>): PositionsSearch => ({
    curve:
      typeof search["curve"] === "string" && CURVES.includes(search["curve"])
        ? (search["curve"] as Curve)
        : undefined,
    onlyNegative: flag(search["onlyNegative"]),
    belowMin: flag(search["belowMin"]),
    productId:
      typeof search["productId"] === "string" && UUID.test(search["productId"])
        ? search["productId"]
        : undefined,
    view:
      search["view"] === "product" || search["view"] === "position" ? search["view"] : undefined,
    minDaysWithoutSale: DAYS.find((d) => d === search["minDaysWithoutSale"]),
    onlyNew: flag(search["onlyNew"]),
    onlyIncomplete: flag(search["onlyIncomplete"]),
    onlyConfirmed: flag(search["onlyConfirmed"]),
    soldElsewhere: flag(search["soldElsewhere"]),
    onlyManual: flag(search["onlyManual"]),
  }),
  component: PositionsPage,
});
