import type { AppEnv } from '../types/env.js'
import type { PostMeta, Post, Manifest, FriendLink, AboutContent } from '../types/post.js'
import { parseFrontmatter, estimateReadingTime, extractExcerpt } from '../utils/markdown.js'
import { getBlogStorage } from './storage.js'
import { blogConfig as defaultBlogConfig, BlogConfig } from '../blog.config.js'
import defaultFriendsRaw from '../../friends.json' with { type: 'json' }
import defaultManifestRaw from '../../posts/manifest.json' with { type: 'json' }

/**
 * 判定是否处于本地开发环境
 */
export function isDevMode(env?: AppEnv['Bindings']): boolean {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') return true
  if (env?.BLOG_URL?.includes('localhost') || env?.BLOG_URL?.includes('127.0.0.1')) return true
  if (typeof process !== 'undefined' && (process.env?.BLOG_URL?.includes('localhost') || process.env?.BLOG_URL?.includes('127.0.0.1'))) return true
  if (env?.DEPLOY_PLATFORM === 'local') return true
  return false
}

/**
 * 本地开发环境下尝试直接读取工作区磁盘文件 (避免网络延迟与离线无法调试)
 */
async function readLocalFile(relativePath: string): Promise<string | null> {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const fullPath = path.resolve(process.cwd(), relativePath)
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8')
    }
  } catch {}
  return null
}

/**
 * 获取底层持久化/内存缓存时长（秒）
 * 默认缓存 24 小时 (86400 秒)：结合分层缓存架构与 SWR，数据常驻边缘 KV/内存，彻底杜绝无谓的 GitHub API 请求；
 * 配合主动 Purge 接口实现秒级发布更新。支持通过环境变量 CACHE_TTL 自定义覆盖。
 */
function getCacheTtl(env?: AppEnv['Bindings']): number {
  if (env?.CACHE_TTL) {
    const val = Number(env.CACHE_TTL)
    if (!isNaN(val) && val > 0) return val
  }
  return 60 * 60 * 24
}

const MANIFEST_CACHE_KEY = 'manifest'
const FRIENDS_CACHE_KEY = 'friends'
const CONFIG_CACHE_KEY = 'site_config'
const ABOUT_CACHE_KEY = 'page:about'

/**
 * 构建 GitHub Raw 内容 URL (附加时间戳以绕过 Fastly/GitHub Raw 边缘 5 分钟死缓存)
 */
function rawUrl(owner: string, repo: string, branch: string, path: string): string {
  const safeBranch = branch && branch.trim() ? branch.trim() : 'main'
  return `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${encodeURI(path)}?_t=${Date.now()}`
}

/**
 * 解析并规范化 GitHub 环境变量（优先 GH_*，兼容 GITHUB_*）
 */
function getGhConfig(env: AppEnv['Bindings']) {
  const owner = env?.GH_OWNER || env?.GITHUB_OWNER || ''
  const repo = env?.GH_REPO || env?.GITHUB_REPO || ''
  const branch = env?.GH_BRANCH || env?.GITHUB_BRANCH || 'main'
  const token = env?.GH_TOKEN || env?.PAT_TOKEN || env?.GITHUB_TOKEN
  return { owner, repo, branch, token }
}

/**
 * 检查 GitHub 配置是否有效
 */
function isGitHubConfigured(env: AppEnv['Bindings']): boolean {
  const { owner, repo } = getGhConfig(env)
  return !!(
    owner &&
    repo &&
    !owner.startsWith('<') &&
    !repo.startsWith('<')
  )
}

/**
 * 从 GitHub 拉取文件内容（带超时与异常熔断保护，默认 2500ms 超时，防止因网络受阻导致页面卡死）
 */
async function fetchFromGitHub(
  url: string,
  token?: string,
  timeoutMs = 2500
): Promise<string | null> {
  const headers: Record<string, string> = {
    'User-Agent': 'Blog-Worker',
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  }
  if (token) {
    headers['Authorization'] = `token ${token}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      if (res.status === 404) return null
      console.warn(`[GitHub Fetch Failed] ${res.status} ${res.statusText}: ${url}`)
      return null
    }
    return await res.text()
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn(`[GitHub Timeout] 请求超时 (${timeoutMs}ms)，自动降级: ${url}`)
      return null
    }
    console.warn(`[GitHub Error] ${err.message}: ${url}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 获取文章清单（带 KV 缓存与本地优先）
 */
export async function getManifest(env: AppEnv['Bindings']): Promise<Manifest> {
  const isDev = isDevMode(env)
  const storage = getBlogStorage(env)

  // 1. 本地开发环境下，优先读取本地 posts/manifest.json 文件（秒级响应且支持本地实时更新）
  if (isDev) {
    const localContent = await readLocalFile('posts/manifest.json')
    if (localContent) {
      try {
        const manifest = JSON.parse(localContent) as Manifest
        storage.setItem(MANIFEST_CACHE_KEY, manifest, { ttl: 3600 }).catch((err) => {
          console.warn('[Cache] 写入本地 manifest 缓存异常:', err?.message || err)
        })
        return manifest
      } catch {}
    }
    const builtin = getBuiltinManifest()
    storage.setItem(MANIFEST_CACHE_KEY, builtin, { ttl: 3600 }).catch((err) => {
      console.warn('[Cache] 写入内置 manifest 缓存异常:', err?.message || err)
    })
    return builtin
  }

  // 2. 生产环境先查缓存
  try {
    const cached = await storage.getItem<Manifest>(MANIFEST_CACHE_KEY)
    if (cached) {
      return cached
    }
  } catch (err: any) {
    console.warn('[Cache] 读取 manifest 缓存异常:', err?.message || err)
  }

  // 3. GitHub 未配置时返回示例数据
  if (!isGitHubConfigured(env)) {
    return getBuiltinManifest()
  }

  // 4. 从 GitHub 拉取（带 2.5 秒超时）
  const { owner, repo, branch, token } = getGhConfig(env)
  const url = rawUrl(owner, repo, branch, 'posts/manifest.json')
  const content = await fetchFromGitHub(url, token)

  if (!content) {
    return getBuiltinManifest()
  }

  try {
    const manifest = JSON.parse(content) as Manifest

    // 写入缓存
    try {
      await storage.setItem(MANIFEST_CACHE_KEY, manifest, {
        ttl: getCacheTtl(env),
      })
    } catch (err: any) {
      console.warn('[Cache] 写入 manifest 缓存异常:', err?.message || err)
    }

    return manifest
  } catch {
    return getBuiltinManifest()
  }
}

/**
 * 获取单篇文章完整内容
 * @param identifier 文章标题（支持中文、空格、URL 编码字符）
 */
export async function getPost(
  identifier: string,
  env: AppEnv['Bindings']
): Promise<Post | null> {
  // 解码可能传入的 URL 编码标题
  let decoded = identifier
  try {
    decoded = decodeURIComponent(identifier)
  } catch {
    // 忽略解码错误
  }

  const cacheKey = `post:${decoded}`
  const storage = getBlogStorage(env)

  // 先查缓存
  try {
    const cached = await storage.getItem<Post>(cacheKey)
    if (cached) {
      return cached
    }
  } catch (err: any) {
    console.warn(`[Cache] 读取文章 [${cacheKey}] 缓存异常:`, err?.message || err)
  }

  // 从清单查找对应文章以获取真实文件路径
  const manifest = await getManifest(env)
  const meta = manifest.find(
    (p) =>
      p.title === decoded ||
      p.title === identifier ||
      p.slug === decoded ||
      p.slug === identifier ||
      encodeURIComponent(p.title) === identifier
  )

  const isDev = isDevMode(env)

  // 1. 本地开发环境：优先尝试直接读取本地 posts 目录下的真实 markdown 文件
  if (isDev) {
    const filePath = meta ? meta.path : `posts/${decoded}.md`
    const localContent = await readLocalFile(filePath)
    if (localContent) {
      const { frontmatter, content } = parseFrontmatter(localContent)
      const postTitle = meta?.title || frontmatter.title || decoded
      const rawDraft = meta?.draft ?? frontmatter.draft
      const isDraft = typeof rawDraft === 'boolean' ? rawDraft : (rawDraft === 'true' || rawDraft === 'yes')

      const post: Post = {
        title: postTitle,
        date: meta?.date || frontmatter.date || new Date().toISOString().split('T')[0],
        updated: meta?.updated || frontmatter.updated || undefined,
        category: meta?.category || frontmatter.category || '未分类',
        tags: meta?.tags || frontmatter.tags || [],
        excerpt: meta?.excerpt || frontmatter.excerpt || extractExcerpt(content),
        cover: meta?.cover || frontmatter.cover || frontmatter.image,
        draft: isDraft,
        slug: postTitle,
        path: filePath,
        readingTime: estimateReadingTime(content),
        content,
      }

      storage.setItem(cacheKey, post, { ttl: 3600 }).catch((err) => {
        console.warn(`[Cache] 写入本地文章 [${cacheKey}] 缓存异常:`, err?.message || err)
      })
      return post
    }
  }

  // 2. GitHub 未配置时返回示例文章
  if (!isGitHubConfigured(env)) {
    return getBuiltinPost(decoded)
  }

  // 3. 从 GitHub 拉取（带 2.5 秒超时）
  const { owner, repo, branch, token } = getGhConfig(env)
  const filePath = meta ? meta.path : `posts/${decoded}.md`
  const url = rawUrl(owner, repo, branch, filePath)
  const raw = await fetchFromGitHub(url, token)

  if (!raw) {
    return getBuiltinPost(decoded)
  }

  // 解析 frontmatter 和内容
  const { frontmatter, content } = parseFrontmatter(raw)

  const postTitle = meta?.title || frontmatter.title || decoded
  const rawDraft = meta?.draft ?? frontmatter.draft
  const isDraft = typeof rawDraft === 'boolean' ? rawDraft : (rawDraft === 'true' || rawDraft === 'yes')

  const post: Post = {
    title: postTitle,
    date: meta?.date || frontmatter.date || new Date().toISOString().split('T')[0],
    updated: meta?.updated || frontmatter.updated || undefined,
    category: meta?.category || frontmatter.category || '未分类',
    tags: meta?.tags || frontmatter.tags || [],
    excerpt: meta?.excerpt || frontmatter.excerpt || extractExcerpt(content),
    cover: meta?.cover || frontmatter.cover || frontmatter.image,
    draft: isDraft,
    slug: postTitle,
    path: filePath,
    readingTime: estimateReadingTime(content),
    content,
  }

  // 写入缓存
  try {
    await storage.setItem(cacheKey, post, {
      ttl: getCacheTtl(env),
    })
  } catch (err: any) {
    console.warn(`[Cache] 写入文章 [${cacheKey}] 缓存异常:`, err?.message || err)
  }

  return post
}

/**
 * 获取友情链接列表（带 KV 缓存与本地优先）
 */
export async function getFriends(env: AppEnv['Bindings']): Promise<FriendLink[]> {
  const isDev = isDevMode(env)
  const storage = getBlogStorage(env)

  // 1. 本地开发环境下，优先读取本地 friends.json 文件
  if (isDev) {
    const localContent = await readLocalFile('friends.json')
    if (localContent) {
      try {
        const data = JSON.parse(localContent)
        const list: FriendLink[] = Array.isArray(data)
          ? data
          : data && Array.isArray(data.friends)
          ? data.friends
          : []
        storage.setItem(FRIENDS_CACHE_KEY, list, { ttl: 3600 }).catch(() => {})
        return list
      } catch {}
    }
    const builtin = getBuiltinFriends()
    storage.setItem(FRIENDS_CACHE_KEY, builtin, { ttl: 3600 }).catch(() => {})
    return builtin
  }

  // 2. 生产环境先查缓存
  try {
    const cached = await storage.getItem<any>(FRIENDS_CACHE_KEY)
    if (cached) {
      if (Array.isArray(cached)) return cached
      if (cached && Array.isArray(cached.friends)) return cached.friends
    }
  } catch (err: any) {
    console.warn('[Cache] 读取 friends 缓存异常:', err?.message || err)
  }

  // 3. GitHub 未配置时返回内置示例数据
  if (!isGitHubConfigured(env)) {
    return getBuiltinFriends()
  }

  // 4. 从 GitHub 拉取 friends.json（带 2.5 秒超时）
  const { owner, repo, branch, token } = getGhConfig(env)
  const url = rawUrl(owner, repo, branch, 'friends.json')
  const content = await fetchFromGitHub(url, token)

  if (!content) {
    const builtin = getBuiltinFriends()
    storage.setItem(FRIENDS_CACHE_KEY, builtin, { ttl: 60 }).catch((err) => {
      console.warn('[Cache] 写入 fallback friends 缓存异常:', err?.message || err)
    })
    return builtin
  }

  try {
    const data = JSON.parse(content)
    const list: FriendLink[] = Array.isArray(data)
      ? data
      : data && Array.isArray(data.friends)
      ? data.friends
      : []

    // 写入缓存
    try {
      await storage.setItem(FRIENDS_CACHE_KEY, list, {
        ttl: getCacheTtl(env),
      })
    } catch (err: any) {
      console.warn('[Cache] 写入 friends 缓存异常:', err?.message || err)
    }

    return list
  } catch (err) {
    console.warn('Failed to parse friends.json:', err)
    return getBuiltinFriends()
  }
}

/**
 * 获取站点全局配置（本地优先读取，生产环境优先从 KV 缓存读取并支持 GitHub 动态同步）
 */
export async function getBlogConfig(env?: AppEnv['Bindings']): Promise<BlogConfig> {
  const isDev = isDevMode(env)

  // 1. 本地开发环境下，优先直接使用本地工作区的最新 blog.config.json (或 defaultBlogConfig)
  // 彻底避免 Miniflare 本地持久化 KV 缓存 (.wrangler/state) 残留旧标题或受到远程 GitHub 网络延迟干扰
  if (isDev) {
    const storage = getBlogStorage(env)
    const localContent = await readLocalFile('blog.config.json')
    if (localContent) {
      try {
        const parsed = JSON.parse(localContent)
        const merged: BlogConfig = {
          title: parsed.title || defaultBlogConfig.title,
          author: parsed.author || defaultBlogConfig.author,
          description: parsed.description || defaultBlogConfig.description,
          lang: parsed.lang || defaultBlogConfig.lang,
          repository: parsed.repository || defaultBlogConfig.repository,
          pagination: {
            pageSize:
              typeof parsed.pagination?.pageSize === 'number'
                ? parsed.pagination.pageSize
                : typeof parsed.pageSize === 'number'
                ? parsed.pageSize
                : defaultBlogConfig.pagination?.pageSize ?? 10,
          },
          pageSize:
            typeof parsed.pagination?.pageSize === 'number'
              ? parsed.pagination.pageSize
              : typeof parsed.pageSize === 'number'
              ? parsed.pageSize
              : defaultBlogConfig.pagination?.pageSize ?? 10,
          nav: Array.isArray(parsed.nav) ? parsed.nav : defaultBlogConfig.nav,
          social: Array.isArray(parsed.social) ? parsed.social : defaultBlogConfig.social,
          icons: {
            ...defaultBlogConfig.icons,
            ...(parsed.icons || {}),
          },
          theme: {
            fuwari: {
              ...defaultBlogConfig.theme.fuwari,
              ...(parsed.theme?.fuwari || {}),
            },
          },
          seo: {
            ...defaultBlogConfig.seo,
            ...(parsed.seo || {}),
          },
        }
        storage.setItem(CONFIG_CACHE_KEY, merged).catch((err) => {
          console.warn('[Cache] 写入本地 config 缓存异常:', err?.message || err)
        })
        return merged
      } catch {}
    }
    storage.setItem(CONFIG_CACHE_KEY, defaultBlogConfig).catch((err) => {
      console.warn('[Cache] 写入默认 config 缓存异常:', err?.message || err)
    })
    return defaultBlogConfig
  }

  const storage = getBlogStorage(env)

  // 2. 生产环境先查缓存
  try {
    const cached = await storage.getItem<BlogConfig>(CONFIG_CACHE_KEY)
    if (cached && typeof cached === 'object' && cached.title) {
      return cached
    }
  } catch (err: any) {
    console.warn('[Cache] 读取 config 缓存异常:', err?.message || err)
  }

  // 3. 如果 GitHub 未配置，返回本地默认配置
  if (!env || !isGitHubConfigured(env)) {
    return defaultBlogConfig
  }

  // 4. 从 GitHub 拉取最新的 blog.config.json（带 2.5 秒超时）
  try {
    const { owner, repo, branch, token } = getGhConfig(env)
    const url = rawUrl(owner, repo, branch, 'blog.config.json')
    const content = await fetchFromGitHub(url, token)
    if (content) {
      const parsed = JSON.parse(content)
      const merged: BlogConfig = {
        title: parsed.title || defaultBlogConfig.title,
        author: parsed.author || defaultBlogConfig.author,
        description: parsed.description || defaultBlogConfig.description,
        lang: parsed.lang || defaultBlogConfig.lang,
        repository: parsed.repository || defaultBlogConfig.repository,
        pagination: {
          pageSize:
            typeof parsed.pagination?.pageSize === 'number'
              ? parsed.pagination.pageSize
              : typeof parsed.pageSize === 'number'
              ? parsed.pageSize
              : defaultBlogConfig.pagination?.pageSize ?? 10,
        },
        pageSize:
          typeof parsed.pagination?.pageSize === 'number'
            ? parsed.pagination.pageSize
            : typeof parsed.pageSize === 'number'
            ? parsed.pageSize
            : defaultBlogConfig.pagination?.pageSize ?? 10,
        nav: Array.isArray(parsed.nav) ? parsed.nav : defaultBlogConfig.nav,
        social: Array.isArray(parsed.social) ? parsed.social : defaultBlogConfig.social,
        icons: {
          ...defaultBlogConfig.icons,
          ...(parsed.icons || {}),
        },
        theme: {
          fuwari: {
            ...defaultBlogConfig.theme.fuwari,
            ...(parsed.theme?.fuwari || {}),
          },
        },
        seo: {
          ...defaultBlogConfig.seo,
          ...(parsed.seo || {}),
        },
      }

      // 写入缓存
      try {
        await storage.setItem(CONFIG_CACHE_KEY, merged, {
          ttl: getCacheTtl(env),
        })
      } catch (err: any) {
        console.warn('[Cache] 写入 config 缓存异常:', err?.message || err)
      }

      return merged
    }
  } catch (err) {
    console.warn('动态拉取 blog.config.json 异常，回退至默认配置:', err)
  }

  return defaultBlogConfig
}

/**
 * 获取关于页面内容（本地优先读取，生产环境优先从 KV 缓存读取并支持 GitHub 动态同步 about.md）
 */
export async function getAboutContent(env?: AppEnv['Bindings']): Promise<AboutContent> {
  const isDev = isDevMode(env)
  const storage = getBlogStorage(env)

  // 1. 本地开发环境下，优先读取本地 about.md 文件
  if (isDev) {
    const localContent = await readLocalFile('about.md')
    if (localContent) {
      try {
        const parsed = parseFrontmatter(localContent)
        const aboutData: AboutContent = {
          title: parsed.frontmatter.title || '关于本站',
          description: (parsed.frontmatter as any).description || undefined,
          content: parsed.content || localContent,
        }
        storage.setItem(ABOUT_CACHE_KEY, aboutData, { ttl: 3600 }).catch((err) => {
          console.warn('[Cache] 写入本地 about 缓存异常:', err?.message || err)
        })
        return aboutData
      } catch {}
    }
    const builtin = getBuiltinAbout()
    storage.setItem(ABOUT_CACHE_KEY, builtin, { ttl: 3600 }).catch((err) => {
      console.warn('[Cache] 写入内置 about 缓存异常:', err?.message || err)
    })
    return builtin
  }

  // 2. 生产环境先查缓存
  try {
    const cached = await storage.getItem<AboutContent>(ABOUT_CACHE_KEY)
    if (cached && typeof cached === 'object' && cached.content) {
      return cached
    }
  } catch (err: any) {
    console.warn('[Cache] 读取 about 缓存异常:', err?.message || err)
  }

  // 3. 如果 GitHub 未配置，返回内置默认关于内容
  if (!env || !isGitHubConfigured(env)) {
    return getBuiltinAbout()
  }

  // 4. 从 GitHub 拉取最新的 about.md（带 2.5 秒超时）
  try {
    const { owner, repo, branch, token } = getGhConfig(env)
    const url = rawUrl(owner, repo, branch, 'about.md')
    const raw = await fetchFromGitHub(url, token)

    if (raw) {
      let frontmatter: Record<string, any> = {}
      let content = raw

      try {
        const parsed = parseFrontmatter(raw)
        frontmatter = parsed.frontmatter
        content = parsed.content
      } catch {
        // 没有 frontmatter 或格式不规范，作为纯 Markdown 处理
        frontmatter = {}
        content = raw
      }

      const aboutData: AboutContent = {
        title: frontmatter.title || '关于本站',
        description: frontmatter.description || undefined,
        content: content || raw,
      }

      // 写入缓存
      try {
        await storage.setItem(ABOUT_CACHE_KEY, aboutData, {
          ttl: getCacheTtl(env),
        })
      } catch (err: any) {
        console.warn('[Cache] 写入 about 缓存异常:', err?.message || err)
      }

      return aboutData
    }
  } catch (err) {
    console.warn('动态拉取 about.md 异常，回退至内置内容:', err)
  }

  const builtin = getBuiltinAbout()
  storage.setItem(ABOUT_CACHE_KEY, builtin, { ttl: 60 }).catch((err) => {
    console.warn('[Cache] 写入 fallback about 缓存异常:', err?.message || err)
  })
  return builtin
}

export interface PurgeCacheResult {
  success: boolean
  purgedKeysCount: number
  error?: string
}

/**
 * 清除所有缓存（文章、友链、关于页或站点配置更新后调用）
 */
export async function purgeCache(env: AppEnv['Bindings']): Promise<PurgeCacheResult> {
  const storage = getBlogStorage(env)
  let count = 0

  try {
    // 清除 manifest、friends、site_config 与 about 缓存
    await Promise.all([
      storage.removeItem(MANIFEST_CACHE_KEY),
      storage.removeItem(FRIENDS_CACHE_KEY),
      storage.removeItem(CONFIG_CACHE_KEY),
      storage.removeItem(ABOUT_CACHE_KEY),
    ])
    count += 4

    // 列出并清除所有文章缓存
    const postKeys = await storage.getKeys('post:')
    if (postKeys && postKeys.length > 0) {
      await Promise.all(postKeys.map((key) => storage.removeItem(key)))
      count += postKeys.length
    }
    console.log(`[Cache] 成功清除底层 KV/内存缓存键共 ${count} 个`)
    return { success: true, purgedKeysCount: count }
  } catch (err: any) {
    const msg = err?.message || String(err)
    console.warn('[Cache] 清除底层缓存异常:', msg)
    return { success: false, purgedKeysCount: count, error: msg }
  }
}

/**
 * 获取侧边栏分类与标签统计数据
 */
export async function getSidebarData(env: AppEnv['Bindings']) {
  const manifest = (await getManifest(env)).filter((p) => p.draft !== true && (p.draft as any) !== 'true')
  const categoryMap = new Map<string, number>()
  const tagMap = new Map<string, number>()

  for (const p of manifest) {
    if (p.category) {
      categoryMap.set(p.category, (categoryMap.get(p.category) || 0) + 1)
    }
    for (const t of p.tags) {
      tagMap.set(t, (tagMap.get(t) || 0) + 1)
    }
  }

  const categories = Array.from(categoryMap, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  const tags = Array.from(tagMap, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  return { categories, tags }
}

// ============================
// 内置示例数据（本地开发用）
// ============================

function getBuiltinManifest(): Manifest {
  if (Array.isArray(defaultManifestRaw) && defaultManifestRaw.length > 0) {
    return defaultManifestRaw as Manifest
  }
  return [
    {
      title: '使用 Hono 构建博客 API',
      slug: '使用 Hono 构建博客 API',
      date: '2024-01-20',
      category: '技术',
      tags: ['Hono', 'Cloudflare Workers', 'TypeScript'],
      excerpt: '本文介绍如何使用 Hono 框架在 Cloudflare Workers 上构建一个轻量级博客 API。',
      draft: false,
      path: 'posts/使用 Hono 构建博客 API.md',
      readingTime: 3,
    },
    {
      title: 'Hello World',
      slug: 'Hello World',
      date: '2024-01-15',
      updated: '2026-03-19',
      category: '技术',
      tags: ['博客', '入门'],
      excerpt: '这是我的第一篇博客文章，欢迎来到我的博客！',
      cover: 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=1000&q=80',
      draft: false,
      path: 'posts/Hello World.md',
      readingTime: 1,
    },
  ]
}

function getBuiltinPost(identifier: string): Post | null {
  const posts: Record<string, Post> = {
    'Hello World': {
      title: 'Hello World',
      slug: 'Hello World',
      date: '2024-01-15',
      updated: '2026-03-19',
      category: '技术',
      tags: ['博客', '入门'],
      excerpt: '这是我的第一篇博客文章，欢迎来到我的博客！',
      cover: 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=1000&q=80',
      draft: false,
      path: 'posts/Hello World.md',
      readingTime: 1,
      content: `# Hello World

欢迎来到我的博客！🎉

这是一篇示例文章，用于展示博客系统的基本功能。

## 特性

- 📝 文章存储在 Git 仓库中
- 🚀 通过 GitHub Raw API 动态拉取，无需重新部署
- ⚡ KV 缓存加速访问
- 🏷️ 支持分类和标签
- 🔗 直接通过 \`/posts/文章标题\` 访问，无需单独指定 slug

## 代码示例

\`\`\`typescript
const greeting = 'Hello, World!'
console.log(greeting)
\`\`\`

## 如何添加新文章

1. 在 \`posts/\` 目录下创建 \`.md\` 文件
2. 填写 frontmatter（只需标题、日期、分类等，无需写 slug）
3. 运行 \`pnpm gen:manifest\` 更新文章清单
4. 推送到 GitHub，文章自动生效！`,
    },
    '使用 Hono 构建博客 API': {
      title: '使用 Hono 构建博客 API',
      slug: '使用 Hono 构建博客 API',
      date: '2024-01-20',
      category: '技术',
      tags: ['Hono', 'Cloudflare Workers', 'TypeScript'],
      excerpt: '本文介绍如何使用 Hono 框架在 Cloudflare Workers 上构建一个轻量级博客 API。',
      draft: false,
      path: 'posts/使用 Hono 构建博客 API.md',
      readingTime: 3,
      content: `# 使用 Hono 构建博客 API

Hono 是一个小巧、快速的 Web 框架，专为 Edge Runtime 设计。

## 为什么选择 Hono？

- **超快**：基于 Web 标准 API，零开销
- **轻量**：核心包只有几 KB
- **类型安全**：原生 TypeScript 支持
- **中间件丰富**：内置 CORS、JWT、Logger 等

## 架构设计

我们的博客采用了一种独特的架构：

\`\`\`
用户请求 → Cloudflare Worker → KV 缓存?
                                  ├─ 命中 → 返回缓存
                                  └─ 未命中 → GitHub Raw API → 缓存 → 返回
\`\`\`

这种方式的好处是内容和代码完全解耦，更新文章无需触发构建和部署。`,
    },
  }

  // 同时也支持原有的兼容 key
  if (posts[identifier]) return posts[identifier]
  if (identifier === 'hello-world') return posts['Hello World']
  if (identifier === 'building-blog-with-hono') return posts['使用 Hono 构建博客 API']

  return null
}

function getBuiltinFriends(): FriendLink[] {
  if (Array.isArray(defaultFriendsRaw) && defaultFriendsRaw.length > 0) {
    return defaultFriendsRaw as FriendLink[]
  }
  return [
    {
      title: 'Fuwari',
      url: 'https://github.com/saicaca/fuwari',
      description: '✨ A static blog theme powered by Astro & Tailwind CSS',
      avatar: 'https://github.com/saicaca.png',
    },
    {
      title: 'Hono',
      url: 'https://hono.dev',
      description: 'Ultrafast web framework for the Cloudflare Workers & Edge',
      avatar: 'https://github.com/honojs.png',
    },
    {
      title: 'Cloudflare',
      url: 'https://cloudflare.com',
      description: 'Connect, protect, and build everywhere',
      avatar: 'https://github.com/cloudflare.png',
    },
  ]
}

function getBuiltinAbout(): AboutContent {
  return {
    title: '关于本站',
    description: '了解本站的技术架构、个人介绍与建站初衷',
    content: `欢迎来到我的个人博客！本站基于 [Hono](https://hono.dev) 框架构建，致力于打造一个极速、轻量、高可定制的现代化独立博客空间。

## 核心特性

- 📝 **Git 驱动的内容管理**：所有文章与页面均以 Markdown 格式存放在 GitHub 仓库中，通过 [Pages CMS](https://pagescms.org) 或 Git 即可在线可视化编辑与管理。
- 🚀 **零重部署动态更新**：服务运行时直接从 GitHub Raw API 动态拉取最新内容并写入边缘缓存（Cloudflare KV / Unstorage），推送 Markdown 即可秒级生效，无需等待漫长的静态构建。
- 🎨 **Fuwari 视觉美学**：精巧的卡片化布局、平滑的流式动效、全端自适应响应以及优雅的暗色模式体验。
- ⚡ **跨云多平台部署**：完美支持一键部署到 Cloudflare Workers、Vercel 及 Netlify，多边缘节点极速响应全球访问。

## 关于我

这里是我的数字花园，我会在这个小站里分享：
- 前端与全栈技术探索（TypeScript、Hono、Cloudflare Workers 等）
- 效率工具、自动化工作流与开源项目实践
- 日常生活与思考随笔

如果你想与我交流，欢迎通过导航栏中的社交媒体链接联系我，或者前往 [友链](/links) 页面互相认识！`,
  }
}
