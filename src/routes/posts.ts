import { Hono } from 'hono'
import type { AppEnv } from '../types/env.js'
import { getManifest, getPost, getFriends, getBlogConfig, getAboutContent, purgeCache } from '../services/github.js'
import { success, paginated, fail } from '../utils/response.js'
import { parsePagination } from '../utils/pagination.js'
import { setTieredCache, setNoCache, purgePlatformCaches } from '../utils/cache.js'

const posts = new Hono<AppEnv>()

/**
 * 获取文章列表
 * GET /api/posts?page=1&pageSize=10&category=xxx&tag=xxx
 */
posts.get('/', async (c) => {
  const [siteConfig, manifestRaw] = await Promise.all([
    getBlogConfig(c.env),
    getManifest(c.env),
  ])
  const configuredPageSize = siteConfig.pagination?.pageSize ?? siteConfig.pageSize ?? 10
  const { page, pageSize, offset, isPaginated } = parsePagination(c.req.query(), configuredPageSize)
  const category = c.req.query('category')
  const tag = c.req.query('tag')
  const keyword = c.req.query('keyword')

  let manifest = manifestRaw

  // 过滤草稿
  manifest = manifest.filter((p) => p.draft !== true && (p.draft as any) !== 'true')

  // 按分类筛选
  if (category) {
    manifest = manifest.filter((p) => p.category === category)
  }

  // 按标签筛选
  if (tag) {
    manifest = manifest.filter((p) => p.tags.includes(tag))
  }

  // 关键词搜索（标题和摘要）
  if (keyword) {
    const kw = keyword.toLowerCase()
    manifest = manifest.filter(
      (p) =>
        p.title.toLowerCase().includes(kw) ||
        p.excerpt.toLowerCase().includes(kw)
    )
  }

  // 按日期降序排序
  manifest.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const total = manifest.length
  const paged = isPaginated && pageSize > 0 ? manifest.slice(offset, offset + pageSize) : manifest

  setTieredCache(c, { tags: ['api', 'posts'] })
  return paginated(c, paged, total, page, isPaginated ? pageSize : total)
})

/**
 * 获取所有分类
 * GET /api/posts/categories
 */
posts.get('/categories', async (c) => {
  const manifest = await getManifest(c.env)
  const published = manifest.filter((p) => p.draft !== true && (p.draft as any) !== 'true')

  const categoryMap = new Map<string, number>()
  for (const post of published) {
    categoryMap.set(post.category, (categoryMap.get(post.category) || 0) + 1)
  }

  const categories = Array.from(categoryMap, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  setTieredCache(c, { tags: ['api', 'categories'] })
  return success(c, categories)
})

/**
 * 获取所有标签
 * GET /api/posts/tags
 */
posts.get('/tags', async (c) => {
  const manifest = await getManifest(c.env)
  const published = manifest.filter((p) => p.draft !== true && (p.draft as any) !== 'true')

  const tagMap = new Map<string, number>()
  for (const post of published) {
    for (const tag of post.tags) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1)
    }
  }

  const tags = Array.from(tagMap, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  setTieredCache(c, { tags: ['api', 'tags'] })
  return success(c, tags)
})

/**
 * 获取文章详情
 * GET /api/posts/:title
 */
posts.get('/:title', async (c) => {
  const rawTitle = c.req.param('title')
  const title = decodeURIComponent(rawTitle)

  const post = await getPost(title, c.env)
  if (!post) {
    setNoCache(c)
    return fail(c, 'Post not found', 404)
  }

  if (post.draft === true || (post.draft as any) === 'true') {
    setNoCache(c)
    return fail(c, 'Post not found', 404)
  }

  setTieredCache(c, { tags: ['api', 'post', `post-${encodeURIComponent(post.title)}`] })
  return success(c, post)
})

/**
 * 清除缓存（用于 Webhook 或手动触发）
 * POST /api/posts/purge
 */
posts.post('/purge', async (c) => {
  setNoCache(c)

  // 密钥验证（支持 PURGE_SECRET 或 GH_TOKEN / PAT_TOKEN）
  const secret = c.req.header('X-Purge-Secret')
  const expectedSecret = c.env.PURGE_SECRET || c.env.GH_TOKEN || c.env.PAT_TOKEN || c.env.GITHUB_TOKEN
  if (expectedSecret && secret !== expectedSecret) {
    return fail(c, 'Unauthorized', 401)
  }

  // 读取可选参数
  let reqBody: any = null
  try {
    if (c.req.header('content-type')?.includes('application/json')) {
      reqBody = await c.req.json().catch(() => null)
    }
  } catch {}

  // 1. 严格原子操作：优先清空旧文章及清单/友链/配置/关于页底层缓存
  const purgeResult = await purgeCache(c.env)

  // 2. 立即拉取并重新缓存最新文章列表、友链、配置与关于页
  const [manifest, friends, siteConfig, aboutData] = await Promise.all([
    getManifest(c.env),
    getFriends(c.env),
    getBlogConfig(c.env),
    getAboutContent(c.env),
  ])

  // 3. 构建受影响页面的精准 URL 列表（保护全站长效静态图片 /images/* 不被清空）
  const blogOrigin = c.env.BLOG_URL
    ? (c.env.BLOG_URL.startsWith('http') ? c.env.BLOG_URL : `https://${c.env.BLOG_URL}`).replace(/\/$/, '')
    : new URL(c.req.url).origin

  const affectedUrls: string[] = [
    `${blogOrigin}/`,
    `${blogOrigin}/archive`,
    `${blogOrigin}/links`,
    `${blogOrigin}/about`,
    `${blogOrigin}/sitemap.xml`,
    `${blogOrigin}/rss.xml`,
    `${blogOrigin}/atom.xml`,
  ]

  // 追加最新变动的文章详情页 URL（最多 10 篇）
  if (Array.isArray(manifest)) {
    for (const p of manifest.slice(0, 10)) {
      if (p.title) {
        affectedUrls.push(`${blogOrigin}/posts/${encodeURIComponent(p.title)}`)
      }
    }
  }

  // 如果请求传入了指定 urls，合并去重
  if (reqBody?.urls && Array.isArray(reqBody.urls)) {
    for (const u of reqBody.urls) {
      if (typeof u === 'string' && !affectedUrls.includes(u)) {
        affectedUrls.push(u)
      }
    }
  }

  // 4. 调用云厂商官方 CDN Control Plane 清除边缘缓存 (优先精准 URL，显式要求才全量)
  const isPurgeEverything = reqBody?.purgeEverything === true
  const platformPurges = await purgePlatformCaches(c.env, {
    urls: affectedUrls,
    purgeEverything: isPurgeEverything,
  })

  return success(
    c,
    {
      purgeResult,
      reCachedCount: manifest.length,
      reCachedFriendsCount: friends.length,
      siteTitle: siteConfig.title,
      aboutTitle: aboutData.title,
      affectedUrlsCount: affectedUrls.length,
      platformPurges,
    },
    'Cache purged and manifest, friends, config & about re-cached successfully'
  )
})

export default posts
