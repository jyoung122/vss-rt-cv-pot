import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--fg-1)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface-1)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center">
            <Image
              src="/brand/aims-logo.png"
              alt="AIMS"
              width={140}
              height={40}
              priority
              className="h-10 w-auto"
            />
          </Link>
          <nav className="flex items-center gap-1">
            <Button asChild variant="ghost" className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">
              <Link href="/docs">Docs</Link>
            </Button>
            <Button asChild variant="ghost" className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">
              <Link href="/login">Sign in</Link>
            </Button>
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 bg-[var(--bg)] text-[var(--fg-1)]">
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-[var(--surface-1)]">
        <Separator className="bg-[var(--border)]" />
        <div className="mx-auto max-w-6xl px-6 py-6">
          <p className="text-sm text-[var(--fg-3)]">© AIMS by Synch Solutions</p>
        </div>
      </footer>
    </div>
  )
}
