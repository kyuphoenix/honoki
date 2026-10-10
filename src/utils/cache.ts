import type { Context } from 'hono'
import type { AppEnv } from '../types/env.js'

export interface CacheOptions {
  browserMaxAge?: number
  edgeMaxAge?: number
  swrMaxAge?: number
  tags?: string[]
}

export type DeployPlatform = 'cloudflare' | 'netlify' | 'vercel' | 'generic'

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
 * 分层策略：
 * 1. 客户端浏览器 (Browser)：默认 max-age=0, must-revalidate
 *    - 确保用户刷新或导航时总是向边缘 CDN 验证，CDN 缓存失效后用户能即时看到最新内容，避免被本地磁盘死缓存拦截。
 * 2. 边缘 CDN (Edge CDN)：
 *    - s-maxage: 支持由调用方传入差异化 TTL (聚合列表页 30 分钟，文章详情页 24 小时)。
 *    - stale-while-revalidate (SWR): 聚合页 1 天，文章页 7 天。
 *    - 平台严格隔离：根据部署平台自动按需输出对应标头，Cloudflare 部署绝不输出 Netlify / Vercel 专属私有头。
 */
export function setTieredCache(c: Context, options: CacheOptions = {}) {
  const browserMaxAge = options.browserMaxAge ?? 0
  const edgeMaxAge = options.edgeMaxAge ?? 86400 // 默认 24 小时
  const swrMaxAge = options.swrMaxAge ?? 604800 // 默认 7 天
  const tags = options.tags || ['page']

  const platform = detectPlatform(c)

  // 1. 标准 HTTP 缓存头 (通用浏览器与所有边缘 CDN 遵循的标准规范)
  c.header(
    'Cache-Control',
    `public, max-age=${browserMaxAge}, s-maxage=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}, must-revalidate`
  )

  // 2. 根据部署运行的宿主平台，按需输出对应平台的专属边缘控制头与标签，彻底隔离其他平台的标头
  if (platform === 'cloudflare') {
    // Cloudflare 专属：优先级高于标准 Cache-Control，指示 CF 边缘节点强缓存与 SWR
    // 注：Cloudflare 非企业版不支持通过 Cache-Tag 头清除，故仅输出边缘 TTL 控制头
    c.header(
      'Cloudflare-CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
    c.header(
      'CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
  } else if (platform === 'netlify') {
    // Netlify 专属：Netlify 边缘节点 CDN 控制头与细粒度标签
    c.header(
      'Netlify-CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
    if (tags.length > 0) {
      c.header('Netlify-Cache-Tag', tags.join(','))
    }
  } else if (platform === 'vercel') {
    // Vercel 专属：标准 CDN 标头与 Vercel Edge Cache 精准 Purge 标签
    c.header(
      'CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
    if (tags.length > 0) {
      c.header('Vercel-Cache-Tag', tags.join(','))
    }
  } else {
    // 通用环境：输出标准 RFC 9213 CDN-Cache-Control
    c.header(
      'CDN-Cache-Control',
      `public, max-age=${edgeMaxAge}, stale-while-revalidate=${swrMaxAge}`
    )
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
 * 后端直接主动通知各厂商 CDN 清除边缘缓存 (通过厂商官方全局 Control Plane API)
 * 支持精准 URL 清除（保护全站长效静态图片不被清空）与全量清除两种模式。
 */
export async function purgePlatformCaches(
  env: AppEnv['Bindings'],
  options?: PurgePlatformOptions
): Promise<PurgePlatformResult[]> {
  const results: PurgePlatformResult[] = []

  // ====================================================
  // 1. Cloudflare 全局 CDN 缓存清除
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
          } catch {}
        }

        const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
          headers: {
            Authorization: `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
          },
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
      const targetTags =
        !options?.purgeEverything && options?.tags && options.tags.length > 0
          ? options.tags
          : ['page', 'post', 'posts', 'home', 'archive', 'about', 'links', 'all-posts']

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
