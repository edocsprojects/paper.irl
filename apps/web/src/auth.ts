import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Google sign-in through Supabase Auth (free tier).
 * Needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in the repo-root .env;
 * without them the app runs guest-only.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const authReady = supabase !== null;

let session: Session | null = null;

export interface GoogleUser {
  id: string;
  name: string | null;
  photo: string | null;
}

function toUser(s: Session | null): GoogleUser | null {
  if (!s) return null;
  const meta = s.user.user_metadata as Record<string, unknown>;
  return {
    id: s.user.id,
    name: (meta.full_name as string) ?? (meta.name as string) ?? null,
    photo: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
  };
}

/** Resolve the current session (also completes the OAuth redirect). */
export async function initAuth(onChange: (user: GoogleUser | null) => void) {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((_event, s) => {
    session = s;
    onChange(toUser(s));
  });
  return toUser(session);
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error("auth_not_configured");
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  session = null;
  await supabase?.auth.signOut();
}

export function accessToken(): string | null {
  return session?.access_token ?? null;
}
