import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

type MediaValue = {
  url?: string
  alt?: string
  width?: number
  height?: number
}

type MediaSplitBlockProps = {
  headline: string
  body?: string
  media: MediaValue | string
  mediaSide?: 'left' | 'right'
  cta?: {
    label?: string
    href?: string
  }
}

export default function MediaSplitBlock({
  headline,
  body,
  media,
  mediaSide = 'right',
  cta,
}: MediaSplitBlockProps) {
  const mediaObj = media && typeof media === 'object' ? media : null

  const imageEl = mediaObj?.url ? (
    <div className="relative min-h-64 w-full overflow-hidden rounded-md">
      <Image
        src={mediaObj.url}
        alt={mediaObj.alt ?? headline}
        width={mediaObj.width ?? 800}
        height={mediaObj.height ?? 600}
        className="h-full w-full object-cover"
      />
    </div>
  ) : null

  const textEl = (
    <div className="flex flex-col gap-4">
      <h2 className="font-heading text-3xl font-bold text-[var(--fg-1)]">{headline}</h2>
      {body && (
        <p className="text-base leading-relaxed text-[var(--fg-2)]">{body}</p>
      )}
      {cta?.label && cta?.href && (
        <div className="mt-2">
          <Button
            asChild
            size="lg"
            className="bg-[var(--accent-500)] text-[var(--ink-0)] hover:bg-[var(--accent-500)]/90"
          >
            <Link href={cta.href}>{cta.label}</Link>
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <section className="w-full bg-[var(--surface-1)] py-16 px-6">
      <div className="mx-auto max-w-6xl">
        <div
          className={`flex flex-col gap-10 md:flex-row md:items-center ${
            mediaSide === 'left' ? 'md:flex-row-reverse' : ''
          }`}
        >
          <div className="flex-1">{textEl}</div>
          {imageEl && <div className="flex-1">{imageEl}</div>}
        </div>
      </div>
    </section>
  )
}
