import { beforeEach, describe, expect, it } from "vitest";
import {
  canHandOff,
  MAX_HANDOFFS,
  transferOf,
} from "@/lib/copper/assistant/agents";
import { copperTools } from "@/lib/copper/assistant/tools";
import {
  checkEligibility,
  createRefundTools,
  escalate,
  evaluateRefund,
  getOrdersFor,
  issueRefund,
  REFUND_LIMIT_USD,
  REFUND_REASONS,
  type RefundReason,
} from "@/lib/copper/assistant/refund-tools";
import {
  DEMO_CUSTOMER_ID,
  readLedger,
  readOrders,
  resetLedger,
  type Order,
} from "@/lib/copper/orders";

const NOW = new Date(2026, 10, 17, 12, 0, 0);

function order(
  price: number,
  daysAgo: number,
  status: Order["status"] = "delivered",
): Order {
  const bought = new Date(
    NOW.getFullYear(),
    NOW.getMonth(),
    NOW.getDate() - daysAgo,
  );
  return {
    order_id: "ord_test",
    customer_id: DEMO_CUSTOMER_ID,
    product: "Test accessory",
    price_usd: price,
    purchase_date: bought.toISOString().slice(0, 10),
    status,
  };
}

beforeEach(() => resetLedger());

describe("refund eligibility rules", () => {
  it("$49.99, changed_mind, day 10: eligible", async () => {
    expect(evaluateRefund(order(49.99, 10), "changed_mind", NOW).result).toBe(
      "eligible",
    );
  });
  it("$50.00 needs a human: the limit is 'under $50'", async () => {
    expect(evaluateRefund(order(50, 1), "changed_mind", NOW).result).toBe(
      "needs_human",
    );
  });
  it("day 30 is inside the window, day 31 is not", async () => {
    expect(evaluateRefund(order(20, 30), "changed_mind", NOW).result).toBe(
      "eligible",
    );
    expect(evaluateRefund(order(20, 31), "changed_mind", NOW).result).toBe(
      "not_eligible",
    );
  });
  it("gives the expected result for each reason", async () => {
    const expected: Record<RefundReason, string> = {
      changed_mind: "eligible",
      defective: "needs_human",
      damaged_by_customer: "not_eligible",
      used: "needs_human",
      other: "needs_human",
    };
    for (const reason of REFUND_REASONS)
      expect(evaluateRefund(order(20, 5), reason, NOW).result, reason).toBe(
        expected[reason],
      );
  });
  it("any reason on an order of $50 or more goes to a human", async () => {
    for (const reason of REFUND_REASONS)
      expect(evaluateRefund(order(149, 5), reason, NOW).result, reason).toBe(
        "needs_human",
      );
  });
  it("an order already refunded is not eligible", async () => {
    expect(
      evaluateRefund(order(20, 5, "refunded"), "changed_mind", NOW).result,
    ).toBe("not_eligible");
  });
});

describe("refund tools", () => {
  it("only show and refund the customer's own orders", async () => {
    const ids = (await getOrdersFor(DEMO_CUSTOMER_ID, NOW)).orders.map(
      (o) => o.order_id,
    );
    expect(ids).toContain("ord_1001");
    expect(ids).not.toContain("ord_2001");
    expect(
      (
        await checkEligibility(
          DEMO_CUSTOMER_ID,
          "ord_2001",
          "changed_mind",
          NOW,
        )
      ).result,
    ).toBe("not_found");
    const refused = await issueRefund(
      DEMO_CUSTOMER_ID,
      "ord_2001",
      "changed_mind",
      NOW,
    );
    expect(refused.status).toBe("refused");
    expect(await readLedger()).toHaveLength(0);
  });
  it("issue_refund refuses when the order is not eligible, even if called directly", async () => {
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1003", "changed_mind", NOW))
        .status,
    ).toBe("refused"); // $149
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1002", "changed_mind", NOW))
        .status,
    ).toBe("refused"); // day 45
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1001", "defective", NOW))
        .status,
    ).toBe("refused");
    expect(await readLedger()).toHaveLength(0);
  });
  it("refunds an eligible order once, never twice", async () => {
    const first = await issueRefund(
      DEMO_CUSTOMER_ID,
      "ord_1001",
      "changed_mind",
      NOW,
    );
    expect(first).toMatchObject({ status: "refunded", amount_usd: 39.99 });
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1001", "changed_mind", NOW))
        .status,
    ).toBe("refused");
    expect(await readLedger()).toHaveLength(1);
    expect(
      (await readOrders(NOW)).find((o) => o.order_id === "ord_1001")?.status,
    ).toBe("refunded");
  });
  it("escalating records a note and marks the order pending_review", async () => {
    expect(
      (
        await escalate(
          DEMO_CUSTOMER_ID,
          "ord_1003",
          "defective",
          "Stopped working",
          NOW,
        )
      ).status,
    ).toBe("escalated");
    expect(
      (await readOrders(NOW)).find((o) => o.order_id === "ord_1003")?.status,
    ).toBe("pending_review");
  });
  it("the sample 49.99 and 50.00 orders hit the limit exactly", async () => {
    expect(
      (
        await checkEligibility(
          DEMO_CUSTOMER_ID,
          "ord_1005",
          "changed_mind",
          NOW,
        )
      ).result,
    ).toBe("eligible");
    expect(
      (
        await checkEligibility(
          DEMO_CUSTOMER_ID,
          "ord_1006",
          "changed_mind",
          NOW,
        )
      ).result,
    ).toBe("needs_human");
  });
  it("the model cannot change the limit: no tool takes one", async () => {
    expect(REFUND_LIMIT_USD).toBe(50);
    const tools = createRefundTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        "check_refund_eligibility",
        "check_refund_policy",
        "escalate_to_human",
        "get_orders",
        "get_orders",
        "issue_refund",
        "transfer_to_support_agent",
      ]
        .filter((n, i, a) => a.indexOf(n) === i)
        .sort(),
    );
    for (const [name, t] of Object.entries(tools)) {
      const fields = Object.keys(
        (t.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
      );
      for (const field of fields)
        expect(field, name).not.toMatch(/limit|amount|customer/i);
    }
  });
});

describe("handoffs", () => {
  it("the support agent can pass to refunds but cannot refund", async () => {
    expect(Object.keys(copperTools)).toContain("transfer_to_refund_agent");
    expect(Object.keys(copperTools)).not.toContain("issue_refund");
  });
  it("stops a ping-pong between the agents", async () => {
    let handoffs = 0;
    while (canHandOff(handoffs)) handoffs++;
    expect(handoffs).toBe(MAX_HANDOFFS);
    expect(canHandOff(MAX_HANDOFFS)).toBe(false);
  });
  it("reads a transfer from a tool result", async () => {
    expect(
      transferOf("transfer_to_refund_agent", {
        transferred: true,
        to: "refund",
        summary: "wants a refund",
      }),
    ).toMatchObject({ to: "refund", summary: "wants a refund" });
    expect(transferOf("get_orders", { transferred: true })).toBeNull();
    expect(transferOf("transfer_to_support_agent", { orders: [] })).toBeNull();
  });
});
