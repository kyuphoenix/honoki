import { Hono } from 'hono'
import { raw } from 'hono/html'
import { marked } from 'marked'
import type { AppEnv } from '../types/env.js'
import { Layout } from '../components/index.js'
import { getSidebarData, getBlogConfig, getAboutContent } from '../services/github.js'
import { processEmbeddedMediaHtml, isHtmlRenderCodeBlock } from '../utils/markdown.js'
import { setTieredCache } from '../utils/cache.js'
import { i18n, I18nKey } from '../i18n/index.js'

const about = new Hono<AppEnv>()

about.get('/', async (c) => {
  const [{ categories, tags }, siteConfig, aboutData] = await Promise.all([
    getSidebarData(c.env),
    getBlogConfig(c.env),
    getAboutContent(c.env),
  ])

  // 配置 marked 渲染器，使外链在新标签页打开
  const renderer = new marked.Renderer()
  renderer.link = function ({ href, title, tokens }: any) {
    const linkText = (this as any).parser.parseInline(tokens)
    const isExternal = typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://'))
    const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : ''
    const titleAttr = title ? ` title="${title}"` : ''
    return `<a href="${href}"${targetAttr}${titleAttr}>${linkText}</a>`
  }

  renderer.html = function ({ text }: { text: string }) {
    return processEmbeddedMediaHtml(text)
  }

  const origCode = renderer.code.bind(renderer)
  renderer.code = function (token: any) {
    if (isHtmlRenderCodeBlock(token?.lang)) {
      return processEmbeddedMediaHtml(token?.text || '')
    }
    return origCode(token)
  }

  const rawHtmlContent = await marked.parse(aboutData.content, {
    gfm: true,
    breaks: true,
    renderer,
  })
  const htmlContent = processEmbeddedMediaHtml(rawHtmlContent)

  const pageTitle = aboutData.title || i18n(I18nKey.about, siteConfig.lang)
  const pageDescription =
    aboutData.description || `关于本站 - 了解 ${siteConfig.title} 的技术架构、个人介绍与建站初衷`

  // 关于页边缘缓存 30 分钟，SWR 24 小时
  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['page', 'about'] })

  return c.html(
    <Layout
      title={pageTitle}
      description={pageDescription}
      currentPath="/about"
      isHomePage={false}
      categories={categories}
      tags={tags}
      blogUrl={c.env.BLOG_URL || new URL(c.req.url).origin}
      siteConfig={siteConfig}
      env={c.env}
    >
      <div
        class="fuwari-card-base z-10 px-6 md:px-9 pt-6 pb-8 relative w-full fuwari-onload-animation"
        style="animation-delay: 150ms"
      >
        <div class="relative mb-6">
          <h1 class="transition w-full block font-bold text-3xl fuwari-text-90 md:before:w-1 before:h-5 before:rounded-md before:bg-(--fuwari-primary) before:absolute before:top-2.5 before:-left-4.5">
            {pageTitle}
          </h1>
        </div>

        <div class="prose dark:prose-invert prose-base max-w-none! fuwari-custom-md">
          {raw(htmlContent)}
        </div>
      </div>
    </Layout>
  )
})

export default about
