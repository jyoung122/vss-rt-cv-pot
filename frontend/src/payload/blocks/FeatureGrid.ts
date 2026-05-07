import type { Block } from 'payload'

export const FeatureGrid: Block = {
  slug: 'featureGrid',
  interfaceName: 'FeatureGridBlock',
  labels: {
    singular: 'Feature Grid',
    plural: 'Feature Grids',
  },
  fields: [
    {
      name: 'headline',
      type: 'text',
    },
    {
      name: 'intro',
      type: 'textarea',
    },
    {
      name: 'columns',
      type: 'select',
      defaultValue: '3',
      options: [
        { label: '2 Columns', value: '2' },
        { label: '3 Columns', value: '3' },
        { label: '4 Columns', value: '4' },
      ],
    },
    {
      name: 'features',
      type: 'array',
      fields: [
        {
          name: 'icon',
          type: 'select',
          options: [
            { label: 'Book Open', value: 'BookOpen' },
            { label: 'Camera', value: 'Camera' },
            { label: 'Activity', value: 'Activity' },
            { label: 'Alert Triangle', value: 'AlertTriangle' },
            { label: 'Settings', value: 'Settings' },
            { label: 'Shield', value: 'Shield' },
            { label: 'Sparkles', value: 'Sparkles' },
          ],
        },
        {
          name: 'title',
          type: 'text',
          required: true,
        },
        {
          name: 'description',
          type: 'textarea',
          required: true,
        },
        {
          name: 'href',
          type: 'text',
        },
      ],
    },
  ],
}

export default FeatureGrid
