import HeroBlock from './Hero'
import FeatureGridBlock from './FeatureGrid'
import CTABlock from './CTA'
import FAQBlock from './FAQ'
import RichTextBlock from './RichText'
import MediaSplitBlock from './MediaSplit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any> & { blockType: string }

type BlockRendererProps = {
  blocks: Block[]
}

export default function BlockRenderer({ blocks }: BlockRendererProps) {
  return (
    <>
      {blocks.map((block, index) => {
        const key = block.id ?? index

        switch (block.blockType) {
          case 'hero':
            return (
              <HeroBlock
                key={key}
                eyebrow={block.eyebrow}
                headline={block.headline}
                subhead={block.subhead}
                cta={block.cta}
                image={block.image}
                align={block.align}
              />
            )

          case 'featureGrid':
            return (
              <FeatureGridBlock
                key={key}
                headline={block.headline}
                intro={block.intro}
                columns={block.columns}
                features={block.features}
              />
            )

          case 'cta':
            return (
              <CTABlock
                key={key}
                headline={block.headline}
                subhead={block.subhead}
                primaryCta={block.primaryCta}
                secondaryCta={block.secondaryCta}
                tone={block.tone}
              />
            )

          case 'faq':
            return (
              <FAQBlock
                key={key}
                headline={block.headline}
                intro={block.intro}
                items={block.items}
              />
            )

          case 'richText':
            return (
              <RichTextBlock
                key={key}
                body={block.body}
                width={block.width}
              />
            )

          case 'mediaSplit':
            return (
              <MediaSplitBlock
                key={key}
                headline={block.headline}
                body={block.body}
                media={block.media}
                mediaSide={block.mediaSide}
                cta={block.cta}
              />
            )

          default:
            return null
        }
      })}
    </>
  )
}
