import { Hono } from 'hono'
import type { AppEnv } from '../types/env.js'
import { getManifest, getPost, getFriends, getBlogConfig, getAboutContent, purgeCache } from '../services/github.js'
import { success, paginated, fail } from '../utils/response.js'
import { parsePagination } from '../utils/pagination.js'
import { setTieredCache, setNoCache, purgePlatformCaches, purgeWorkersCache } from '../utils/cache.js'

const posts = new Hono<AppEnv>()

/**
 * 恒定时间字符串比较,防止通过响应时间差推测 PURGE_SECRET。
 * 长度差异不回退提前返回;使用固定上限长度避免长度侧信道泄漏过多信息。
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  // 先比较长度(长度本身不视为敏感),再用 X 位差异做恒定时间比较
  let diff = aBytes.length ^ bBytes.length
  const max = Math.max(aBytes.length, bBytes.length)
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}

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

  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['api', 'posts'] })
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

  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['api', 'categories'] })
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

  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['api', 'tags'] })
  return success(c, tags)
})

/**
 * 获取文章详情
 * GET /api/posts/:title
 */
posts.get('/:title', async (c) => {
  const title = c.req.param('title')

  const post = await getPost(title, c.env)
  if (!post) {
    setNoCache(c)
    return fail(c, 'Post not found', 404)
  }

  if (post.draft === true || (post.draft as any) === 'true') {
    setNoCache(c)
    return fail(c, 'Post not found', 404)
  }

  setTieredCache(c, {
    edgeMaxAge: 86400,
    swrMaxAge: 604800,
    tags: ['api', 'post', `post-${encodeURIComponent(post.title)}`],
  })
  return success(c, post)
})

/**
 * 清除缓存（用于 Webhook 或手动触发）
 * POST /api/posts/purge
 */
posts.post('/purge', async (c) => {
  setNoCache(c)

  // 密钥验证(优先 PURGE_SECRET,兼容 GH_TOKEN / PAT_TOKEN / GITHUB_TOKEN)
  // 采用 fail-closed:未配置任何密钥时直接拒绝,避免匿名清空缓存(缓存抖动/回源放大)。
  const secret = c.req.header('X-Purge-Secret') || ''
  const expectedSecret = c.env.PURGE_SECRET || c.env.GH_TOKEN || c.env.PAT_TOKEN || c.env.GITHUB_TOKEN
  if (!expectedSecret) {
    console.error('[Purge] 拒绝请求:未配置 PURGE_SECRET(或 GH_TOKEN/PAT_TOKEN/GITHUB_TOKEN)')
    return fail(c, 'Purge endpoint disabled: no secret configured', 403)
  }
  if (!(await timingSafeEqual(secret, expectedSecret))) {
    return fail(c, 'Unauthorized', 401)
  }

  // 读取可选参数
  let reqBody: any = null
  try {
    if (c.req.header('content-type')?.includes('application/json')) {
      reqBody = await c.req.json().catch(() => null)
    }
  } catch (err: any) {
    console.warn('[Purge] 解析请求 body 异常:', err?.message || err)
  }

  // 1. 严格原子操作：优先清空旧文章及清单/友链/配置/关于页底层缓存
  const purgeResult = await purgeCache(c.env)

  // 2. 立即拉取并重新缓存最新文章列表、友链、配置与关于页
  const [manifest, friends, siteConfig, aboutData] = await Promise.all([
    getManifest(c.env),
    getFriends(c.env),
    getBlogConfig(c.env),
    getAboutContent(c.env),
  ])

  // 3. 构建受影响页面的精准 URL 列表与 Cache-Tag 列表（保护全站长效静态图片 /images/* 及未变动老文章不被清空）
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

  // 常规精准更新仅清理受影响的聚合页、订阅源、列表 API 标签及具体变动文章标签（不含宽泛伞状标签 'page' / 'post'）
  const affectedTags: string[] = [
    'home',
    'archive',
    'links',
    'about',
    'rss',
    'sitemap',
    'posts',
    'categories',
    'tags',
  ]

  // 追加最新变动的文章详情页 URL 与标签（最多 10 篇）
  if (Array.isArray(manifest)) {
    for (const p of manifest.slice(0, 10)) {
      if (p.title) {
        const encodedTitle = encodeURIComponent(p.title)
        affectedUrls.push(`${blogOrigin}/posts/${encodedTitle}`)
        affectedTags.push(`post-${encodedTitle}`)
      }
    }
  }

  // 如果请求传入了指定 urls 或 tags，合并去重
  if (reqBody?.urls && Array.isArray(reqBody.urls)) {
    for (const u of reqBody.urls) {
      if (typeof u === 'string' && !affectedUrls.includes(u)) {
        affectedUrls.push(u)
      }
    }
  }
  if (reqBody?.tags && Array.isArray(reqBody.tags)) {
    for (const t of reqBody.tags) {
      if (typeof t === 'string' && !affectedTags.includes(t)) {
        affectedTags.push(t)
      }
    }
  }
  // 4. 清除边缘缓存:Workers Cache(Worker 生成页面)+ 各厂商 zone 级 CDN(静态资源)
  const isPurgeEverything = reqBody?.purgeEverything === true

  // 4a. 清除 Cloudflare Workers Cache(Worker 生成页面所在的那层缓存)。
  //     zone 级 purge_cache API 对其无效,必须用 ctx.cache.purge()。
  const workersCachePurge = await purgeWorkersCache(c, {
    tags: affectedTags,
    purgeEverything: isPurgeEverything,
  })

  // 4b. 清除各厂商 zone 级 CDN 缓存(Cloudflare 静态资源 / Netlify / Vercel)
  const platformPurges = await purgePlatformCaches(c.env, {
    urls: affectedUrls,
    tags: affectedTags,
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
      affectedTagsCount: affectedTags.length,
      workersCachePurge,
      platformPurges,
    },
    'Cache purged and manifest, friends, config & about re-cached successfully'
  )
})

export default posts
