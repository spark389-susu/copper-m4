// Orders, the refund ledger and the refund limit for the Copper Refund agent
// and the manager page. This is the only file that knows where they are kept.
//
// With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, they live in Supabase
// (tables in supabase/schema.sql), so they survive restarts and deploys.
// Without them, they live in memory with the sample orders in
// data/orders.json: fine for trying things out, but everything resets when the
// server restarts.
import data from "./data/orders.json";
import { isSupabaseConfigured, supabase } from "./supabase";

export type OrderStatus =
  "delivered" | "refunded" | "pending_review" | "refund_denied";

export type Order = {
  order_id: string;
  customer_id: string;
  product: string;
  price_usd: number;
  /** ISO date (YYYY-MM-DD). */
  purchase_date: string;
  status: OrderStatus;
};

/** The shopper using the chat. There is no login, so the server decides who they are. */
export const DEMO_CUSTOMER_ID = "cust_demo";

/** The refund limit until a manager changes it. */
export const DEFAULT_REFUND_LIMIT_USD = 50;
/** The most a manager can set the limit to. */
export const MAX_REFUND_LIMIT_USD = 1000;

/**
 * auto_approved: the agent refunded it by the rules. pending: sent to a person.
 * approved / denied: a manager decided.
 */
export type Decision = "auto_approved" | "pending" | "approved" | "denied";

export type LedgerEntry = {
  id: number;
  order_id: string;
  customer_id: string;
  kind: "refund" | "escalation";
  reason: string;
  note: string;
  amount_usd: number | null;
  decision: Decision;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
};

type NewEntry = Pick<
  LedgerEntry,
  "order_id" | "customer_id" | "reason" | "note"
>;

export type DecideResult =
  { ok: true; entry: LedgerEntry } | { ok: false; message: string };

export type LimitResult =
  { ok: true; limit: number } | { ok: false; message: string };

/** Where things are kept. There is a memory one and a Supabase one. */
type Backend = {
  baseOrders(now: Date): Promise<Omit<Order, "status">[]>;
  entries(): Promise<LedgerEntry[]>; // oldest first
  insert(entry: Omit<LedgerEntry, "id" | "created_at">): Promise<LedgerEntry>;
  decide(
    id: number,
    decision: "approved" | "denied",
    note: string | null,
    amount: number | null,
  ): Promise<LedgerEntry | null>; // null: not pending (or doesn't exist)
  getLimit(): Promise<{ limit: number; updatedAt: string | null }>;
  setLimit(limit: number): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

// ---------------------------------------------------------------- memory

type MemoryStore = {
  entries: LedgerEntry[];
  limit: number;
  limitUpdatedAt: string | null;
};

// On globalThis so every page and Server Action on one server shares it.
const globalStore = globalThis as { __copperRefundStore?: MemoryStore };

function memoryStore(): MemoryStore {
  return (globalStore.__copperRefundStore ??= {
    entries: [],
    limit: DEFAULT_REFUND_LIMIT_USD,
    limitUpdatedAt: null,
  });
}

const memory: Backend = {
  async baseOrders(now) {
    return data.orders.map((row) => ({
      order_id: row.order_id,
      customer_id: row.customer_id,
      product: row.product,
      price_usd: row.price_usd,
      purchase_date: isoDate(new Date(now.getTime() - row.days_ago * DAY_MS)),
    }));
  },
  async entries() {
    return structuredClone(memoryStore().entries);
  },
  async insert(entry) {
    const s = memoryStore();
    const full: LedgerEntry = {
      ...entry,
      id: s.entries.length + 1,
      created_at: new Date().toISOString(),
    };
    s.entries.push(full);
    return structuredClone(full);
  },
  async decide(id, decision, note, amount) {
    const entry = memoryStore().entries.find((e) => e.id === id);
    if (!entry || entry.decision !== "pending") return null;
    entry.decision = decision;
    entry.decision_note = note;
    entry.decided_at = new Date().toISOString();
    if (amount !== null) entry.amount_usd = amount;
    return structuredClone(entry);
  },
  async getLimit() {
    const s = memoryStore();
    return { limit: s.limit, updatedAt: s.limitUpdatedAt };
  },
  async setLimit(limit) {
    const s = memoryStore();
    s.limit = limit;
    s.limitUpdatedAt = new Date().toISOString();
  },
};

// -------------------------------------------------------------- supabase

type Row = Record<string, unknown>;

function check<T>(result: {
  data: T | null;
  error: { message: string } | null;
}) {
  if (result.error) throw new Error(`Supabase: ${result.error.message}`);
  return result.data as T;
}

const toEntry = (row: Row): LedgerEntry => ({
  id: Number(row.id),
  order_id: String(row.order_id),
  customer_id: String(row.customer_id),
  kind: row.kind as LedgerEntry["kind"],
  reason: String(row.reason),
  note: String(row.note ?? ""),
  amount_usd: row.amount_usd === null ? null : Number(row.amount_usd),
  decision: row.decision as Decision,
  decision_note: (row.decision_note as string | null) ?? null,
  decided_at: (row.decided_at as string | null) ?? null,
  created_at: String(row.created_at),
});

const remote: Backend = {
  async baseOrders() {
    const rows = check<Row[]>(
      await supabase().from("orders").select("*").order("order_id"),
    );
    return rows.map((row) => ({
      order_id: String(row.order_id),
      customer_id: String(row.customer_id),
      product: String(row.product),
      price_usd: Number(row.price_usd),
      purchase_date: String(row.purchased_at),
    }));
  },
  async entries() {
    const rows = check<Row[]>(
      await supabase().from("refund_events").select("*").order("id"),
    );
    return rows.map(toEntry);
  },
  async insert(entry) {
    const row = check<Row>(
      await supabase().from("refund_events").insert(entry).select().single(),
    );
    return toEntry(row);
  },
  async decide(id, decision, note, amount) {
    const update: Row = {
      decision,
      decision_note: note,
      decided_at: new Date().toISOString(),
    };
    if (amount !== null) update.amount_usd = amount;
    // Only a request that is still pending can be decided, so two managers
    // clicking at once can't both win.
    const rows = check<Row[]>(
      await supabase()
        .from("refund_events")
        .update(update)
        .eq("id", id)
        .eq("decision", "pending")
        .select(),
    );
    return rows.length ? toEntry(rows[0]) : null;
  },
  async getLimit() {
    const row = check<Row | null>(
      await supabase()
        .from("settings")
        .select("value, updated_at")
        .eq("key", "refund_limit_usd")
        .maybeSingle(),
    );
    const limit = Number(row?.value);
    return {
      limit:
        Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_REFUND_LIMIT_USD,
      updatedAt: (row?.updated_at as string | undefined) ?? null,
    };
  },
  async setLimit(limit) {
    check(
      await supabase()
        .from("settings")
        .upsert({
          key: "refund_limit_usd",
          value: String(limit),
          updated_at: new Date().toISOString(),
        })
        .select(),
    );
  },
};

const backend = (): Backend => (isSupabaseConfigured() ? remote : memory);

/** True when orders, refunds and the limit are kept in Supabase. */
export function usingSupabase(): boolean {
  return isSupabaseConfigured();
}

// ------------------------------------------------------------- the API

/** An order's status follows the latest thing that happened to it. */
function statusFrom(entry: LedgerEntry | undefined): OrderStatus {
  if (!entry) return "delivered";
  if (entry.decision === "pending") return "pending_review";
  if (entry.decision === "denied") return "refund_denied";
  return "refunded";
}

/** Every order, with its status changed by any refund or decision so far. */
export async function readOrders(now = new Date()): Promise<Order[]> {
  const b = backend();
  const [orders, entries] = await Promise.all([b.baseOrders(now), b.entries()]);
  return orders.map((order) => ({
    ...order,
    status: statusFrom(entries.findLast((e) => e.order_id === order.order_id)),
  }));
}

/** The limit: orders of this much or more are never refunded automatically. */
export async function getRefundLimit(): Promise<number> {
  return (await backend().getLimit()).limit;
}

export async function getLimitUpdatedAt(): Promise<string | null> {
  return (await backend().getLimit()).updatedAt;
}

/** Sets the refund limit (a manager's choice, never the model's). */
export async function setRefundLimit(value: unknown): Promise<LimitResult> {
  const number =
    typeof value === "string" ? Number(value.trim()) : Number(value);
  if (value === "" || value === null || !Number.isFinite(number))
    return { ok: false, message: "Enter a number, like 50." };
  const limit = Math.round(number * 100) / 100;
  if (limit <= 0)
    return { ok: false, message: "The limit must be more than $0." };
  if (limit > MAX_REFUND_LIMIT_USD)
    return {
      ok: false,
      message: `The limit can't be more than $${MAX_REFUND_LIMIT_USD}.`,
    };
  await backend().setLimit(limit);
  return { ok: true, limit };
}

async function add(
  entry: Omit<
    LedgerEntry,
    "id" | "created_at" | "decision_note" | "decided_at"
  >,
) {
  const full = await backend().insert({
    ...entry,
    decision_note: null,
    decided_at:
      entry.decision === "auto_approved" ? new Date().toISOString() : null,
  });
  console.info("[refunds]", JSON.stringify(full));
  return full;
}

/** The agent refunded an order by the rules. */
export function recordRefund(entry: NewEntry & { amount_usd: number }) {
  return add({ ...entry, kind: "refund", decision: "auto_approved" });
}

/** The agent passed a request to a person. */
export function recordEscalation(entry: NewEntry) {
  return add({
    ...entry,
    kind: "escalation",
    amount_usd: null,
    decision: "pending",
  });
}

/** A manager approves or denies a request waiting for a person. */
export async function decideEscalation(
  id: number,
  decision: "approved" | "denied",
  note = "",
  now = new Date(),
): Promise<DecideResult> {
  const b = backend();
  const entry = (await b.entries()).find((e) => e.id === id);
  if (!entry) return { ok: false, message: "That request no longer exists." };
  if (entry.decision !== "pending")
    return { ok: false, message: "Someone already decided this request." };
  const order = (await readOrders(now)).find(
    (o) => o.order_id === entry.order_id,
  );
  const amount = decision === "approved" ? (order?.price_usd ?? null) : null;
  const decided = await b.decide(id, decision, note.trim() || null, amount);
  if (!decided)
    return { ok: false, message: "Someone already decided this request." };
  console.info("[refunds]", JSON.stringify(decided));
  return { ok: true, entry: decided };
}

/** Every refund and request, newest first. */
export async function readLedger(): Promise<LedgerEntry[]> {
  return (await backend().entries()).reverse();
}

/** Requests waiting for a manager, oldest first. */
export async function readPending(): Promise<LedgerEntry[]> {
  return (await backend().entries()).filter((e) => e.decision === "pending");
}

/** For tests: forget every in-memory refund and request, and put the limit back. */
export function resetLedger() {
  globalStore.__copperRefundStore = undefined;
}
