"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import {
  canHandOff,
  TRANSFER_TOOLS,
  transferOf,
  type AgentName,
  type Transfer,
} from "@/lib/copper/assistant/agents";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type { Progress, ToolStep } from "@/lib/copper/assistant/progress";
import { REFUND_INSTRUCTIONS } from "@/lib/copper/assistant/refund-instructions";
import { createRefundTools } from "@/lib/copper/assistant/refund-tools";
import { copperTools } from "@/lib/copper/assistant/tools";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** Which agent the conversation is with. Starts as "support". */
  agent?: AgentName;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

const SORRY = "Sorry, something went wrong on my end. Please try again.";
const LOOP =
  "Sorry, I couldn't finish passing you along. Please contact the Copper Crew.";

export async function askCopper({
  messages,
  useTools,
  agent = "support",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  let current: AgentName = useTools ? agent : "support";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: current,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  // One streamed model call for the agent that has the conversation. Returns
  // the handoff it asked for, if any.
  async function runAgent(summary: string): Promise<Transfer | null> {
    let transfer: Transfer | null = null;
    // Without tools, send no instructions either: "always use your tools"
    // with no tools makes the model answer with nothing.
    const refund = current === "refund";
    const result = callStream(
      refund
        ? { module: 4, feature: "refund-agent" }
        : { module: 2, feature: "ask-copper" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        ...(useTools && {
          instructions: refund
            ? summary
              ? `${REFUND_INSTRUCTIONS}\n\nThe support agent passed this customer to you: ${summary}`
              : REFUND_INSTRUCTIONS
            : summary
              ? `${COPPER_INSTRUCTIONS}\n\nThe refund agent passed this customer back to you: ${summary}`
              : COPPER_INSTRUCTIONS,
          tools: refund ? createRefundTools() : copperTools,
          // A transfer ends this agent's turn: the other agent writes the reply.
          stopWhen: [
            stepCountIs(MAX_STEPS),
            ...Object.keys(TRANSFER_TOOLS).map((name) => hasToolCall(name)),
          ],
        }),
      },
    );

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          transfer ??= transferOf(part.toolName, part.output);
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return transfer;
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      let handoffs = 0;
      let summary = "";
      for (;;) {
        const transfer = await runAgent(summary);
        if (!transfer) break;
        if (!canHandOff(handoffs)) {
          // Too many handoffs in one question: stop instead of ping-ponging.
          progress.reply = LOOP;
          break;
        }
        handoffs++;
        current = transfer.to;
        summary = transfer.summary;
        progress.agent = current;
        // Whatever the first agent wrote before passing the customer on is
        // dropped: the new agent writes the reply.
        progress.reply = "";
        progress.steps.push({
          type: "handoff",
          to: transfer.to,
          summary: transfer.summary,
        });
        update(snapshot());
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}
