/** Pagination proof must survive a time-boxed step and a process restart. */
export interface TxCheckpoint {
  version: 2;
  partition: number;
  page: number;
  proven: boolean[];
  expected: number | null;
  received: number;
  totalPages: number | null;
  retryAttempts?: number;
  retryAt?: string;
  /** Restarts of the current partition because Omie's pagination changed mid-read. */
  restarts?: number;
}

/** A busy company can add records while a month is paginated; re-read it at most this often. */
export const MAX_PARTITION_RESTARTS = 3;

export function emptyTxCheckpoint(): TxCheckpoint {
  return {
    version: 2,
    partition: 0,
    page: 1,
    proven: [],
    expected: null,
    received: 0,
    totalPages: null,
  };
}

export function parseTxCheckpoint(value: unknown): TxCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const cp = value as Record<string, unknown>;
  if (
    cp["version"] !== 2 ||
    !Number.isInteger(cp["partition"]) ||
    Number(cp["partition"]) < 0 ||
    !Number.isInteger(cp["page"]) ||
    Number(cp["page"]) < 1 ||
    !Number.isInteger(cp["received"]) ||
    Number(cp["received"]) < 0 ||
    !Array.isArray(cp["proven"]) ||
    !cp["proven"].every((p) => typeof p === "boolean") ||
    !(
      cp["expected"] === null ||
      (Number.isInteger(cp["expected"]) && Number(cp["expected"]) >= 0)
    ) ||
    !(
      cp["totalPages"] === null ||
      (Number.isInteger(cp["totalPages"]) && Number(cp["totalPages"]) >= 0)
    )
  )
    return null;
  return cp as unknown as TxCheckpoint;
}

export function partitionProven(cp: TxCheckpoint, page: number, totalPages: number): boolean {
  return (
    page >= totalPages &&
    cp.totalPages === totalPages &&
    (cp.expected === null || cp.received === cp.expected)
  );
}
