// Which agent is talking, and the rules for passing the customer between them.
// Kept apart from ask.ts (a Server Action file can only export async functions).

export type AgentName = "support" | "refund";

/** Most handoffs in one question, so the agents can't pass a customer back and forth forever. */
export const MAX_HANDOFFS = 2;

export function canHandOff(handoffsSoFar: number): boolean {
  return handoffsSoFar < MAX_HANDOFFS;
}

/** Each transfer tool and the agent it sends the customer to. */
export const TRANSFER_TOOLS: Record<string, AgentName> = {
  transfer_to_refund_agent: "refund",
  transfer_to_support_agent: "support",
};

export type Transfer = { transferred: true; to: AgentName; summary: string };

/** The handoff a tool result asks for, or `null` if it isn't one. */
export function transferOf(toolName: string, output: unknown): Transfer | null {
  const to = TRANSFER_TOOLS[toolName];
  const result = output as Partial<Transfer> | null;
  if (!to || !result || result.transferred !== true) return null;
  return {
    transferred: true,
    to,
    summary: typeof result.summary === "string" ? result.summary : "",
  };
}
