import Link from 'next/link'
import { Button } from '@/components/ui/button'

type CTABlockProps = {
  headline: string
  subhead?: string
  primaryCta?: {
    label?: string
    href?: string
  }
  secondaryCta?: {
    label?: string
    href?: string
  }
  tone?: 'accent' | 'navy' | 'surface' | string
}

const TONE_BG: Record<string, string> = {
  accent: 'bg-[var(--accent-500)]',
  navy: 'bg-[var(--navy-800)]',
  surface: 'bg-[var(--surface-2)]',
}

const TONE_TEXT: Record<string, string> = {
  accent: 'text-[var(--ink-0)]',
  navy: 'text-[var(--fg-1)]',
  surface: 'text-[var(--fg-1)]',
}

export default function CTABlock({
  headline,
  subhead,
  primaryCta,
  secondaryCta,
  tone = 'accent',
}: CTABlockProps) {
  const bg = TONE_BG[tone] ?? TONE_BG.accent
  const textColor = TONE_TEXT[tone] ?? TONE_TEXT.accent

  return (
    <section className={`w-full ${bg} py-16 px-6`}>
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
        <h2 className={`font-heading text-3xl font-bold ${textColor}`}>{headline}</h2>
        {subhead && (
          <p className={`max-w-xl text-base leading-relaxed opacity-80 ${textColor}`}>
            {subhead}
          </p>
        )}
        {(primaryCta?.label || secondaryCta?.label) && (
          <div className="flex flex-wrap items-center justify-center gap-4">
            {primaryCta?.label && primaryCta?.href && (
              <Button
                asChild
                variant="default"
                size="lg"
                className="bg-[var(--surface-1)] text-[var(--fg-1)] hover:bg-[var(--surface-2)]"
              >
                <Link href={primaryCta.href}>{primaryCta.label}</Link>
              </Button>
            )}
            {secondaryCta?.label && secondaryCta?.href && (
              <Button
                asChild
                variant="outline"
                size="lg"
                className="border-[var(--ink-0)] text-[var(--ink-0)] hover:bg-[var(--ink-0)]/10"
              >
                <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
