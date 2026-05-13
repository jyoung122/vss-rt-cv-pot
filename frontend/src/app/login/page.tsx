"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const expired = searchParams.get("expired") === "1"
  const next = searchParams.get("next") || "/"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setLoading(true)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)

    if (error) {
      setErr(error.message)
      return
    }

    router.push(next)
    router.refresh()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-1)]">
      <Card className="w-full max-w-sm border-[var(--border)] bg-[var(--surface-2)] shadow-lg">
        <CardHeader className="pb-4">
          <div className="mb-4 flex justify-center">
            <img src="/brand/aims-logo-light.png" alt="AIMS" className="h-20 w-auto" />
          </div>
          <CardTitle className="text-center text-[var(--fg-1)]">Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          {expired && (
            <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--warn-500)]/40 bg-[var(--warn-500)]/10 px-3 py-2 text-sm text-[var(--warn-500)]">
              Session expired — please sign in again.
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              type="email"
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-[var(--surface-1)] text-[var(--fg-1)] placeholder:text-[var(--fg-3)] border-[var(--border)]"
            />
            <Input
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-[var(--surface-1)] text-[var(--fg-1)] placeholder:text-[var(--fg-3)] border-[var(--border)]"
            />
            {err && (
              <p className="text-sm text-[var(--err-500)]">{err}</p>
            )}
            <Button
              type="submit"
              disabled={loading}
              className="bg-[var(--accent-500)] text-white hover:bg-[var(--accent-500)]/90"
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-center text-sm text-[var(--fg-3)]">
              Don&apos;t have an account?{" "}
              <Link href="/signup" className="text-[var(--accent-500)] hover:underline">
                Create one
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
