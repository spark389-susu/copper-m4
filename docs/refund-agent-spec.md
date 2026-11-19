# Copper Refund Agent: spec (draft)

Status: draft, not built yet. Nothing in the app has changed.

## Goal

Add a second agent, the **Copper Refund agent**, that handles refund requests.
It refunds automatically only in clear, low-risk cases (order under $50) and
hands everything else to a human. The original Ask Copper agent (the "support
agent") passes refund requests to it, and it can pass the customer back.

## Why a second agent

- The support agent answers questions about products, prices, and stock. It
  must never be able to move money.
- Refunds need their own rules, tools and instructions. Keeping them in a
  separate agent limits what can go wrong.

## Plain-English terms

- **Agent**: a model call with its own instructions and its own set of tools.
- **Tool**: a small piece of code the model can choose to run.
- **Handoff / transfer**: one agent passes the conversation to the other.
- **Escalation**: the agent passes the case to a real person.

## Hard rules (enforced in code, not left to the model)

1. **Refund limit: under $50.** The limit is a constant in code. The model
   never passes it in. An order of $50 or more is never refunded
   automatically.
2. **Return window: 30 days** for devices (2026 Returns Policy).
3. **A customer can only see and refund their own orders.**
4. **`issue_refund` re-checks every rule itself**, so a confused model cannot
   skip the eligibility check.
5. **One refund per order.** Asking twice must not pay twice.
6. **Step limit on handoffs** so the two agents cannot pass a customer back
   and forth forever.
7. **Every model call goes through `lib/ai/call.ts`** so it is logged to
   `ai_calls`. Every refund is also recorded.
8. If the model key is not configured, the page shows `<SetupRequired />`.

## Refund reasons

The agent asks the customer why they want a refund, then passes one reason to
the tools:

| Reason | Result |
|---|---|
| `changed_mind` (unused, inside 30 days, under $50) | `eligible`: refund automatically |
| `defective` (stopped working, manufacturing fault) | `needs_human` |
| `damaged_by_customer`, or heat damage (for example, left in a car) | `not_eligible` (a human reviews if the customer disputes it) |
| `used` or `other` | `needs_human` |
| Outside the 30-day window | `not_eligible` (a human if disputed) |
| Order of $50 or more, any reason | `needs_human` |

Why: the agent cannot see the product, only the customer's words. Anything
that depends on the product's condition goes to a person.

## Tools

### Added to the support agent

| Tool | What it does |
|---|---|
| `transfer_to_refund_agent` | Passes the customer to the refund agent, with a one-line summary of the request. |

### Copper Refund agent (six tools)

| Tool | Input | What it does |
|---|---|---|
| `get_orders` | customer | Lists that customer's orders: product, price, purchase date, status. |
| `check_refund_policy` | optional reason | Read-only. Returns the 2026 rules (30-day returns, warranty, Copper Plus refund terms, exclusions) so the agent can explain them. Decides nothing. |
| `check_refund_eligibility` | `order_id`, `reason` | Applies the hard rules and returns `eligible`, `needs_human` or `not_eligible`, plus a plain-English reason. |
| `issue_refund` | `order_id`, `reason` | Re-checks eligibility, then refunds and records it. Refuses if the answer is not `eligible`. |
| `escalate_to_human` | `order_id`, `reason`, `summary` | Creates a handoff note for a person. Used for `needs_human` cases, disputes, or upset customers. |
| `transfer_to_support_agent` | summary | Sends the customer back to the support agent. |

Left out on purpose: `check_stock`. Refunds do not depend on stock, and the
support agent already has `check_availability`.

## Data

A new `orders` table (sample data only), shaped like the existing stock data
in Supabase:

- order id, customer id, product, price (USD), purchase date
- status: `delivered`, `refunded`, `pending_review`

A refund (or escalation) is recorded so we can see who got what and why. The
exact columns will be shown for approval before anything is created.

## Where the code goes

- `lib/copper/assistant/refund-tools.ts`: the six refund tools and the rules
- Refund agent instructions and the transfer tools next to the existing
  assistant code in `lib/copper/assistant/`
- A short section added to `docs/architecture.md`
- Tests next to the existing tests (not under `specs/*/tests`)

## Tests (all must pass before this is called done)

- $49.99 order, `changed_mind`, day 10: `eligible`, refund succeeds
- $50.00 order: `needs_human` (the limit is "under $50")
- Day 31: `not_eligible`
- Each reason in the table above gives the expected result
- Asking for someone else's order is refused
- `issue_refund` refuses when the order is not eligible, even if called directly
- Refunding the same order twice is refused
- Handoff step limit stops a ping-pong between agents
- The model cannot change the $50 limit (there is no input for it)

Also: `npm test`, `npm run lint` and `npm run typecheck` pass, and
`npm run check` still passes for Module 4.

## Open questions (to settle before building)

1. The Product Bible gives warranty lengths but does not say whether a
   defective device gets a refund, a repair or a replacement. This spec sends
   `defective` to a human rather than guess.
2. Do Copper Plus subscriptions count here? The Terms say annual plans are
   refundable within 14 days and monthly plans are not refunded for partial
   months. This spec only covers devices unless we decide otherwise.
3. Existing Module 4 checks may expect exactly four tools on Ask Copper.
   Adding `transfer_to_refund_agent` could affect that. To be checked first.
4. Does "refund" really move money? For this class app it will likely just
   update the order and record the refund. That should be stated clearly in
   the UI.

## Out of scope

- Real payment processing
- Replacements or exchanges
- Changing the Product Bible (its conflicting facts are intentional)
