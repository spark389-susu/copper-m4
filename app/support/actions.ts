"use server";

// The Refund Console's Server Actions: change the limit, approve or reject a
// request, and let the chat look up whether a person has decided yet.
import { revalidatePath } from "next/cache";
import type { RequestUpdate } from "@/lib/copper/assistant/progress";
import {
  decideEscalation,
  readLedger,
  readOrders,
  setRefundLimit,
} from "@/lib/copper/orders";

export type FormState = { message: string; ok: boolean } | null;

export async function updateLimit(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let result;
  try {
    result = await setRefundLimit(formData.get("limit"));
  } catch {
    return { ok: false, message: "Couldn't save the limit. Please try again." };
  }
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/support");
  return {
    ok: true,
    message: `Saved. Orders under $${result.limit} can now be refunded automatically.`,
  };
}

/** Approve or Reject a request the Refund agent passed to a person. */
export async function decideRefund(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const decision = formData.get("decision");
  if (
    !Number.isInteger(id) ||
    (decision !== "approved" && decision !== "denied")
  )
    return;
  await decideEscalation(
    id,
    decision,
    String(formData.get("note") ?? "").slice(0, 300),
  );
  revalidatePath("/support");
}

/** Where the requests the chat is waiting on stand now. */
export async function checkRequests(ids: number[]): Promise<RequestUpdate[]> {
  const wanted = ids
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 20);
  if (wanted.length === 0) return [];
  const [ledger, orders] = await Promise.all([readLedger(), readOrders()]);
  return ledger
    .filter((entry) => wanted.includes(entry.id))
    .map((entry) => ({
      id: entry.id,
      decision: entry.decision,
      product:
        orders.find((o) => o.order_id === entry.order_id)?.product ?? "order",
      amount_usd: entry.amount_usd,
      note: entry.decision_note,
    }));
}
