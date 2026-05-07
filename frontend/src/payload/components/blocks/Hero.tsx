import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

type MediaValue = {
  url?: string
  alt?: string
  width?: number
  height?: number
}

type HeroBlockProps = {
  eyebrow?: string
  headline: string
  subhead?: string
  cta?: {
    label?: string
    href?: string
  }
  image?: MediaValue | string | null
  align?: 'left' | 'center'
}

export default function HeroBlock({
  eyebrow,
  headline,
  subhead,
  cta,
  image,
  align = 'center',
}: HeroBlockProps) {
  const alignClass = align === 'left' ? 'items-start text-left' : 'items-center text-center'
  const mediaObj = image && typeof image === 'object' ? image : null

  return (
    <section className="w-full bg-[var(--surface-1)] py-20 px-6">
      <div className={`mx-auto flex max-w-4xl flex-col gap-6 ${alignClass}`}>
        {eyebrow && (
          <span className="text-sm font-semibold uppercase tracking-widest text-[var(--accent-500)]">
            {eyebrow}
          </span>
        )}
        <h1 className="font-heading text-4xl font-bold leading-tight text-[var(--fg-1)] md:text-5xl lg:text-6xl">
          {headline}
        </h1>
        {subhead && (
          <p className="max-w-2xl text-lg leading-relaxed text-[var(--fg-2)]">{subhead}</p>
        )}
        {cta?.label && cta?.href && (
          <Button
            asChild
            size="lg"
            className="mt-2 bg-[var(--accent-500)] text-[var(--ink-0)] hover:bg-[var(--accent-500)]/90"
          >
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        )}
        {mediaObj?.url && (
          <div className="mt-8 w-full overflow-hidden rounded-md">
            <Image
              src={mediaObj.url}
              alt={mediaObj.alt ?? headline}
              width={mediaObj.width ?? 1200}
              height={mediaObj.height ?? 630}
              className="h-auto w-full object-cover"
            />
          </div>
        )}
      </div>
    </section>
  )
}
