"use client"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

type FAQItem = {
  id?: string
  question: string
  answer: string
}

type FAQBlockProps = {
  headline?: string
  intro?: string
  items?: FAQItem[]
}

export default function FAQBlock({ headline, intro, items = [] }: FAQBlockProps) {
  return (
    <section className="w-full bg-[var(--surface-1)] py-16 px-6">
      <div className="mx-auto max-w-3xl">
        {(headline || intro) && (
          <div className="mb-10">
            {headline && (
              <h2 className="font-heading text-3xl font-bold text-[var(--fg-1)]">{headline}</h2>
            )}
            {intro && (
              <p className="mt-3 text-base leading-relaxed text-[var(--fg-2)]">{intro}</p>
            )}
          </div>
        )}
        <Accordion type="single" collapsible className="w-full">
          {items.map((item, index) => (
            <AccordionItem
              key={item.id ?? index}
              value={`item-${index}`}
              className="border-b border-[var(--border)]"
            >
              <AccordionTrigger className="py-4 text-left text-sm font-medium text-[var(--fg-1)] hover:text-[var(--accent-500)] [&[data-state=open]]:text-[var(--accent-500)]">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="pb-4 text-sm leading-relaxed text-[var(--fg-2)]">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  )
}
