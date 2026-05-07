import type { CollectionConfig } from 'payload'
import { Hero } from '../blocks/Hero'
import { FeatureGrid } from '../blocks/FeatureGrid'
import { CTA } from '../blocks/CTA'
import { FAQ } from '../blocks/FAQ'
import { RichText } from '../blocks/RichText'
import { MediaSplit } from '../blocks/MediaSplit'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug'],
  },
  versions: {
    drafts: true,
  },
  access: {
    read: ({ req: { user } }) => {
      if (user) return true
      return {
        _status: {
          equals: 'published',
        },
      }
    },
    create: ({ req: { user } }) => Boolean(user),
    update: ({ req: { user } }) => Boolean(user),
    delete: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      hooks: {
        beforeValidate: [
          ({ value, data }) => {
            if (!value && data?.title) {
              return slugify(data.title as string)
            }
            return value
          },
        ],
      },
    },
    {
      name: 'blocks',
      type: 'blocks',
      blocks: [Hero, FeatureGrid, CTA, FAQ, RichText, MediaSplit],
    },
  ],
}
