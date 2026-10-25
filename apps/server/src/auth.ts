import type { FastifyRequest } from "fastify";

/**
 * Who is calling: a signed-in Supabase user (Google) or a guest.
 * Google users send `Authorization: Bearer <supabase access token>`, which we
 * verify with Supabase. Guests send `X-Guest-Id` (random id the browser keeps).
 */
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export const authConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const tokenCache = new Map<string, { userId: string; expires: number }>();

async function verifySupabaseToken(token: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.userId;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  if (!user.id) return null;
  tokenCache.set(token, { userId: user.id, expires: Date.now() + 5 * 60_000 });
  return user.id;
}

export type Identity = { key: string; kind: "user" | "guest" };

export async function identify(req: FastifyRequest): Promise<Identity | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const userId = await verifySupabaseToken(auth.slice(7));
    return userId ? { key: `u:${userId}`, kind: "user" } : null;
  }
  const guest = req.headers["x-guest-id"];
  if (typeof guest === "string" && /^[A-Za-z0-9-]{8,64}$/.test(guest)) {
    return { key: `g:${guest}`, kind: "guest" };
  }
  return null;
}
