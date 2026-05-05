import { NextRequest, NextResponse } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

const PUBLIC_PATHS = ["/login", "/signup"]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export async function middleware(request: NextRequest) {
  const { user, response, supabase } = await updateSession(request)

  const { pathname } = request.nextUrl

  // Redirect unauthenticated users to login for any protected route.
  if (!user && !isPublic(pathname)) {
    return NextResponse.redirect(new URL("/login", request.url))
  }

  // For authenticated API/WebSocket proxy requests, attach the access token so
  // the FastAPI backend (which validates Supabase JWTs) can authorize the call.
  if (user && (pathname.startsWith("/api/") || pathname.startsWith("/ws/"))) {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (session?.access_token) {
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set("Authorization", `Bearer ${session.access_token}`)
      return NextResponse.next({ request: { headers: requestHeaders } })
    }
  }

  return response
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|brand/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
