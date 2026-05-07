import { getPayload } from 'payload'
import configPromise from '../payload.config'
import { categories } from './categories'
import { articles } from './articles'
import { pages } from './pages'

async function main() {
  console.log('--- AIMS Seed Script ---')
  const payload = await getPayload({ config: configPromise })

  // ── Categories ─────────────────────────────────────────────────────────────

  const slugToId: Record<string, string> = {}
  let categoriesCreated = 0
  let categoriesUpdated = 0

  for (const cat of categories) {
    const existing = await payload.find({
      collection: 'categories',
      where: { slug: { equals: cat.slug } },
      limit: 1,
    })

    if (existing.docs.length > 0) {
      const doc = existing.docs[0] as { id: string }
      await payload.update({
        collection: 'categories',
        id: doc.id,
        data: {
          name: cat.name,
          description: cat.description,
          order: cat.order,
        },
      })
      slugToId[cat.slug] = doc.id
      categoriesUpdated++
      console.log(`  [category] updated  — ${cat.slug}`)
    } else {
      const created = await payload.create({
        collection: 'categories',
        data: {
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          order: cat.order,
        },
      })
      slugToId[cat.slug] = created.id as string
      categoriesCreated++
      console.log(`  [category] created  — ${cat.slug}`)
    }
  }

  // ── Articles ───────────────────────────────────────────────────────────────

  let articlesCreated = 0
  let articlesUpdated = 0

  for (const art of articles) {
    const categoryId = slugToId[art.categorySlug]
    if (!categoryId) {
      console.warn(`  [article] SKIP (no category for slug "${art.categorySlug}") — ${art.slug}`)
      continue
    }

    const existing = await payload.find({
      collection: 'articles',
      where: { slug: { equals: art.slug } },
      limit: 1,
    })

    if (existing.docs.length > 0) {
      const doc = existing.docs[0] as { id: string }
      await payload.update({
        collection: 'articles',
        id: doc.id,
        data: {
          title: art.title,
          excerpt: art.excerpt,
          body: art.body,
          order: art.order,
          category: categoryId,
          _status: art._status,
        },
      })
      articlesUpdated++
      console.log(`  [article]  updated  — ${art.slug}`)
    } else {
      await payload.create({
        collection: 'articles',
        data: {
          title: art.title,
          slug: art.slug,
          excerpt: art.excerpt,
          body: art.body,
          order: art.order,
          category: categoryId,
          _status: art._status,
        },
      })
      articlesCreated++
      console.log(`  [article]  created  — ${art.slug}`)
    }
  }

  // ── Pages ──────────────────────────────────────────────────────────────────

  let pagesCreated = 0
  let pagesUpdated = 0

  for (const pg of pages) {
    const existing = await payload.find({
      collection: 'pages',
      where: { slug: { equals: pg.slug } },
      limit: 1,
    })

    if (existing.docs.length > 0) {
      const doc = existing.docs[0] as { id: string }
      await payload.update({
        collection: 'pages',
        id: doc.id,
        data: {
          title: pg.title,
          blocks: pg.blocks,
          _status: pg._status,
        },
      })
      pagesUpdated++
      console.log(`  [page]     updated  — ${pg.slug}`)
    } else {
      await payload.create({
        collection: 'pages',
        data: {
          title: pg.title,
          slug: pg.slug,
          blocks: pg.blocks,
          _status: pg._status,
        },
      })
      pagesCreated++
      console.log(`  [page]     created  — ${pg.slug}`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('')
  console.log('--- Seed complete ---')
  console.log(`  Categories:  ${categoriesCreated} created, ${categoriesUpdated} updated`)
  console.log(`  Articles:    ${articlesCreated} created, ${articlesUpdated} updated`)
  console.log(`  Pages:       ${pagesCreated} created, ${pagesUpdated} updated`)
  console.log('')

  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
