import { createClient, type User } from "@supabase/supabase-js";
import type { Env } from "./types";

export async function requireUser(
  request: Request,
  env: Env
): Promise<User> {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  if (!token) {
    throw new Error("Missing bearer token.");
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw new Error("Authentication failed.");
  }

  return data.user;
}

export function getRequestMeta(request: Request) {
  return {
    ipAddress:
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for") ??
      "unknown",
    userAgent: request.headers.get("user-agent") ?? "unknown"
  };
}
