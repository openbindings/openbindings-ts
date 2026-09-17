/** Process-wide work counters for this installation. Counts are work, never time. */
export type ForcingReason =
  | "export"
  | "string-operation"
  | "schema-constraint"
  | "diagnostic"
  | "compatibility-executor"
  | "persistence"
  | "transport";

export interface Costs {
  readonly nodesRead: number;
  readonly treesBuilt: number;
  readonly bytesCopied: number;
  readonly encodes: number;
  readonly bytesEncoded: number;
  readonly serializations: number;
  readonly forcing: Readonly<Record<ForcingReason, number>>;
}

/** The mutable record behind `counters()`. Module-private to this installation. */
export const work: { -readonly [K in Exclude<keyof Costs, "forcing">]: number } & { forcing: Record<ForcingReason, number> } = {
  nodesRead: 0,
  treesBuilt: 0,
  bytesCopied: 0,
  encodes: 0,
  bytesEncoded: 0,
  serializations: 0,
  forcing: { export: 0, "string-operation": 0, "schema-constraint": 0, diagnostic: 0, "compatibility-executor": 0, persistence: 0, transport: 0 },
};

export function isForcingReason(reason: unknown): reason is ForcingReason {
  return typeof reason === "string" && Object.hasOwn(work.forcing, reason);
}

/** A frozen snapshot of the counters since load. Monotonic; never reset. */
export function counters(): Costs {
  return Object.freeze({
    nodesRead: work.nodesRead,
    treesBuilt: work.treesBuilt,
    bytesCopied: work.bytesCopied,
    encodes: work.encodes,
    bytesEncoded: work.bytesEncoded,
    serializations: work.serializations,
    forcing: Object.freeze({ ...work.forcing }),
  });
}

/** A synchronous work scope. Never retains its owner across a promise/await. */
type MutableCosts = { -readonly [K in Exclude<keyof Costs, "forcing">]: number } & { forcing: Record<ForcingReason, number> };
let owner: MutableCosts | undefined;
export function charge(key: Exclude<keyof Costs, "forcing">, amount = 1): void {
  work[key] += amount;
  if (owner) owner[key] += amount;
}
export function chargeForcing(reason: ForcingReason, amount: number): void {
  work.forcing[reason] += amount;
  if (owner) owner.forcing[reason] += amount;
}
export function unaccounted<T>(operation: () => T): T {
  const previous = owner;
  owner = undefined;
  try { return operation(); } finally { owner = previous; }
}
export function accounting() {
  const total: MutableCosts = { nodesRead:0, treesBuilt:0, bytesCopied:0, encodes:0, bytesEncoded:0, serializations:0,
    forcing:{ export:0, "string-operation":0, "schema-constraint":0, diagnostic:0, "compatibility-executor":0, persistence:0, transport:0 } };
  return Object.freeze({
    around<T>(operation: () => T): T {
      const previous = owner;
      owner = total;
      try { return operation(); } finally { owner = previous; }
    },
    snapshot(): Costs { return Object.freeze({ ...total, forcing:Object.freeze({ ...total.forcing }) }); },
  });
}
