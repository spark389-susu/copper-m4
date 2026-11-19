// The Supabase connection, for the server only. It uses the service-role key,
// which can read and write every table, so this file must never be imported by
// a client component. Only lib/copper/orders.ts imports it, and that file is
// itself only used by server code (Server Actions, tools and server pages).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

let client: SupabaseClient | null = null;

/** The shared Supabase client. Only call it when isSupabaseConfigured() is true. */
export function supabase(): SupabaseClient {
  if (!isSupabaseConfigured())
    throw new Error(
      "Supabase isn't set up: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  return (client ??= createClient(
    process.env.SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  ));
}
