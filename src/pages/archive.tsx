import { Hono } from 'hono'
import type { AppEnv } from '../types/env.js'
import { Layout, ArchivePanel } from '../components/index.js'
import { getManifest, getSidebarData, getBlogConfig } from '../services/github.js'
import { setTieredCache } from '../utils/cache.js'
import { i18n, I18nKey } from '../i18n/index.js'

const archive = new Hono<AppEnv>()

archive.get('/', async (c) => {
  const [manifestRaw, { categories, tags }, siteConfig] = await Promise.all([
    getManifest(c.env),
    getSidebarData(c.env),
    getBlogConfig(c.env),
  ])

  const manifest = manifestRaw
    .filter((p) => p.draft !== true && (p.draft as any) !== 'true')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  // 归档页为高频汇总列表，边缘缓存 30 分钟，SWR 24 小时
  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['page', 'archive'] })

  return c.html(
    <Layout
      title={i18n(I18nKey.archiveTitle, siteConfig.lang)}
      description={i18n(I18nKey.archiveSubtitle, siteConfig.lang, { count: manifest.length })}
      currentPath="/archive"
      isHomePage={false}
      categories={categories}
      tags={tags}
      blogUrl={c.env.BLOG_URL || new URL(c.req.url).origin}
      siteConfig={siteConfig}
      env={c.env}
    >
      <ArchivePanel posts={manifest} lang={siteConfig.lang} />
    </Layout>
  )
})

export default archive
