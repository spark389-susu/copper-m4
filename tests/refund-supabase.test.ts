import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for Supabase that understands just the calls orders.ts makes,
// so the Supabase code path is tested without a real database.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let nextId = 1;
let failNext: string | null = null;

function builder(table: string) {
  const filters: [string, unknown][] = [];
  let mode: "select" | "insert" | "update" | "upsert" = "select";
  let payload: Row = {};
  let order: string | null = null;
  const rows = () => (tables[table] ??= []);
  const matching = () =>
    rows().filter((r) => filters.every(([k, v]) => r[k] === v));
  const run = (): { data: unknown; error: { message: string } | null } => {
    if (failNext) {
      const message = failNext;
      failNext = null;
      return { data: null, error: { message } };
    }
    if (mode === "insert") {
      const row = {
        id: nextId++,
        created_at: new Date().toISOString(),
        ...payload,
      };
      rows().push(row);
      return { data: [row], error: null };
    }
    if (mode === "update") {
      const hit = matching();
      hit.forEach((r) => Object.assign(r, payload));
      return { data: hit, error: null };
    }
    if (mode === "upsert") {
      const existing = rows().find((r) => r.key === payload.key);
      if (existing) Object.assign(existing, payload);
      else rows().push({ ...payload });
      return { data: [payload], error: null };
    }
    const out = [...matching()];
    if (order) {
      const key = order;
      const value = (r: Row) => r[key] as string | number;
      out.sort((a, b) =>
        value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0,
      );
    }
    return { data: out, error: null };
  };
  const api = {
    select: () => api,
    insert: (row: Row) => ((mode = "insert"), (payload = row), api),
    update: (row: Row) => ((mode = "update"), (payload = row), api),
    upsert: (row: Row) => ((mode = "upsert"), (payload = row), api),
    eq: (k: string, v: unknown) => (filters.push([k, v]), api),
    order: (k: string) => ((order = k), api),
    single: () => {
      const r = run();
      return { ...r, data: (r.data as Row[] | null)?.[0] ?? null };
    },
    maybeSingle: () => {
      const r = run();
      return { ...r, data: (r.data as Row[] | null)?.[0] ?? null };
    },
    then: (resolve: (v: unknown) => void) => resolve(run()),
  };
  return api;
}

vi.mock("@/lib/copper/supabase", () => ({
  isSupabaseConfigured: () => true,
  supabase: () => ({ from: builder }),
}));

const {
  decideEscalation,
  getRefundLimit,
  readLedger,
  readOrders,
  readPending,
  setRefundLimit,
  usingSupabase,
} = await import("@/lib/copper/orders");
const { escalate, issueRefund } =
  await import("@/lib/copper/assistant/refund-tools");

const today = new Date();
const daysAgo = (n: number) =>
  new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  nextId = 1;
  failNext = null;
  tables.orders = [
    {
      order_id: "ord_1",
      customer_id: "cust_demo",
      product: "Dock",
      price_usd: "39.99",
      purchased_at: daysAgo(10),
    },
    {
      order_id: "ord_2",
      customer_id: "cust_demo",
      product: "Copper Home",
      price_usd: 149,
      purchased_at: daysAgo(12),
    },
    {
      order_id: "ord_3",
      customer_id: "cust_other",
      product: "Clip",
      price_usd: 19.99,
      purchased_at: daysAgo(2),
    },
  ];
});

describe("orders, refunds and the limit kept in Supabase", () => {
  it("is used when Supabase is configured", () => {
    expect(usingSupabase()).toBe(true);
  });
  it("reads orders with numbers, dates and a status", async () => {
    const orders = await readOrders();
    expect(orders).toHaveLength(3);
    expect(orders[0]).toMatchObject({
      order_id: "ord_1",
      price_usd: 39.99,
      status: "delivered",
    });
  });
  it("starts at $50 when no limit is saved, then keeps the manager's limit", async () => {
    expect(await getRefundLimit()).toBe(50);
    expect(await setRefundLimit("75.5")).toEqual({ ok: true, limit: 75.5 });
    expect(await getRefundLimit()).toBe(75.5);
    expect(tables.settings).toHaveLength(1);
    expect(await setRefundLimit("80")).toEqual({ ok: true, limit: 80 });
    expect(tables.settings).toHaveLength(1);
  });
  it("won't save a bad limit", async () => {
    expect((await setRefundLimit("-1")).ok).toBe(false);
    expect(tables.settings ?? []).toHaveLength(0);
  });
  it("refunds an eligible order once and writes it to the history", async () => {
    expect(
      (await issueRefund("cust_demo", "ord_1", "changed_mind")).status,
    ).toBe("refunded");
    expect(
      (await issueRefund("cust_demo", "ord_1", "changed_mind")).status,
    ).toBe("refused");
    expect(tables.refund_events).toHaveLength(1);
    expect(tables.refund_events[0]).toMatchObject({
      decision: "auto_approved",
      kind: "refund",
      amount_usd: 39.99,
    });
    expect(
      (await readOrders()).find((o) => o.order_id === "ord_1")?.status,
    ).toBe("refunded");
  });
  it("never shows another customer's order", async () => {
    expect(
      (await issueRefund("cust_demo", "ord_3", "changed_mind")).status,
    ).toBe("refused");
    expect(tables.refund_events ?? []).toHaveLength(0);
  });
  it("sends a request to a manager, who approves it once", async () => {
    expect(
      (await escalate("cust_demo", "ord_2", "defective", "Stopped working"))
        .status,
    ).toBe("escalated");
    const [pending] = await readPending();
    expect(pending).toMatchObject({ order_id: "ord_2", decision: "pending" });
    const approved = await decideEscalation(pending.id, "approved", " fine ");
    expect(approved.ok).toBe(true);
    expect(tables.refund_events[0]).toMatchObject({
      decision: "approved",
      decision_note: "fine",
      amount_usd: 149,
    });
    expect((await decideEscalation(pending.id, "denied")).ok).toBe(false);
    expect(
      (await readOrders()).find((o) => o.order_id === "ord_2")?.status,
    ).toBe("refunded");
    expect(await readPending()).toHaveLength(0);
  });
  it("lists the newest history first", async () => {
    await issueRefund("cust_demo", "ord_1", "changed_mind");
    await escalate("cust_demo", "ord_2", "defective", "Broken");
    expect((await readLedger()).map((e) => e.order_id)).toEqual([
      "ord_2",
      "ord_1",
    ]);
  });
  it("passes a database error up instead of pretending it worked", async () => {
    failNext = "relation does not exist";
    await expect(readOrders()).rejects.toThrow(
      /Supabase: relation does not exist/,
    );
  });
});
