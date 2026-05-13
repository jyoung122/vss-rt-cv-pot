// Wraps fetch with 401 handling: redirect to /login?expired=1 so the user
// sees an explicit "session expired" message instead of a generic error.
// Use for any client-side /api/* call. Server-side routes are gated by middleware.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401 && typeof window !== "undefined") {
    const here = window.location.pathname + window.location.search
    window.location.href = `/login?expired=1&next=${encodeURIComponent(here)}`
  }
  return res
}
