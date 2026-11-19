// What Ask Copper is doing, step by step, as it streams in: Gemini's thinking
// summaries, each tool call (with what went in and what came out), and the
// reply. The panel draws this as it changes.

export type ThinkingStep = { type: "thinking"; text: string };

export type ToolStep = {
  type: "tool";
  id: string;
  name: string;
  /** "calling" until the tool's result comes back. */
  state: "calling" | "done" | "error";
  input?: unknown;
  output?: unknown;
};

export type Step = ThinkingStep | ToolStep | HandoffStep;

/** Which agent is answering. Handoffs add a "handoff" step in between. */
export type HandoffStep = {
  type: "handoff";
  to: "support" | "refund";
  summary: string;
};

export type Progress = {
  steps: Step[];
  reply: string;
  status: "working" | "done" | "error";
  /** The agent that wrote the reply, and that the next question goes to. */
  agent?: "support" | "refund";
};

/** Every tool call in an answer, in order. */
export function toolCallsOf(progress: Progress) {
  return progress.steps
    .filter((step): step is ToolStep => step.type === "tool")
    .map(({ name, input, output }) => ({ name, input, output }));
}

/**
 * The tools Copper can use, and what each one does in plain English. The chat
 * panel lists these, so it lives here (and not in tools.ts, which reads the
 * database and can't be imported by a client component).
 */
export const TOOL_LABELS: Record<string, string> = {
  get_products: "Listing the products",
  get_prices: "Looking up prices",
  calculate_cost: "Working out the cost",
  check_availability: "Checking stock",
  search_docs: "Searching the documents",
  transfer_to_refund_agent: "Passing to the Refund agent",
};

/** Plain-English labels for the Copper Refund agent's tools. */
export const REFUND_TOOL_LABELS: Record<string, string> = {
  get_orders: "Looking up orders",
  check_refund_policy: "Reading the refund rules",
  check_refund_eligibility: "Checking eligibility",
  issue_refund: "Issuing the refund",
  escalate_to_human: "Passing to a person",
  transfer_to_support_agent: "Back to support",
};

/** A manager's decision (or its absence) on a request the agent passed to a person. */
export type RequestUpdate = {
  id: number;
  decision: "auto_approved" | "pending" | "approved" | "denied";
  product: string;
  amount_usd: number | null;
  note: string | null;
};
