import { RichText as LexicalRichText } from '@payloadcms/richtext-lexical/react'

type RichTextBlockProps = {
  body?: Record<string, unknown> | null
  width?: 'narrow' | 'wide' | string
}

const WIDTH_CLASS: Record<string, string> = {
  narrow: 'max-w-2xl mx-auto',
  wide: 'max-w-4xl mx-auto',
}

export default function RichTextBlock({ body, width = 'narrow' }: RichTextBlockProps) {
  const containerClass = WIDTH_CLASS[width] ?? WIDTH_CLASS.narrow

  if (!body) return null

  return (
    <section className="w-full bg-[var(--surface-1)] py-12 px-6">
      <div
        className={`
          ${containerClass}
          text-[var(--fg-1)]
          [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:text-[var(--fg-1)] [&_h1]:mb-4
          [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-[var(--fg-1)] [&_h2]:mb-3 [&_h2]:mt-8
          [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-[var(--fg-1)] [&_h3]:mb-2 [&_h3]:mt-6
          [&_p]:text-[var(--fg-2)] [&_p]:leading-relaxed [&_p]:mb-4
          [&_a]:text-[var(--accent-500)] [&_a]:underline [&_a]:underline-offset-2
          [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul_li]:text-[var(--fg-2)] [&_ul_li]:mb-1
          [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_ol_li]:text-[var(--fg-2)] [&_ol_li]:mb-1
          [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--accent-500)] [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-[var(--fg-3)] [&_blockquote]:mb-4
          [&_code]:bg-[var(--surface-3)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-sm [&_code]:text-[var(--accent-300)]
          [&_pre]:bg-[var(--surface-3)] [&_pre]:p-4 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:mb-4
          [&_strong]:font-semibold [&_strong]:text-[var(--fg-1)]
          [&_hr]:border-[var(--border)] [&_hr]:my-6
        `}
      >
        <LexicalRichText data={body as unknown as Parameters<typeof LexicalRichText>[0]['data']} />
      </div>
    </section>
  )
}
