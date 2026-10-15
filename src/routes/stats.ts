import { Hono } from 'hono'
import type { AppEnv } from '../types/env.js'
import {
  recordPageView,
  getTopPosts,
  getPostStats,
  getAllPostStats,
  resolveDatabaseType,
  isStatsEnabled,
} from '../services/stats.js'

const stats = new Hono<AppEnv>()

// 常见搜索引擎蜘蛛与爬虫 UA 过滤（参考 Umami 实现：防止机器刷量）
const BOT_UA_REGEX =
  /(bot|spider|crawl|slurp|googlebot|bingbot|yandex|baidu|duckduck|facebookexternalhit|whatsapp|twitterbot|slackbot|applebot)/i

/**
 * 收集页面访问（支持前端 Beacon 或 fetch POST 调用）
 */
stats.post('/view', async (c) => {
  if (!isStatsEnabled(c.env)) {
    return c.json({ success: true, enabled: false, message: 'Stats feature is disabled' })
  }

  const userAgent = c.req.header('user-agent') || ''

  // 1. 过滤爬虫
  if (BOT_UA_REGEX.test(userAgent)) {
    return c.json({ success: true, message: 'Ignored bot' })
  }

  try {
    const body = await c.req.json().catch(() => ({}))
    const slug = (body.slug || '').trim()

    if (!slug) {
      return c.json({ success: false, message: 'Missing slug' }, 400)
    }

    const rawIp =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-client-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0] ||
      '127.0.0.1'
    const ip = rawIp.trim()
    const country =
      c.req.header('cf-ipcountry') ||
      c.req.header('x-vercel-ip-country') ||
      c.req.header('x-country') ||
      ''

    const result = await recordPageView(c.env, {
      slug,
      url: body.url || '',
      referrer: body.referrer || '',
      userAgent,
      ip,
      country,
      sessionId: body.sessionId || '',
      clientTracked: Boolean(body.clientTracked),
      language: body.language || '',
      screen: body.screen || '',
    })

    return c.json({
      success: true,
      data: result,
    })
  } catch (err: any) {
    return c.json({ success: false, message: err.message }, 500)
  }
})

/**
 * 批量获取全部文章的访问统计映射字典（供主页异步渲染浏览量使用）
 */
stats.get('/all', async (c) => {
  if (!isStatsEnabled(c.env)) {
    return c.json({ success: true, enabled: false, data: {} })
  }
  try {
    const data = await getAllPostStats(c.env)
    c.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
    return c.json({ success: true, enabled: true, data })
  } catch (err: any) {
    return c.json({ success: false, enabled: true, data: {}, message: err.message }, 500)
  }
})

/**
 * 获取访问量最高的前 N 篇文章
 */
stats.get('/top', async (c) => {
  if (!isStatsEnabled(c.env)) {
    return c.json({ success: true, enabled: false, data: [] })
  }
  const limit = Math.min(20, Math.max(1, parseInt(c.req.query('limit') || '3', 10)))
  const data = await getTopPosts(c.env, limit)
  return c.json({ success: true, enabled: true, data })
})

/**
 * 获取指定文章的访问统计
 */
stats.get('/post', async (c) => {
  if (!isStatsEnabled(c.env)) {
    return c.json({ success: true, enabled: false, data: { views: 0, uv: 0 } })
  }
  const slug = c.req.query('slug') || ''
  if (!slug) {
    return c.json({ success: false, message: 'Missing slug' }, 400)
  }
  try {
    const data = await getPostStats(c.env, slug)
    c.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
    return c.json({ success: true, enabled: true, data })
  } catch (err: any) {
    return c.json({ success: false, enabled: true, data: { views: 0, uv: 0 }, message: err.message }, 500)
  }
})

/**
 * 查询当前生效的数据库/统计提供方与连接状态
 */
stats.get('/status', (c) => {
  const type = resolveDatabaseType(c.env)
  const enabled = isStatsEnabled(c.env)
  // 仅暴露非敏感状态,不返回 websiteId / hasApiKey 等配置细节
  return c.json({
    success: true,
    data: {
      provider: type || 'none',
      configured: Boolean(type),
      enabled,
    },
  })
})

export default stats
