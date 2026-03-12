import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export function signInWithGoogle() {
  return authClient.signIn.social({ provider: "google", callbackURL: "/login.html" });
}

export function signOut() {
  return authClient.signOut();
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) return null;
    const data: { user: AuthUser | null } = await res.json();
    return data.user ?? null;
  } catch {
    return null;
  }
}

export async function setUsername(
  username: string
): Promise<{ username?: string; error?: string }> {
  const res = await fetch("/api/auth/set-username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
  });
  return res.json();
}
