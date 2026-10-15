import type { Context } from 'hono'
import type { AppEnv } from '../types/env.js'

export interface CacheOptions {
  browserMaxAge?: number
  edgeMaxAge?: number
  swrMaxAge?: number
  tags?: string[]
}

export type DeployPlatform = 'cloudflare' | 'netlify' | 'vercel'

/**
 * 智能探测当前代码运行的宿主平台 (Cloudflare Workers / Netlify / Vercel)
 *
 * 识别依据：
 * 1. 优先读取显式注入的环境变量 DEPLOY_PLATFORM (单一绝对事实源)
 * 2. 检查各厂商特有的原生环境变量 (VERCEL, NETLIFY)
 * 3. 运行时原生对象与默认回退 (默认 Cloudflare Workers)
 */
export function detectPlatform(c?: Context): DeployPlatform {
  // 1. 优先读取显式注入的环境变量 (最精准)
  const envPlatform =
    (c?.env as any)?.DEPLOY_PLATFORM ||
    (typeof process !== 'undefined' ? process.env?.DEPLOY_PLATFORM : undefined)

  if (envPlatform) {
    const p = String(envPlatform).toLowerCase().trim()
    if (p === 'cloudflare' || p === 'cf') return 'cloudflare'
    if (p === 'netlify') return 'netlify'
    if (p === 'vercel') return 'vercel'
  }

  // 2. 检查各云厂商特有的原生运行期环境变量
  if (typeof process !== 'undefined') {
    if (process.env?.VERCEL === '1' || process.env?.VERCEL_ENV) {
      return 'vercel'
    }
    if (process.env?.NETLIFY === 'true' || process.env?.NETLIFY) {
      return 'netlify'
    }
  }

  // 3. 检查全局运行时特征
  if (typeof (globalThis as any).Netlify !== 'undefined') {
    return 'netlify'
  }

  // 4. Cloudflare Workers 特有全局对象或默认回退
  if (
    typeof (globalThis as any).WebSocketPair !== 'undefined' &&
    typeof (globalThis as any).caches !== 'undefined'
  ) {
    return 'cloudflare'
  }

  return 'cloudflare'
}

/**
 * 设置多平台分层缓存与 SWR (Stale-While-Revalidate) 响应头
 *
 * 分层策略(Cloudflare Workers Cache 语义):
 * 1. 浏览器层:仅用 Cache-Control 的 max-age 控制。默认 0 表示每次使用前都必须回边缘校验,
 *    保证 CDN 失效后用户能立即看到最新内容,同时避免本地磁盘死缓存。
 * 2. 边缘 CDN 层:用平台专属头(CF 为 Cloudflare-CDN-Cache-Control,下发客户端前会被剥离)
 *    承载较长的边缘 TTL 与 SWR,使浏览器 TTL 与边缘 TTL 解耦。
 *
 * 关键约束(否则 SWR 会静默失效):s-maxage / must-revalidate / proxy-revalidate
 * 三者中任意一个出现都会禁用 stale-while-revalidate(RFC 9111 §4.2.4),因此边缘 TTL
 * 一律使用 max-age 表达,且不输出 must-revalidate。
 *
 * 平台严格隔离:根据部署平台自动按需输出对应标头,Cloudflare 部署绝不输出 Netlify / Vercel 专属私有头。
 */
export function setTieredCache(c: Context, options: CacheOptions = {}) {
  const browserMaxAge = options.browserMaxAge ?? 0
  const edgeMaxAge = options.edgeMaxAge ?? 86400 // 默认 24 小时
  const swrMaxAge = options.swrMaxAge ?? 604800 // 默认 7 天
  const tags = options.tags || ['page']

  const platform = detectPlatform(c)

  // 1. 浏览器缓存:只用 max-age。max-age=0 即"每次使用前必须回边缘校验"。
  c.header('Cache-Control', `public, max-age=${browserMaxAge}`)

  // 2. 边缘 CDN 缓存:输出平台专属控制头(边缘 TTL 与 SWR 用 max-age 表达,避免禁用 SWR)
  if (platform === 'cloudflare') {
    // Cloudflare Workers Cache 以 Cloudflare-CDN-Cache-Control 为最高优先级指令,
    // 且在返回客户端前剥离该头;启用 wrangler 的 cache.enabled 后,边缘据此缓存与 SWR。
    const edgeDirective = `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    c.header('Cloudflare-CDN-Cache-Control', edgeDirective)
    c.header('CDN-Cache-Control', edgeDirective)

    // Cache-Tag:供 ctx.cache.purge({ tags }) 精准失效。CF 消费后剥离,不下发客户端。
    // 标签必须是可打印 ASCII(0x21-0x7E)且 <=1024 字符,否则会被静默丢弃。
    const safeTags = tags.filter(
      (t) => typeof t === 'string' && t.length > 0 && t.length <= 1024 && /^[\x21-\x7E]+$/.test(t)
    )
    if (safeTags.length > 0) {
      c.header('Cache-Tag', safeTags.join(','))
    }
  } else if (platform === 'netlify') {
    // Netlify 专属:Netlify 边缘节点 CDN 控制头与细粒度标签
    c.header(
      'Netlify-CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
    if (tags.length > 0) {
      c.header('Netlify-Cache-Tag', tags.join(','))
    }
  } else {
    // Vercel 专属:标准 CDN 标头与 Vercel Edge Cache 精准 Purge 标签
    c.header(
      'CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
    if (tags.length > 0) {
      c.header('Vercel-Cache-Tag', tags.join(','))
    }
  }
}

/**
 * 设置完全禁止缓存响应头 (适用于 404、管理接口、主动 Purge 等敏感/动态场景)
 */
export function setNoCache(c: Context) {
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate')
  c.header('Pragma', 'no-cache')
  c.header('Expires', '0')
}

export interface PurgeWorkersCacheResult {
  attempted: boolean
  success: boolean
  message: string
}

/**
 * 清除 Cloudflare Workers Cache(即 wrangler `cache.enabled: true` 启用的那层缓存)。
 *
 * 重要:zone 级 purge_cache API(见 purgePlatformCaches)对 Workers Cache **无效**,
 * 必须通过 ctx.cache.purge() / cache.purge() 才能清掉。purge 的作用域是调用它的 entrypoint。
 *
 * 优先按 tags 精准失效;若传入 purgeEverything 则清空该 entrypoint 的全部缓存。
 * 在非 Cloudflare / 无 executionCtx 环境(本地 dev、Vercel、Netlify)安全跳过。
 */
export async function purgeWorkersCache(
  c: Context,
  options?: { tags?: string[]; purgeEverything?: boolean }
): Promise<PurgeWorkersCacheResult> {
  const tags = (options?.tags || []).filter(
    (t) => typeof t === 'string' && t.length > 0 && t.length <= 1024 && /^[\x21-\x7E]+$/.test(t)
  )

  let execCtx: any = null
  try {
    execCtx = c.executionCtx
  } catch {
    // 无 ExecutionContext(本地 dev / 非 Workers 运行时)
    execCtx = null
  }

  const cacheCtx = execCtx?.cache
  if (!cacheCtx || typeof cacheCtx.purge !== 'function') {
    return {
      attempted: false,
      success: false,
      message: 'Workers Cache 清理跳过: 当前运行时不提供 ctx.cache(非 Cloudflare Workers 或未启用 cache)',
    }
  }

  try {
    const purgeOptions = options?.purgeEverything
      ? { purgeEverything: true }
      : tags.length > 0
        ? { tags }
        : null

    if (!purgeOptions) {
      return {
        attempted: false,
        success: false,
        message: 'Workers Cache 清理跳过: 未提供有效的 tags 或 purgeEverything',
      }
    }

    const result = await cacheCtx.purge(purgeOptions)
    if (result?.success) {
      return {
        attempted: true,
        success: true,
        message: options?.purgeEverything
          ? 'Workers Cache 已全量清除'
          : `Workers Cache 已按标签 [${tags.join(', ')}] 精准清除`,
      }
    }
    const errMsg =
      (result?.errors || [])
        .map((e: any) => `${e?.code ?? ''} ${e?.message ?? ''}`.trim())
        .filter(Boolean)
        .join('; ') || '未知错误'
    return {
      attempted: true,
      success: false,
      message: `Workers Cache 清除失败: ${errMsg}`,
    }
  } catch (err: any) {
    return {
      attempted: true,
      success: false,
      message: `Workers Cache 清除异常: ${err?.message || err}`,
    }
  }
}

export interface PurgePlatformResult {
  platform: 'cloudflare' | 'netlify' | 'vercel'
  success: boolean
  skipped?: boolean
  message: string
}

export interface PurgePlatformOptions {
  urls?: string[]
  tags?: string[]
  purgeEverything?: boolean
}

/**
 * 生成带超时控制的 AbortSignal，防止厂商 CDN Control Plane API 挂起阻塞请求
 */
function createTimeoutSignal(timeoutMs = 5000): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
  return controller.signal
}

/**
 * 后端直接主动通知各厂商 CDN 清除边缘缓存 (通过厂商官方全局 Control Plane API)
 * 支持精准 URL/Tag 清除（保护全站长效静态图片与未变动老文章不被清空）与全量清除两种模式。
 */
export async function purgePlatformCaches(
  env: AppEnv['Bindings'],
  options?: PurgePlatformOptions
): Promise<PurgePlatformResult[]> {
  const results: PurgePlatformResult[] = []

  // ====================================================
  // 1. Cloudflare zone 级 CDN 缓存清除(仅影响 zone 缓存,例如 /images/* 等静态资源)
  //    注意:此 API 对 Workers Cache(wrangler cache.enabled 启用那层)**无效**,
  //    Worker 生成页面的失效请使用 purgeWorkersCache(ctx.cache.purge)。
  // ====================================================
  let cfZoneId = env?.CLOUDFLARE_ZONE_ID || (env as any)?.CF_ZONE_ID
  const cfToken = env?.CLOUDFLARE_API_TOKEN || (env as any)?.CF_API_TOKEN

  if (!cfToken) {
    results.push({
      platform: 'cloudflare',
      success: true,
      skipped: true,
      message: 'Cloudflare 清理跳过: 未配置 CLOUDFLARE_API_TOKEN',
    })
  } else {
    // 若未显式配置 Zone ID 但有 Token，尝试自动通过 Cloudflare API 查询匹配 Zone ID
    if (!cfZoneId) {
      try {
        const blogUrl = env?.BLOG_URL
        let targetHostname = ''
        if (blogUrl) {
          try {
            targetHostname = new URL(
              blogUrl.startsWith('http') ? blogUrl : `https://${blogUrl}`
            ).hostname.toLowerCase()
          } catch (err: any) {
            console.warn(`[Cache] BLOG_URL 格式解析失败 (${blogUrl}):`, err?.message || err)
          }
        }

        const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
          headers: {
            Authorization: `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
          },
          signal: createTimeoutSignal(5000),
        })
        if (zonesRes.ok) {
          const zonesData = (await zonesRes.json()) as any
          const zones: Array<{ id: string; name: string }> = zonesData?.result || []
          if (targetHostname) {
            const matched = zones.find(
              (z) => targetHostname === z.name.toLowerCase() || targetHostname.endsWith('.' + z.name.toLowerCase())
            )
            if (matched) cfZoneId = matched.id
          }
          if (!cfZoneId && zones.length === 1) {
            cfZoneId = zones[0].id
          }
        } else {
          const errData = (await zonesRes.json().catch(() => ({}))) as any
          const errMsg = errData?.errors?.[0]?.message || `HTTP ${zonesRes.status}`
          console.warn(`[Cache] Cloudflare 自动查询 Zone ID 失败: ${errMsg}`)
        }
      } catch (err: any) {
        console.warn(`[Cache] Cloudflare 查询 Zone ID 发生网络异常: ${err?.message || err}`)
      }
    }

    if (!cfZoneId) {
      results.push({
        platform: 'cloudflare',
        success: false,
        message: 'Cloudflare 清理失败: 无法解析 Zone ID，请在 GitHub Secrets/Variables 中配置 CLOUDFLARE_ZONE_ID',
      })
    } else {
      try {
        const payload: Record<string, any> = {}
        // 优先使用精准 URL 清理，保护 /images/* 静态图片不被误清空
        if (!options?.purgeEverything && options?.urls && options.urls.length > 0) {
          // Cloudflare 单次清除单文件最多支持 30 个 URL
          payload.files = options.urls.slice(0, 30)
        } else {
          payload.purge_everything = true
        }

        const res = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/purge_cache`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: createTimeoutSignal(5000),
          }
        )
        const data = (await res.json().catch(() => ({}))) as any
        if (res.ok && data.success) {
          results.push({
            platform: 'cloudflare',
            success: true,
            message: payload.purge_everything
              ? 'Cloudflare 全量缓存已成功清除'
              : `Cloudflare ${payload.files.length} 个页面缓存已精准清除`,
          })
        } else {
          const errorMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`
          results.push({
            platform: 'cloudflare',
            success: false,
            message: `Cloudflare 清除失败: ${errorMsg}`,
          })
        }
      } catch (e: any) {
        results.push({
          platform: 'cloudflare',
          success: false,
          message: `Cloudflare 网络异常: ${e?.message || e}`,
        })
      }
    }
  }

  // ====================================================
  // 2. Netlify 边缘 CDN 缓存清除
  // ====================================================
  const netlifySiteId = env?.NETLIFY_SITE_ID || (env as any)?.NETLIFY_SITE_SLUG
  const netlifyToken =
    env?.NETLIFY_AUTH_TOKEN ||
    (env as any)?.NETLIFY_TOKEN ||
    (env as any)?.NETLIFY_PAT ||
    (env as any)?.NETLIFY_API_KEY

  if (!netlifySiteId || !netlifyToken) {
    results.push({
      platform: 'netlify',
      success: true,
      skipped: true,
      message: 'Netlify 清理跳过: 未配置 NETLIFY_SITE_ID 或 NETLIFY_AUTH_TOKEN',
    })
  } else {
    try {
      const payload: Record<string, any> = {
        site_id: netlifySiteId,
      }
      if (!options?.purgeEverything && options?.tags && options.tags.length > 0) {
        payload.cache_tags = options.tags
      }

      const res = await fetch('https://api.netlify.com/api/v1/purge', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${netlifyToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: createTimeoutSignal(5000),
      })
      if (res.ok) {
        results.push({
          platform: 'netlify',
          success: true,
          message: payload.cache_tags
            ? `Netlify 标签 [${payload.cache_tags.join(', ')}] 缓存已成功清除`
            : 'Netlify 全站缓存已成功清除',
        })
      } else {
        const text = await res.text().catch(() => '')
        results.push({
          platform: 'netlify',
          success: false,
          message: `Netlify 清除失败: HTTP ${res.status} ${text}`,
        })
      }
    } catch (e: any) {
      results.push({
        platform: 'netlify',
        success: false,
        message: `Netlify 网络异常: ${e?.message || e}`,
      })
    }
  }

  // ====================================================
  // 3. Vercel 边缘 CDN 缓存清除
  // ====================================================
  const vercelToken =
    env?.VERCEL_TOKEN ||
    (env as any)?.VERCEL_API_KEY ||
    (env as any)?.VERCEL_AUTH_TOKEN
  const vercelProjectId =
    env?.VERCEL_PROJECT_ID ||
    (env as any)?.VERCEL_PROJECT_NAME
  const vercelOrgId = env?.VERCEL_ORG_ID
  const vercelHook = env?.VERCEL_DEPLOY_HOOK_URL || (env as any)?.VERCEL_HOOK_URL

  if (vercelToken && vercelProjectId) {
    try {
      const teamQuery = vercelOrgId ? `&teamId=${encodeURIComponent(vercelOrgId)}` : ''
      // 常规更新使用传入的精准 tags；全量清理则清理全部伞状标签与功能标签
      const targetTags =
        !options?.purgeEverything && options?.tags && options.tags.length > 0
          ? options.tags
          : ['page', 'post', 'api', 'rss', 'sitemap', 'robots', 'home', 'archive', 'links', 'about', 'posts', 'categories', 'tags']

      const res = await fetch(
        `https://api.vercel.com/v1/edge-cache/dangerously-delete-by-tags?projectIdOrName=${encodeURIComponent(vercelProjectId)}${teamQuery}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${vercelToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tags: targetTags,
            target: 'production',
          }),
          signal: createTimeoutSignal(5000),
        }
      )
      if (res.ok) {
        results.push({
          platform: 'vercel',
          success: true,
          message: `Vercel 官方 Edge Cache API 成功清除 CDN 缓存 (标签: ${targetTags.join(', ')})`,
        })
      } else {
        const text = await res.text().catch(() => '')
        results.push({
          platform: 'vercel',
          success: false,
          message: `Vercel Edge Cache API 清除失败: HTTP ${res.status} ${text}`,
        })
      }
    } catch (e: any) {
      results.push({
        platform: 'vercel',
        success: false,
        message: `Vercel Edge Cache API 网络异常: ${e?.message || e}`,
      })
    }
  } else if (vercelHook) {
    try {
      const res = await fetch(vercelHook, {
        method: 'POST',
        signal: createTimeoutSignal(5000),
      })
      if (res.ok) {
        results.push({
          platform: 'vercel',
          success: true,
          message: 'Vercel Deploy Hook 触发成功，正在重新构建并刷新全球 CDN',
        })
      } else {
        results.push({
          platform: 'vercel',
          success: false,
          message: `Vercel Deploy Hook 触发失败: HTTP ${res.status}`,
        })
      }
    } catch (e: any) {
      results.push({
        platform: 'vercel',
        success: false,
        message: `Vercel Deploy Hook 网络异常: ${e?.message || e}`,
      })
    }
  } else {
    results.push({
      platform: 'vercel',
      success: true,
      skipped: true,
      message: 'Vercel 清理跳过: 未配置 VERCEL_TOKEN 或 VERCEL_DEPLOY_HOOK_URL',
    })
  }

  return results
}
