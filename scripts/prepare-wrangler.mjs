/**
 * 仅用于处理 Cloudflare 基础设施级别的必须文件配置（如 KV ID、Worker 名称、自定义域名路由、环境变量注入）。
 * 
 * 核心特性：
 * 1. 自动资源嗅探与绑定：若环境变量中配置了具备权限的 CLOUDFLARE_API_TOKEN，
 *    自动检测或创建 KV (honoki_kv)，彻底免去用户手动获取与填写 CLOUDFLARE_KV_ID 的繁琐操作！
 * 2. 权限自适应与安全降级：若 Token 权限受限或未提供，安全降级为内存缓存，绝不阻断部署。
 * 3. 彻底免数据库：统计采用 Umami 纯 API 方案，无需任何 D1 / Supabase 数据库资源与权限。
 * 4. 环境变量（BLOG_URL、GISCUS_*、GH_*、UMAMI_* 等）通过 CI/CD 运行时直接注入，不落盘敏感密钥。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const configPath = resolve(process.cwd(), 'wrangler.jsonc')
const rawContent = readFileSync(configPath, 'utf-8')

let content = rawContent

let kvId = (process.env.CLOUDFLARE_KV_ID || process.env.KV_NAMESPACE_ID)?.trim()
const workerName = process.env.WORKER_NAME?.trim()
const blogUrl = process.env.BLOG_URL?.trim()
const umamiWebsiteId = (process.env.UMAMI_WEBSITE_ID || process.env.UMAMI_ID)?.trim()
const umamiHost = (process.env.UMAMI_HOST || process.env.UMAMI_URL || process.env.UMAMI_ENDPOINT)?.trim()

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.ACCOUNT_ID)?.trim()

// 辅助函数：安全移除 wrangler.jsonc 中的 kv_namespaces 绑定
function stripKVNamespaces(text) {
  return text.replace(/,\s*\/\/[^\n]*\n\s*"kv_namespaces":\s*\[[\s\S]*?\]/, '')
}

// 辅助函数：安全移除任何残留的 d1_databases 绑定
function stripD1Databases(text) {
  return text.replace(/,\s*(?:\/\/[^\n]*\n\s*)?"d1_databases":\s*\[[\s\S]*?\]/, '')
}

async function resolveCloudflareAutoResources() {
  if (!apiToken) {
    return { autoKvId: null, autoZoneId: null }
  }

  const apiHeaders = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }

  // 1. 若未显式传入 accountId，自动通过 Cloudflare API 查询获取
  if (!accountId) {
    try {
      const accRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
        headers: apiHeaders,
      })
      if (accRes.ok) {
        const accData = await accRes.json()
        if (accData.result && accData.result.length > 0) {
          accountId = accData.result[0].id
          console.log(`✓ 自动解析 Cloudflare 账户 ID: ${accountId}`)
        }
      }
    } catch (e) {
      console.warn(`⚠️ 查询 Cloudflare 账户异常: ${e.message}`)
    }
  }

  if (!accountId) {
    return { autoKvId: null, autoZoneId: null }
  }

  let autoKvId = null

  // 2. 自动探测或创建 KV 命名空间 (honoki_kv)
  if (!kvId) {
    try {
      const kvListRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
        { headers: apiHeaders }
      )
      if (kvListRes.ok) {
        const kvData = await kvListRes.json()
        const existing = (kvData.result || []).find(
          (ns) =>
            ns.title === 'honoki_kv' ||
            ns.title === 'honoki-kv' ||
            ns.title === 'HONOKI_KV' ||
            ns.title === 'blog-cache' ||
            ns.title === 'blog_cache' ||
            ns.title === 'BLOG_CACHE'
        )
        if (existing) {
          autoKvId = existing.id
          console.log(`✓ [自动复用] 检测到已有 Cloudflare KV 命名空间: ${existing.title} (ID: ${autoKvId})`)
        } else {
          console.log('ℹ️ Cloudflare 账户下未找到 honoki_kv，正在根据 Token 权限自动创建 KV 命名空间...')
          const createKvRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
            {
              method: 'POST',
              headers: apiHeaders,
              body: JSON.stringify({ title: 'honoki_kv' }),
            }
          )
          if (createKvRes.ok) {
            const createData = await createKvRes.json()
            autoKvId = createData.result?.id
            console.log(`✓ [自动创建] 成功创建并绑定 Cloudflare KV: honoki_kv (ID: ${autoKvId})`)
          } else {
            console.log(`ℹ️ 自动创建 KV 返回状态 [${createKvRes.status}]，Token 未包含 Workers KV 编辑权限（将自动使用内存缓存）`)
          }
        }
      } else {
        console.log(`ℹ️ 查询 KV 列表返回状态 [${kvListRes.status}]，Token 未包含 Workers KV 读取权限`)
      }
    } catch (err) {
      console.warn(`⚠️ 自动检测/创建 KV 异常: ${err.message}`)
    }
  }

  // 3. 自动探测 Cloudflare Zone ID (如果未显式提供 CLOUDFLARE_ZONE_ID)
  let autoZoneId = null
  let zoneId = (process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID)?.trim()
  if (!zoneId) {
    try {
      const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=50', {
        headers: apiHeaders,
      })
      if (zonesRes.ok) {
        const zonesData = await zonesRes.json()
        const zones = zonesData.result || []
        let targetHost = ''
        if (blogUrl) {
          try {
            targetHost = new URL(blogUrl.startsWith('http') ? blogUrl : `https://${blogUrl}`).hostname.toLowerCase()
          } catch {}
        }
        if (targetHost) {
          const matched = zones.find(
            (z) => targetHost === z.name.toLowerCase() || targetHost.endsWith('.' + z.name.toLowerCase())
          )
          if (matched) autoZoneId = matched.id
        }
        if (!autoZoneId && zones.length === 1) {
          autoZoneId = zones[0].id
        }
        if (autoZoneId) {
          console.log(`✓ [自动发现] 解析到 Cloudflare Zone ID: ${autoZoneId}`)
        }
      }
    } catch (err) {
      console.warn(`⚠️ 自动查询 Zone 异常: ${err.message}`)
    }
  }

  return { autoKvId, autoZoneId }
}

async function main() {
  // 0. 执行 Cloudflare API 自动资源探测（根据 API Token 权限自动创建与绑定 KV/Zone）
  const { autoKvId, autoZoneId } = await resolveCloudflareAutoResources()
  if (!kvId && autoKvId) {
    kvId = autoKvId
  }
  const resolvedZoneId = (process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID)?.trim() || autoZoneId

  // 1. 注入 KV 命名空间 ID（若未提供且仍为占位符则安全移除，unstorage 会自动平滑降级为内存缓存）
  if (kvId && kvId.trim()) {
    content = content.replace(/"id":\s*"[^"]*"/, `"id": "${kvId.trim()}"`)
    console.log(`✓ 已注入 KV 命名空间 ID: ${kvId.trim()}`)
  } else if (content.includes('<YOUR_KV_NAMESPACE_ID>')) {
    content = stripKVNamespaces(content)
    console.warn('⚠️ 未检测到可用 KV 绑定，已安全移除 KV 占位符（unstorage 自动使用内存缓存）')
  }

  // 2. 清理任何可能残留的 D1 绑定（本项目全面采用 Umami 纯 API 统计，无需任何 D1 数据库）
  content = stripD1Databases(content)

  // 3. 自定义 Worker 服务名称（可选）
  if (workerName && workerName.trim()) {
    content = content.replace(/"name":\s*"[^"]*"/, `"name": "${workerName.trim()}"`)
    console.log(`✓ 已设置 Worker 名称: ${workerName.trim()}`)
  }

  // 4. 自定义域名路由（仅当显式设置 CLOUDFLARE_BIND_ROUTES=true 时才注入）
  const shouldBindRoutes = process.env.CLOUDFLARE_BIND_ROUTES === 'true' || process.env.BIND_CUSTOM_DOMAIN === 'true'
  if (shouldBindRoutes && blogUrl && blogUrl.trim()) {
    try {
      const raw = blogUrl.trim()
      const parsed = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`)
      const hostname = parsed.hostname

      if (hostname && !hostname.endsWith('.workers.dev') && hostname !== 'localhost') {
        if (!content.includes('"routes"')) {
          const routeBlock = `,\n  // 自定义域名（由 BLOG_URL 自动解析）\n  "routes": [\n    {\n      "pattern": "${hostname}",\n      "custom_domain": true\n    }\n  ]`
          content = content.replace(/(\n\})[\s]*$/, `${routeBlock}\n}`)
          console.log(`✓ 已从 BLOG_URL 自动解析并绑定自定义域名: ${hostname}`)
        } else {
          content = content.replace(/"pattern":\s*"[^"]*"/, `"pattern": "${hostname}"`)
          console.log(`✓ 已更新自定义域名: ${hostname}`)
        }
      }
    } catch (err) {
      console.warn('⚠️ 无法从 BLOG_URL 解析域名:', err.message)
    }
  }

  // 5. 动态注入非敏感运行期环境变量（仅注入有效配置项，未配置项自动忽略，彻底避免部署报错）
  const runtimeVars = {
    DEPLOY_PLATFORM: 'cloudflare',
    CLOUDFLARE_ZONE_ID: resolvedZoneId || undefined,
    GH_OWNER: (process.env.GH_OWNER || process.env.GITHUB_OWNER)?.trim(),
    GH_REPO: (process.env.GH_REPO || process.env.GITHUB_REPO)?.trim(),
    GH_BRANCH: (process.env.GH_BRANCH || process.env.GITHUB_BRANCH)?.trim(),
    BLOG_URL: blogUrl || undefined,
    UMAMI_HOST: umamiHost || undefined,
    UMAMI_WEBSITE_ID: umamiWebsiteId || undefined,
    UMAMI_SCRIPT_URL: process.env.UMAMI_SCRIPT_URL?.trim() || undefined,
    ENABLE_UMAMI_SCRIPT: process.env.ENABLE_UMAMI_SCRIPT?.trim() || undefined,
    GISCUS_REPO: process.env.GISCUS_REPO?.trim() || undefined,
    GISCUS_REPO_ID: process.env.GISCUS_REPO_ID?.trim() || undefined,
    GISCUS_CATEGORY: process.env.GISCUS_CATEGORY?.trim() || undefined,
    GISCUS_CATEGORY_ID: process.env.GISCUS_CATEGORY_ID?.trim() || undefined,
  }

  const activeVars = Object.fromEntries(
    Object.entries(runtimeVars).filter(([_, v]) => v !== undefined && v !== '')
  )

  // 先安全清理可能存在的旧 vars 块
  content = content.replace(/,?\s*(?:\/\/[^\n]*\n\s*)?"vars":\s*\{[\s\S]*?\}/g, '')

  if (Object.keys(activeVars).length > 0) {
    const formattedVars = JSON.stringify(activeVars, null, 2)
      .split('\n')
      .map((line, idx) => (idx === 0 ? line : '  ' + line))
      .join('\n')
    const varsBlock = `,\n  // 运行时非敏感环境变量（由 prepare-wrangler 动态注入有效项，未配置项自动忽略）\n  "vars": ${formattedVars}`
    content = content.replace(/(\n\})[\s]*$/, `${varsBlock}\n}`)
    console.log(`✓ 已向 wrangler.jsonc 注入环境变量: ${Object.keys(activeVars).join(', ')}`)
  }

  writeFileSync(configPath, content, 'utf-8')
  console.log('✅ wrangler.jsonc 基础设施配置完成')
}

main().catch((err) => {
  console.error('❌ 配置 wrangler.jsonc 异常:', err)
  process.exit(1)
})
