import { beforeEach, describe, expect, it } from "vitest";
import {
  checkEligibility,
  escalate,
  evaluateRefund,
  issueRefund,
} from "@/lib/copper/assistant/refund-tools";
import {
  DEFAULT_REFUND_LIMIT_USD,
  DEMO_CUSTOMER_ID,
  decideEscalation,
  getRefundLimit,
  readLedger,
  readOrders,
  readPending,
  resetLedger,
  setRefundLimit,
} from "@/lib/copper/orders";

const NOW = new Date(2026, 10, 17, 12, 0, 0);
const status = async (id: string) =>
  (await readOrders(NOW)).find((o) => o.order_id === id)?.status;

beforeEach(() => resetLedger());

describe("the refund limit a manager can change", () => {
  it("starts at $50 and can be changed", async () => {
    expect(await getRefundLimit()).toBe(DEFAULT_REFUND_LIMIT_USD);
    expect(await setRefundLimit("75")).toEqual({ ok: true, limit: 75 });
    expect(await getRefundLimit()).toBe(75);
  });
  it("rejects values that make no sense and keeps the old limit", async () => {
    for (const bad of ["", "abc", "0", "-5", "1000.01", "NaN", "Infinity"])
      expect((await setRefundLimit(bad)).ok, bad).toBe(false);
    expect(await getRefundLimit()).toBe(50);
  });
  it("rounds to cents", async () => {
    expect(await setRefundLimit("49.999")).toEqual({ ok: true, limit: 50 });
    expect(await setRefundLimit("20.126")).toEqual({ ok: true, limit: 20.13 });
  });
  it("changes what the agent refunds on its own", async () => {
    // ord_1006 is $50.00 and ord_1005 is $49.99.
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
    await setRefundLimit("60");
    expect(
      (
        await checkEligibility(
          DEMO_CUSTOMER_ID,
          "ord_1006",
          "changed_mind",
          NOW,
        )
      ).result,
    ).toBe("eligible");
    await setRefundLimit("49.99");
    expect(
      (
        await checkEligibility(
          DEMO_CUSTOMER_ID,
          "ord_1005",
          "changed_mind",
          NOW,
        )
      ).result,
    ).toBe("needs_human");
  });
  it("issue_refund follows the new limit too", async () => {
    await setRefundLimit("40");
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1005", "changed_mind", NOW))
        .status,
    ).toBe("refused");
    await setRefundLimit("50");
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1005", "changed_mind", NOW))
        .status,
    ).toBe("refunded");
  });
});

describe("approving and denying requests", () => {
  async function escalated() {
    await escalate(
      DEMO_CUSTOMER_ID,
      "ord_1003",
      "defective",
      "Stopped working",
      NOW,
    );
    return (await readPending())[0];
  }
  it("shows a request waiting for a manager", async () => {
    const entry = await escalated();
    expect(entry).toMatchObject({ order_id: "ord_1003", decision: "pending" });
    expect(await status("ord_1003")).toBe("pending_review");
  });
  it("approving refunds the order at its price", async () => {
    const entry = await escalated();
    const result = await decideEscalation(
      entry.id,
      "approved",
      "Fine, it's broken",
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(await status("ord_1003")).toBe("refunded");
    expect((await readLedger())[0]).toMatchObject({
      decision: "approved",
      amount_usd: 149,
      decision_note: "Fine, it's broken",
    });
    expect(await readPending()).toHaveLength(0);
  });
  it("denying closes it, and the agent can no longer refund it", async () => {
    const entry = await escalated();
    await decideEscalation(entry.id, "denied", "", NOW);
    expect(await status("ord_1003")).toBe("refund_denied");
    expect(
      evaluateRefund(
        (await readOrders(NOW)).find((o) => o.order_id === "ord_1003")!,
        "changed_mind",
        NOW,
      ).result,
    ).toBe("not_eligible");
    expect(
      (await issueRefund(DEMO_CUSTOMER_ID, "ord_1003", "changed_mind", NOW))
        .status,
    ).toBe("refused");
  });
  it("a request can only be decided once", async () => {
    const entry = await escalated();
    expect((await decideEscalation(entry.id, "approved", "", NOW)).ok).toBe(
      true,
    );
    expect((await decideEscalation(entry.id, "denied", "", NOW)).ok).toBe(
      false,
    );
    expect(await status("ord_1003")).toBe("refunded");
  });
  it("the same order isn't sent to a person twice", async () => {
    await escalated();
    const again = await escalate(
      DEMO_CUSTOMER_ID,
      "ord_1003",
      "defective",
      "Again",
      NOW,
    );
    expect(again.status).toBe("refused");
    expect(await readPending()).toHaveLength(1);
  });
  it("history lists automatic refunds and requests, newest first", async () => {
    await issueRefund(DEMO_CUSTOMER_ID, "ord_1001", "changed_mind", NOW);
    await escalate(DEMO_CUSTOMER_ID, "ord_1003", "defective", "Broken", NOW);
    expect((await readLedger()).map((e) => [e.order_id, e.decision])).toEqual([
      ["ord_1003", "pending"],
      ["ord_1001", "auto_approved"],
    ]);
  });
  it("an unknown request can't be decided", async () => {
    expect((await decideEscalation(999, "approved", "", NOW)).ok).toBe(false);
  });
});
