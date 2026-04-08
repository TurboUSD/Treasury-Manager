import { createClient } from "@supabase/supabase-js";

// ── Supabase client (server-side — uses service_role for writes) ─────────
// Set these in .env.local (and Vercel env vars for production):
//   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ...
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

/**
 * Server-side Supabase client (service_role) — used in API routes for writes.
 * Bypasses RLS.
 */
export function getSupabaseAdmin() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing SUPABASE env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Public Supabase client (anon key) — used client-side for reads only.
 */
export function getSupabasePublic() {
  if (!supabaseUrl || !anonKey) {
    throw new Error("Missing SUPABASE env vars (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)");
  }
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}
