"use client";

import { useActionState } from "react";
import { updateLimit } from "@/app/support/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

export function LimitForm({ current }: { current: number }) {
  const [state, action, pending] = useActionState(updateLimit, null);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="refund-limit">New refund limit (USD)</Label>
        <div className="flex gap-2">
          <Input
            id="refund-limit"
            name="limit"
            type="number"
            inputMode="decimal"
            min="0.01"
            max="1000"
            step="0.01"
            defaultValue={current}
            required
            className="max-w-40"
          />
          <Button type="submit" disabled={pending}>
            {pending && <Spinner className="size-4" />} Save limit
          </Button>
        </div>
      </div>
      {state && (
        <p
          role="status"
          className={state.ok ? "text-accent text-sm" : "text-chart-3 text-sm"}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
