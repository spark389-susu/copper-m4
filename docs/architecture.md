# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability`, and (Module 3) `search_docs` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: the documents as searchable passages

**Summary:** The four PDFs in `public/docs/` are cut into short passages and
turned into embeddings (a list of numbers that stands for what a passage
means), saved in one JSON file the app loads into memory when it starts.
Ask Copper searches them with the `search_docs` tool (below).

| Piece | Where | What it does |
|---|---|---|
| Script | `scripts/embed-docs.ts` (`npm run embed-docs`) | Reads each PDF page by page, cuts each page into passages with `splitPage`, embeds them with `callEmbed`, and writes `lib/copper/data/passages.json`. Run it again when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: up to 4 sentences (about 700 characters) per passage. Every passage's text starts with its document title |
| Saved passages | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `id`, `documentId`, `title`, PDF `page` (first page is 1), `text` and a 768-number `embedding` of length 1. The file also records the model and size |
| Embedding call | `callEmbed` in `lib/ai/call.ts` | Embeds a list of texts with `gemini-embedding-001`, as `"document"` or `"query"`. Logged to `ai_calls` with no cost, because embeddings aren't in the price list |
| AI calls | `{ module: 3, feature: "embed-docs" }` | One batched call per run of the script |
| Search | `lib/copper/search-docs.ts` | `searchDocs(query)`: embeds the question with `callEmbed` (as a `"query"`), scores every passage in memory by how close its numbers are, and returns the 5 closest, each with its title, page, text, a `score` and a `url` that opens the PDF at that page (`/docs/<id>.pdf#page=N`) |
| Tool | `search_docs` in `lib/copper/assistant/tools.ts` | Takes `{ query }` (1 to 300 characters) and returns `searchDocs`'s answer. `COPPER_INSTRUCTIONS` tells Copper to use it for setup, troubleshooting, warranty and policy questions, to answer only from the passages, to end every sentence with a citation like `[Copper Home User Guide, p. 9]`, and to reply "I couldn't find that in our support docs" (and suggest the Copper Crew) when the passages don't answer |
| Tool card | `ToolOutput` in `components/copper/ask-copper.tsx` | Shows the 5 passages as numbered links, "Document title, page N", that open the PDF in a new tab, each with a short excerpt |
| AI calls | `{ module: 3, feature: "search-docs" }` | One embedding call per search, plus the usual `ask-copper` call |

Exact codes are the weak spot: a search for "C-47" finds the right page, but the
scores are nearly tied, because an embedding captures meaning rather than exact
characters.

Citations: Copper writes each source as `[Document title, p. N]`. `ReplyText` in
`components/copper/ask-copper.tsx` turns every citation of a real document into
a link that opens that PDF page. The link is built from `DOCUMENTS`, not taken
from the model, so a made-up title stays plain text and a link the model adds
itself is ignored.

## Module 4: the Copper Refund agent

**Summary:** A second agent that handles refund requests. Ask Copper (the
support agent) hands refund requests to it with `transfer_to_refund_agent`, and
the refund agent can hand the customer back with `transfer_to_support_agent`.
It refunds automatically only in clear, low-risk cases (an order under $50,
changed their mind, inside 30 days); everything else goes to a person. The
full spec is in `docs/refund-agent-spec.md`.

| Piece | Where | What it does |
|---|---|---|
| Refund tools and rules | `lib/copper/assistant/refund-tools.ts` | `get_orders`, `check_refund_policy`, `check_refund_eligibility`, `issue_refund`, `escalate_to_human`, `transfer_to_support_agent`. The $50 limit and 30-day window are constants here; `issue_refund` re-checks them itself; the customer comes from the server, never the model |
| Instructions | `lib/copper/assistant/refund-instructions.ts` | `REFUND_INSTRUCTIONS`: how the agent talks and which tool to use when |
| Handoffs | `lib/copper/assistant/agents.ts`, `ask.ts` | `askCopper()` runs one agent at a time and switches when a transfer tool is called, at most `MAX_HANDOFFS` (2) per question |
| Data | `lib/copper/orders.ts`, `lib/copper/supabase.ts`, `supabase/schema.sql` | Orders, the refund ledger and the limit. In Supabase (tables `orders`, `refund_events`, `settings`) when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set; otherwise in memory with the sample orders in `lib/copper/data/orders.json`, which resets when the server restarts. Nothing real is refunded |
| AI calls | `{ module: 4, feature: "refund-agent" }` | One streamed call per refund-agent turn, through `lib/ai/call.ts` |

### Module 4: the Support page and Refund Console

The page at `/support` has the Refund Console on the left and Ask Copper docked
on the right, so a manager can watch a refund happen. (`/manager` redirects
here.) It has no password, because the class assignment needs a grader to open
it: anyone with the link can change the limit and approve or reject requests.

| Piece | Where | What it does |
|---|---|---|
| Page | `app/support/page.tsx` | Three cards: the refund limit, requests waiting for approval (Approve / Reject), and the full refund history |
| Server Actions | `app/support/actions.ts` | `updateLimit`, `decideRefund`, and `checkRequests` (the chat uses it to look up a decision) |
| Docked chat | `components/copper/ask-copper.tsx` (`docked`), `components/copper/support/refreshing-chat.tsx` | The same chat, drawn in the page. It refreshes the console after each answer, and when a person decides a request it adds a message telling the customer (approved, or rejected with no refund) |
| Limit and ledger | `lib/copper/orders.ts` | `getRefundLimit` / `setRefundLimit` (default $50, at most $1000) and the ledger: each entry is an automatic refund or a request, later `approved` or `denied` by a manager |

The agent reads the limit from the same store, and the limit is still never a
tool input. Approving a request refunds the order at its price (a manager may
approve over the limit); rejecting it makes the agent treat the order as already
reviewed. With Supabase connected, the limit and the history are saved there;
without it they stay in memory and reset when the server restarts.

Setup for Supabase: run `supabase/schema.sql` once in the Supabase SQL Editor
(it creates the three tables, locks them with row level security so only the
server's service-role key can use them, and adds the sample orders), then set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and Vercel. The
service-role key is a secret: it is only read in `lib/copper/supabase.ts`.
