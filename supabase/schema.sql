-- Copper Refund agent: tables for orders, refund history and settings.
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- It is safe to run more than once: it never overwrites existing rows.
--
-- The tables are locked: row level security is on and there are no policies,
-- so the browser (anon / authenticated keys) can't read or write them. Only the
-- server, using the service-role key, can.

create table if not exists public.orders (
  order_id     text primary key,
  customer_id  text not null,
  product      text not null,
  price_usd    numeric(10, 2) not null check (price_usd >= 0),
  purchased_at date not null,
  status       text not null default 'delivered'
    check (status in ('delivered', 'refunded', 'pending_review', 'refund_denied'))
);

-- One row for every automatic refund and every request sent to a person.
-- An order's current status follows its latest row.
create table if not exists public.refund_events (
  id            bigint generated always as identity primary key,
  order_id      text not null references public.orders (order_id),
  customer_id   text not null,
  kind          text not null check (kind in ('refund', 'escalation')),
  reason        text not null,
  note          text not null default '',
  amount_usd    numeric(10, 2),
  decision      text not null
    check (decision in ('auto_approved', 'pending', 'approved', 'denied')),
  decision_note text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists refund_events_order_idx
  on public.refund_events (order_id, id);

-- Settings a manager can change, such as the refund limit.
create table if not exists public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;
alter table public.refund_events enable row level security;
alter table public.settings enable row level security;

revoke all on public.orders, public.refund_events, public.settings
  from anon, authenticated;

-- Sample data. Purchase dates are relative to the day you run this, so the
-- 30-day return window behaves like the demo: run it again on a new day (after
-- deleting the old orders) to refresh the dates.
insert into public.orders (order_id, customer_id, product, price_usd, purchased_at)
values
  ('ord_1001', 'cust_demo',  'Copper Home Charging Dock', 39.99,  current_date - 10),
  ('ord_1002', 'cust_demo',  'Copper Notes Clip Pack',    24.99,  current_date - 45),
  ('ord_1003', 'cust_demo',  'Copper Home',               149.00, current_date - 12),
  ('ord_1004', 'cust_demo',  'Copper Notes',              129.00, current_date - 40),
  ('ord_1005', 'cust_demo',  'Copper Notes Carry Sleeve', 49.99,  current_date - 5),
  ('ord_1006', 'cust_demo',  'Copper Home Wall Mount',    50.00,  current_date - 3),
  ('ord_2001', 'cust_other', 'Copper Notes Clip Pack',    19.99,  current_date - 2)
on conflict (order_id) do nothing;

insert into public.settings (key, value)
values ('refund_limit_usd', '50')
on conflict (key) do nothing;
