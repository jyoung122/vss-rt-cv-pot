import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { NextRequest, NextResponse } from "next/server"
import { AUTH_COOKIE_NAME } from "./cookie-name"

type CookieEntry = { name: string; value: string; options?: CookieOptions }

export async function updateSession(request: NextRequest) {
  // Start with a plain passthrough response; the cookie helpers will mutate it.
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: CookieEntry[]) {
          // Write refreshed session cookies onto both the forwarded request and
          // the outbound response so the browser and server stay in sync.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options ?? {}),
          )
        },
      },
    },
  )

  // getUser() validates the JWT with Supabase and refreshes the session.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return { supabase, user, response }
}
