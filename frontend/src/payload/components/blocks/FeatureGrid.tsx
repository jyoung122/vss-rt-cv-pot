import Link from 'next/link'
import {
  BookOpen,
  Camera,
  Activity,
  AlertTriangle,
  Settings,
  Shield,
  Sparkles,
  type LucideProps,
} from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

type IconName = 'BookOpen' | 'Camera' | 'Activity' | 'AlertTriangle' | 'Settings' | 'Shield' | 'Sparkles'

const ICON_MAP: Record<IconName, React.ComponentType<LucideProps>> = {
  BookOpen,
  Camera,
  Activity,
  AlertTriangle,
  Settings,
  Shield,
  Sparkles,
}

const COLUMNS_MAP: Record<string, string> = {
  '2': 'sm:grid-cols-2',
  '3': 'sm:grid-cols-2 lg:grid-cols-3',
  '4': 'sm:grid-cols-2 lg:grid-cols-4',
}

type Feature = {
  id?: string
  icon?: IconName | string
  title: string
  description: string
  href?: string
}

type FeatureGridBlockProps = {
  headline?: string
  intro?: string
  columns?: '2' | '3' | '4' | string
  features?: Feature[]
}

export default function FeatureGridBlock({
  headline,
  intro,
  columns = '3',
  features = [],
}: FeatureGridBlockProps) {
  const gridCols = COLUMNS_MAP[columns] ?? COLUMNS_MAP['3']

  return (
    <section className="w-full bg-[var(--surface-1)] py-16 px-6">
      <div className="mx-auto max-w-6xl">
        {(headline || intro) && (
          <div className="mb-12 max-w-2xl">
            {headline && (
              <h2 className="font-heading text-3xl font-bold text-[var(--fg-1)]">{headline}</h2>
            )}
            {intro && (
              <p className="mt-3 text-base leading-relaxed text-[var(--fg-2)]">{intro}</p>
            )}
          </div>
        )}
        <div className={`grid grid-cols-1 gap-6 ${gridCols}`}>
          {features.map((feature, index) => {
            const IconComponent = feature.icon
              ? (ICON_MAP[feature.icon as IconName] ?? null)
              : null

            const cardContent = (
              <Card className="bg-[var(--surface-2)] transition-colors hover:bg-[var(--surface-3)]">
                <CardHeader>
                  {IconComponent && (
                    <IconComponent
                      className="mb-2 size-6 text-[var(--accent-500)]"
                      aria-hidden="true"
                    />
                  )}
                  <CardTitle className="text-[var(--fg-1)]">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-[var(--fg-2)]">{feature.description}</p>
                </CardContent>
              </Card>
            )

            if (feature.href) {
              return (
                <Link key={feature.id ?? index} href={feature.href} className="block">
                  {cardContent}
                </Link>
              )
            }

            return <div key={feature.id ?? index}>{cardContent}</div>
          })}
        </div>
      </div>
    </section>
  )
}
