// Shared between browser and server clients so they read/write the same cookie.
// Without this, the default cookie name is derived from the supabase URL —
// browser uses window.location.origin, server uses kong:8000, names diverge.
export const AUTH_COOKIE_NAME = "sb-aims-auth-token"
