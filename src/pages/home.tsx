import { Hono } from 'hono'
import type { AppEnv } from '../types/env.js'
import { Layout, PostCard, Pagination } from '../components/index.js'
import { PostCardItem } from '../components/PostCard.js'
import { getManifest, getSidebarData, getBlogConfig } from '../services/github.js'
import { parsePagination } from '../utils/pagination.js'
import { setTieredCache } from '../utils/cache.js'
import { i18n, I18nKey } from '../i18n/index.js'

const home = new Hono<AppEnv>()

home.get('/', async (c) => {
  const [siteConfig, { categories, tags }, manifestRaw] = await Promise.all([
    getBlogConfig(c.env),
    getSidebarData(c.env),
    getManifest(c.env),
  ])

  const configuredPageSize = siteConfig.pagination?.pageSize ?? siteConfig.pageSize ?? 10
  const { page, pageSize, offset, isPaginated } = parsePagination(c.req.query(), configuredPageSize)
  const category = c.req.query('category')
  const tag = c.req.query('tag')

  let manifest = manifestRaw.filter(
    (p) => p.draft !== true && (p.draft as any) !== 'true'
  )

  if (category) {
    manifest = manifest.filter((p) => p.category === category)
  }
  if (tag) {
    manifest = manifest.filter((p) => p.tags.includes(tag))
  }

  // 严格按照时间倒序排列，最新发布的文章排在最上方
  manifest.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const total = manifest.length
  const totalPages = isPaginated && pageSize > 0 ? Math.ceil(total / pageSize) : 1
  const displayPosts: PostCardItem[] = isPaginated && pageSize > 0
    ? manifest.slice(offset, offset + pageSize)
    : manifest

  let baseUrl = '/'
  if (category) baseUrl = `/?category=${encodeURIComponent(category)}`
  else if (tag) baseUrl = `/?tag=${encodeURIComponent(tag)}`

  let currentPath = baseUrl
  if (page > 1) {
    currentPath = baseUrl.includes('?') ? `${baseUrl}&page=${page}` : `/?page=${page}`
  }

  let pageTitle = undefined
  let pageDescription = undefined
  if (category) {
    pageTitle = i18n(I18nKey.filterCategory, siteConfig.lang, { category })
    pageDescription = `${siteConfig.title} - “${category}”分类下的所有精选文章与技术分享（共 ${total} 篇）。`
  } else if (tag) {
    pageTitle = i18n(I18nKey.filterTag, siteConfig.lang, { tag })
    pageDescription = `${siteConfig.title} - 包含“#${tag}”标签的所有相关文章与教程（共 ${total} 篇）。`
  }

  // 首页及分类/标签筛选属于聚合列表，边缘缓存 30 分钟，SWR 24 小时，避免旧文章残留
  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['page', 'home'] })

  return c.html(
    <Layout
      title={pageTitle}
      description={pageDescription}
      currentPath={currentPath}
      isHomePage={!category && !tag && page <= 1}
      categories={categories}
      tags={tags}
      blogUrl={c.env.BLOG_URL || new URL(c.req.url).origin}
      siteConfig={siteConfig}
      env={c.env}
    >
      {(category || tag) && (
        <div
          class="fuwari-card-base px-6 py-4 flex items-center justify-between fuwari-onload-animation"
          style="animation-delay: 120ms"
        >
          <div class="flex items-center gap-2 font-bold fuwari-text-90">
            <span class="w-1 h-4 rounded-md bg-(--fuwari-primary) inline-block" />
            <span>{category ? i18n(I18nKey.filterCategory, siteConfig.lang, { category: category || '' }) : i18n(I18nKey.filterTag, siteConfig.lang, { tag: tag || '' })}</span>
            <span class="text-sm font-normal fuwari-text-50">{i18n(I18nKey.postsCountTotal, siteConfig.lang, { count: total })}</span>
          </div>
          <a
            href="/"
            class="fuwari-btn-regular px-3 py-1.5 rounded-lg text-xs font-medium no-underline"
          >
            {i18n(I18nKey.clearFilter, siteConfig.lang)}
          </a>
        </div>
      )}

      {displayPosts.length === 0 ? (
        <div
          class="fuwari-card-base p-12 text-center fuwari-text-50 fuwari-onload-animation"
          style="animation-delay: 150ms"
        >
          {i18n(I18nKey.noPosts, siteConfig.lang)}
        </div>
      ) : (
        <div class="flex flex-col gap-4">
          {displayPosts.map((post, i) => (
            <PostCard post={post} index={i} lang={siteConfig.lang} />
          ))}
        </div>
      )}

      {isPaginated && totalPages > 1 && (
        <Pagination currentPage={page} totalPages={totalPages} baseUrl={baseUrl} lang={siteConfig.lang} />
      )}
    </Layout>
  )
})

export default home
