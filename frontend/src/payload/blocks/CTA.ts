import type { Block } from 'payload'

export const CTA: Block = {
  slug: 'cta',
  interfaceName: 'CTABlock',
  labels: {
    singular: 'CTA',
    plural: 'CTAs',
  },
  fields: [
    {
      name: 'headline',
      type: 'text',
      required: true,
    },
    {
      name: 'subhead',
      type: 'textarea',
    },
    {
      name: 'primaryCta',
      type: 'group',
      fields: [
        {
          name: 'label',
          type: 'text',
        },
        {
          name: 'href',
          type: 'text',
        },
      ],
    },
    {
      name: 'secondaryCta',
      type: 'group',
      fields: [
        {
          name: 'label',
          type: 'text',
        },
        {
          name: 'href',
          type: 'text',
        },
      ],
    },
    {
      name: 'tone',
      type: 'select',
      defaultValue: 'accent',
      options: [
        { label: 'Accent', value: 'accent' },
        { label: 'Navy', value: 'navy' },
        { label: 'Surface', value: 'surface' },
      ],
    },
  ],
}

export default CTA
