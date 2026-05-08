import { createBrowserClient } from "@supabase/ssr"
import { AUTH_COOKIE_NAME } from "./cookie-name"

// Browser hits the same origin (Next.js rewrites /auth/v1 → kong); server
// hits kong directly. The two URLs would derive different default cookie
// names, so pin the name explicitly to keep client/server in sync.
export function createClient() {
  const url =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createBrowserClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: { name: AUTH_COOKIE_NAME },
  })
}
