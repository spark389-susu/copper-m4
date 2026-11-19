import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { decideRefund } from "@/app/support/actions";
import { RefreshingChat } from "@/components/copper/support/refreshing-chat";
import { LimitForm } from "@/components/copper/support/limit-form";
import { Logo } from "@/components/copper/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/copper/catalog";
import { isAiConfigured } from "@/lib/ai/call";
import {
  getLimitUpdatedAt,
  getRefundLimit,
  readLedger,
  readOrders,
  readPending,
  usingSupabase,
  type Decision,
  type LedgerEntry,
} from "@/lib/copper/orders";

export const metadata: Metadata = {
  title: "Support | Copper State Labs",
  description: "Refund Console and Ask Copper.",
};

export default function SupportPage() {
  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <header className="bg-background border-b">
        <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="Copper State Labs home">
            <Logo className="w-32 sm:w-40" />
          </Link>
          <p className="text-muted-foreground text-sm font-semibold">Support</p>
        </div>
      </header>
      <div className="grid flex-1 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <main className="bg-secondary/40 space-y-6 px-4 py-6 sm:px-6 lg:overflow-y-auto">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <ConsoleContent />
          </Suspense>
        </main>
        <aside
          aria-label="Ask Copper"
          className="h-[36rem] border-t lg:h-auto lg:min-h-0 lg:border-t-0 lg:border-l"
        >
          <RefreshingChat aiConfigured={isAiConfigured()} />
        </aside>
      </div>
    </div>
  );
}

async function ConsoleContent() {
  await connection();
  try {
    return await Dashboard();
  } catch {
    return <DataUnavailable />;
  }
}

function DataUnavailable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Couldn&apos;t load the refund data</CardTitle>
        <CardDescription>
          The app couldn&apos;t reach Supabase. Check that the tables exist (
          <code>supabase/schema.sql</code>) and that <code>SUPABASE_URL</code>{" "}
          and <code>SUPABASE_SERVICE_ROLE_KEY</code> are right, then reload.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

const time = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});
const when = (iso: string) => `${time.format(new Date(iso))} UTC`;

const REASONS: Record<string, string> = {
  changed_mind: "Changed their mind",
  defective: "Defective",
  damaged_by_customer: "Damaged by customer",
  used: "Used",
  other: "Other",
};

function DecisionBadge({ decision }: { decision: Decision }) {
  switch (decision) {
    case "auto_approved":
      return <Badge className="bg-accent text-white">Auto-refunded</Badge>;
    case "approved":
      return <Badge className="bg-accent text-white">Approved</Badge>;
    case "denied":
      return <Badge className="bg-chart-3 text-white">Rejected</Badge>;
    default:
      return <Badge className="bg-chart-4 text-chart-5">Waiting</Badge>;
  }
}

async function Dashboard() {
  const [limit, updated, pending, history, orderList] = await Promise.all([
    getRefundLimit(),
    getLimitUpdatedAt(),
    readPending(),
    readLedger(),
    readOrders(),
  ]);
  const orders = new Map(orderList.map((order) => [order.order_id, order]));
  const refunded = history.filter(
    (e) => e.decision === "auto_approved" || e.decision === "approved",
  );
  const refundedTotal = refunded.reduce(
    (sum, e) => sum + (e.amount_usd ?? 0),
    0,
  );

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold">Refund Console</h1>
          <p className="text-muted-foreground text-sm">
            {refunded.length} refunded ({formatUsd(refundedTotal)}) ·{" "}
            {pending.length} waiting for you
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Refund limit</CardTitle>
          <CardDescription>
            The Copper Refund agent refunds automatically only orders under this
            amount (and only when the customer changed their mind, inside 30
            days). Everything else comes to you below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            Right now:{" "}
            <span className="text-primary text-2xl font-bold">
              {formatUsd(limit)}
            </span>
            <span className="text-muted-foreground ml-2">
              {updated ? `changed ${when(updated)}` : "(the starting value)"}
            </span>
          </p>
          <LimitForm current={limit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <CardDescription>
            Requests the agent passed to a person. Approve refunds the order and
            tells the customer in the chat; Reject keeps the money and tells the
            customer no.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing is waiting. New requests show up here.
            </p>
          ) : (
            <ul className="space-y-4">
              {pending.map((entry) => (
                <PendingRequest
                  key={entry.id}
                  entry={entry}
                  product={orders.get(entry.order_id)?.product}
                  price={orders.get(entry.order_id)?.price_usd}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Refund history</CardTitle>
          <CardDescription>
            Every refund and every request, newest first.{" "}
            {usingSupabase()
              ? "Saved in Supabase."
              : "Supabase isn't connected, so this is kept in memory and clears when the server restarts."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No refunds yet. Ask Copper for one and it shows up here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((entry) => {
                  const order = orders.get(entry.order_id);
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap">
                        {when(entry.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{order?.product}</div>
                        <div className="text-muted-foreground font-mono text-xs">
                          {entry.order_id}
                        </div>
                      </TableCell>
                      <TableCell>
                        {REASONS[entry.reason] ?? entry.reason}
                      </TableCell>
                      <TableCell>
                        <DecisionBadge decision={entry.decision} />
                        {entry.decided_at &&
                          entry.decision !== "auto_approved" && (
                            <div className="text-muted-foreground mt-1 text-xs">
                              {when(entry.decided_at)}
                            </div>
                          )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {entry.amount_usd === null
                          ? "—"
                          : formatUsd(entry.amount_usd)}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-64 text-xs whitespace-normal">
                        {[
                          entry.note,
                          entry.decision_note &&
                            `Manager: ${entry.decision_note}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PendingRequest({
  entry,
  product,
  price,
}: {
  entry: LedgerEntry;
  product?: string;
  price?: number;
}) {
  return (
    <li
      data-testid="pending-request"
      className="bg-card space-y-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          {product}{" "}
          <span className="text-muted-foreground font-mono text-xs">
            {entry.order_id}
          </span>
        </p>
        <p className="font-mono">
          {price === undefined ? "" : formatUsd(price)}
        </p>
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">Reason: </span>
        {REASONS[entry.reason] ?? entry.reason}
        <span className="text-muted-foreground"> · asked </span>
        {when(entry.created_at)}
      </p>
      <p className="text-muted-foreground text-sm">{entry.note}</p>
      <form action={decideRefund} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={entry.id} />
        <Input
          name="note"
          maxLength={300}
          placeholder="Optional note"
          aria-label="Optional note"
          className="max-w-64 flex-1"
        />
        <Button type="submit" name="decision" value="approved">
          Approve
        </Button>
        <Button type="submit" name="decision" value="denied" variant="outline">
          Reject
        </Button>
      </form>
    </li>
  );
}
