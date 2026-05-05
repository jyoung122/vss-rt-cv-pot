"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setInfo(null)
    setLoading(true)

    const supabase = createClient()
    const { data, error } = await supabase.auth.signUp({ email, password })

    setLoading(false)

    if (error) {
      setErr(error.message)
      return
    }

    if (data.session) {
      router.push("/")
      router.refresh()
      return
    }

    setInfo("Check your email to confirm your account, then sign in.")
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-1)]">
      <Card className="w-full max-w-sm border-[var(--border)] bg-[var(--surface-2)] shadow-lg">
        <CardHeader className="pb-4">
          <div className="mb-4 flex justify-center">
            <img src="/brand/aims-logo.png" alt="AIMS" className="h-20 w-auto" />
          </div>
          <CardTitle className="text-center text-[var(--fg-1)]">Create account</CardTitle>
        </CardHeader>
        <CardContent>
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
              placeholder="Password (8+ chars)"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-[var(--surface-1)] text-[var(--fg-1)] placeholder:text-[var(--fg-3)] border-[var(--border)]"
            />
            {err && <p className="text-sm text-[var(--err-500)]">{err}</p>}
            {info && <p className="text-sm text-[var(--ok-500)]">{info}</p>}
            <Button
              type="submit"
              disabled={loading}
              className="bg-[var(--accent-500)] text-white hover:bg-[var(--accent-500)]/90"
            >
              {loading ? "Creating account…" : "Create account"}
            </Button>
            <p className="text-center text-sm text-[var(--fg-3)]">
              Already have an account?{" "}
              <Link href="/login" className="text-[var(--accent-500)] hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
