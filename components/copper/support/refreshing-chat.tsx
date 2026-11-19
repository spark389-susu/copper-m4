"use client";

// Ask Copper, docked on the Support page. It refreshes the Refund Console after
// every answer and every decision, so the console and the chat stay in step.
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { checkRequests } from "@/app/support/actions";
import { AskCopper } from "@/components/copper/ask-copper";

export function RefreshingChat({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  return (
    <AskCopper
      docked
      aiConfigured={aiConfigured}
      onActivity={refresh}
      checkRequests={checkRequests}
    />
  );
}
