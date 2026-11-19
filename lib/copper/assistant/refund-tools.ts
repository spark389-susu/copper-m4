// The Copper Refund agent's tools and the rules behind them. The rules live
// here, in code, and not in the model's instructions: the model can ask, but
// it can never raise the limit, skip the check or see someone else's orders.
import { tool } from "ai";
import { z } from "zod";
import {
  DEFAULT_REFUND_LIMIT_USD,
  DEMO_CUSTOMER_ID,
  getRefundLimit,
  readOrders,
  recordEscalation,
  recordRefund,
  type Order,
} from "@/lib/copper/orders";

/**
 * Orders of this much or more are never refunded automatically. This is the
 * starting value: a manager can change it on the manager page. It is never a
 * tool input, so the model can't change it.
 */
export const REFUND_LIMIT_USD = DEFAULT_REFUND_LIMIT_USD;

const usd = (amount: number) =>
  Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
/** Return window for devices (2026 Returns Policy). */
export const RETURN_WINDOW_DAYS = 30;

export const REFUND_REASONS = [
  "changed_mind",
  "defective",
  "damaged_by_customer",
  "used",
  "other",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export type Eligibility = {
  result: "eligible" | "needs_human" | "not_eligible";
  reason: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between the purchase and `now`. */
export function daysSince(purchaseDate: string, now = new Date()): number {
  const bought = new Date(`${purchaseDate}T00:00:00Z`).getTime();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - bought) / DAY_MS);
}

/** The hard rules. Pure: the same order, reason and day always give the same answer. */
export function evaluateRefund(
  order: Order,
  reason: RefundReason,
  now = new Date(),
  limit = DEFAULT_REFUND_LIMIT_USD,
): Eligibility {
  if (order.status === "refund_denied")
    return {
      result: "not_eligible",
      reason: "A person already reviewed this order and denied the refund.",
    };
  if (order.status === "refunded")
    return {
      result: "not_eligible",
      reason: "This order was already refunded.",
    };
  if (order.status === "pending_review")
    return {
      result: "needs_human",
      reason: "This order is already waiting for a person to review it.",
    };
  if (order.price_usd >= limit)
    return {
      result: "needs_human",
      reason: `Orders of ${usd(limit)} or more need a person to approve the refund.`,
    };
  if (reason === "damaged_by_customer")
    return {
      result: "not_eligible",
      reason:
        "Damage caused by the customer, including heat damage such as leaving a device in a car, is not covered. A person can review it if the customer disagrees.",
    };
  if (daysSince(order.purchase_date, now) > RETURN_WINDOW_DAYS)
    return {
      result: "not_eligible",
      reason: `The ${RETURN_WINDOW_DAYS}-day return window has passed. A person can review it if the customer disagrees.`,
    };
  if (reason === "changed_mind")
    return {
      result: "eligible",
      reason: `Inside the ${RETURN_WINDOW_DAYS}-day window and under ${usd(limit)}.`,
    };
  return {
    result: "needs_human",
    reason:
      "The agent can't see the product, so a person has to confirm what the customer describes.",
  };
}

export type RefundOutcome =
  | { status: "refunded"; order_id: string; amount_usd: number }
  | { status: "refused"; order_id: string; reason: string };

export type OrderLookup =
  { found: true; order: Order } | { found: false; message: string };

async function lookup(
  customerId: string,
  orderId: string,
  now: Date,
): Promise<OrderLookup> {
  // Only this customer's orders are visible. Someone else's order looks
  // exactly like one that doesn't exist.
  const order = (await readOrders(now)).find(
    (o) => o.order_id === orderId && o.customer_id === customerId,
  );
  return order
    ? { found: true, order }
    : { found: false, message: `No order ${orderId} found for this customer.` };
}

export async function getOrdersFor(customerId: string, now = new Date()) {
  return {
    orders: (await readOrders(now))
      .filter((o) => o.customer_id === customerId)
      .map(({ order_id, product, price_usd, purchase_date, status }) => ({
        order_id,
        product,
        price_usd,
        purchase_date,
        status,
      })),
  };
}

export async function checkEligibility(
  customerId: string,
  orderId: string,
  reason: RefundReason,
  now = new Date(),
): Promise<
  | (Eligibility & { order_id: string })
  | { result: "not_found"; message: string }
> {
  const found = await lookup(customerId, orderId, now);
  if (!found.found) return { result: "not_found", message: found.message };
  const limit = await getRefundLimit();
  return {
    order_id: orderId,
    ...evaluateRefund(found.order, reason, now, limit),
  };
}

/** Re-checks every rule itself, so it never relies on the model having called check_refund_eligibility. */
export async function issueRefund(
  customerId: string,
  orderId: string,
  reason: RefundReason,
  now = new Date(),
): Promise<RefundOutcome> {
  const found = await lookup(customerId, orderId, now);
  if (!found.found)
    return { status: "refused", order_id: orderId, reason: found.message };
  const check = evaluateRefund(
    found.order,
    reason,
    now,
    await getRefundLimit(),
  );
  if (check.result !== "eligible")
    return { status: "refused", order_id: orderId, reason: check.reason };
  // The sample app doesn't move real money: it marks the order refunded and
  // records it. Once recorded, the order's status is "refunded", so a second
  // request is refused by the check above (one refund per order).
  await recordRefund({
    order_id: orderId,
    customer_id: customerId,
    reason,
    note: check.reason,
    amount_usd: found.order.price_usd,
  });
  return {
    status: "refunded",
    order_id: orderId,
    amount_usd: found.order.price_usd,
  };
}

export async function escalate(
  customerId: string,
  orderId: string,
  reason: RefundReason,
  summary: string,
  now = new Date(),
) {
  const found = await lookup(customerId, orderId, now);
  if (!found.found)
    return { status: "refused" as const, message: found.message };
  if (found.order.status !== "delivered")
    return {
      status: "refused" as const,
      message:
        found.order.status === "pending_review"
          ? "This order is already waiting for a person to review it."
          : found.order.status === "refunded"
            ? "This order was already refunded."
            : "A person already reviewed this order and denied the refund.",
    };
  const request = await recordEscalation({
    order_id: orderId,
    customer_id: customerId,
    reason,
    note: summary,
  });
  return {
    status: "escalated" as const,
    order_id: orderId,
    request_id: request.id,
    message: "A person on the Copper Crew will review this and follow up.",
  };
}

/** check_refund_policy: read-only. Explains the rules, decides nothing. */
export async function refundPolicy() {
  return {
    devices: `30-day return window for devices (2026 Returns Policy).`,
    warranty:
      "Copper Home: 2 years. Copper Notes: 1 year. Manufacturing defects only; excludes heat damage from leaving devices in vehicles.",
    copper_plus:
      "Cancel anytime. Monthly plans are not refunded for partial months. Annual plans are refundable within 14 days.",
    automatic_refunds: `The agent refunds automatically only when a customer changed their mind, inside the ${RETURN_WINDOW_DAYS}-day window, on an order under ${usd(await getRefundLimit())}. Everything else goes to a person.`,
    note: "This describes the rules. It does not decide anything: use check_refund_eligibility for an order.",
  };
}

const reason = z.enum(REFUND_REASONS);
const orderId = z.string().trim().min(1).max(40);

export const eligibilityInput = z
  .object({ order_id: orderId, reason })
  .strict();
export const escalateInput = z
  .object({
    order_id: orderId,
    reason,
    summary: z.string().trim().min(1).max(500),
  })
  .strict();
export const transferToSupportInput = z
  .object({ summary: z.string().trim().min(1).max(300) })
  .strict();

/**
 * The refund agent's six tools. `customerId` comes from the server, never from
 * the model, so the model can't ask about anyone else.
 */
export function createRefundTools(customerId = DEMO_CUSTOMER_ID) {
  return {
    get_orders: tool({
      description:
        "Lists this customer's orders: order id, product, price, purchase date and status.",
      inputSchema: z.object({}).strict(),
      execute: async () => getOrdersFor(customerId),
    }),
    check_refund_policy: tool({
      description:
        "Read-only. Returns the 2026 refund rules (30-day returns, warranty, Copper Plus refund terms, exclusions) so you can explain them. It decides nothing.",
      inputSchema: z.object({ reason: reason.optional() }).strict(),
      execute: async () => refundPolicy(),
    }),
    check_refund_eligibility: tool({
      description:
        "Applies the hard refund rules to one order and returns eligible, needs_human or not_eligible, with a plain-English reason. Always call it before issue_refund.",
      inputSchema: eligibilityInput,
      execute: async (input) =>
        checkEligibility(customerId, input.order_id, input.reason),
    }),
    issue_refund: tool({
      description:
        "Refunds one order, but only if the rules allow it (it re-checks them itself). Refuses otherwise. Only call it after check_refund_eligibility says eligible.",
      inputSchema: eligibilityInput,
      execute: async (input) =>
        issueRefund(customerId, input.order_id, input.reason),
    }),
    escalate_to_human: tool({
      description:
        "Creates a handoff note for a person on the Copper Crew. Use it for needs_human cases, disputes and upset customers.",
      inputSchema: escalateInput,
      execute: async (input) =>
        escalate(customerId, input.order_id, input.reason, input.summary),
    }),
    transfer_to_support_agent: tool({
      description:
        "Sends the customer back to the Copper support agent for questions that are not about a refund. Give a one-line summary.",
      inputSchema: transferToSupportInput,
      execute: async ({ summary }) => ({
        transferred: true as const,
        to: "support" as const,
        summary,
      }),
    }),
  };
}
