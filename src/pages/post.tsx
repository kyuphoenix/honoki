import { Hono } from 'hono'
import { raw } from 'hono/html'
import type { AppEnv } from '../types/env.js'
import { Layout, Giscus, LicenseCard } from '../components/index.js'
import {
  FileTextIcon,
  ClockIcon,
  CalendarIcon,
  EditIcon,
  TagIcon,
  QuoteIcon,
  ChevronRightIcon,
  EyeIcon,
  ListIcon,
  XIcon,
} from '../components/Icons.js'
import { getPost, getManifest, getSidebarData, getBlogConfig } from '../services/github.js'
import { getPostStats, isStatsEnabled } from '../services/stats.js'
import {
  processEmbeddedMediaHtml,
  renderKaTeXMath,
  renderAdmonitions,
  renderEnhancedCodeBlock,
} from '../utils/markdown.js'
import { setTieredCache, setNoCache } from '../utils/cache.js'
import { marked } from 'marked'
import { i18n, I18nKey, formatDate } from '../i18n/index.js'

const postPage = new Hono<AppEnv>()

// 访问 /posts 根路径自动 301 重定向至首页
postPage.get('/', (c) => {
  const url = new URL(c.req.url)
  return c.redirect(`/${url.search}`, 301)
})

// 兼容文章末尾携带斜杠的情况，自动 301 重定向到标准文章路径
postPage.get('/:title/', (c) => {
  const title = c.req.param('title')
  const url = new URL(c.req.url)
  return c.redirect(`/posts/${encodeURIComponent(decodeURIComponent(title))}${url.search}`, 301)
})

interface TocItem {
  id: string
  text: string
  level: number
}

postPage.get('/:title', async (c) => {
  const rawTitle = c.req.param('title')
  const title = decodeURIComponent(rawTitle)
  const [post, { categories, tags }, siteConfig] = await Promise.all([
    getPost(title, c.env),
    getSidebarData(c.env),
    getBlogConfig(c.env),
  ])

  const isDraft = post?.draft === true || (post?.draft as any) === 'true'
  if (!post || isDraft) {
    setNoCache(c)
    return c.html(
      <Layout
        title={i18n(I18nKey.postNotFound, siteConfig.lang)}
        currentPath="/posts"
        categories={categories}
        tags={tags}
        blogUrl={c.env.BLOG_URL || new URL(c.req.url).origin}
        siteConfig={siteConfig}
        env={c.env}
      >
        <div class="fuwari-card-base p-12 text-center fuwari-onload-animation">
          <h1 class="text-4xl font-bold fuwari-text-90 mb-3">404</h1>
          <p class="fuwari-text-50 mb-6">{i18n(I18nKey.postNotFoundDesc, siteConfig.lang)}</p>
          <a
            href="/"
            class="fuwari-btn-primary inline-flex px-5 py-2.5 rounded-xl font-bold text-sm no-underline"
          >
            {i18n(I18nKey.backToHome, siteConfig.lang)}
          </a>
        </div>
      </Layout>,
      404
    )
  }

  // Extract TOC headings and render markdown
  const toc: TocItem[] = []
  const renderer = new marked.Renderer()
  renderer.heading = function ({ tokens, depth }: { tokens: any; depth: number }) {
    const content = (this as any).parser.parseInline(tokens)
    const cleanText = content.replace(/<[^>]+>/g, '').trim()
    const id = 'heading-' + toc.length
    if (depth >= 1 && depth <= 3) {
      toc.push({ id, text: cleanText, level: depth })
    }
    return `<h${depth} id="${id}">${content}</h${depth}>`
  }

  renderer.link = function ({ href, title, tokens }: any) {
    const linkText = (this as any).parser.parseInline(tokens)
    const isExternal = typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://'))
    const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : ''
    const titleAttr = title ? ` title="${title}"` : ''
    return `<a href="${href}"${targetAttr}${titleAttr}>${linkText}</a>`
  }

  renderer.image = function ({ href, title, text }: any) {
    const caption = title || text || ''
    const escapedCaption = caption.replace(/"/g, '&quot;')
    return `<span class="post-image-wrapper block my-6 text-center">
      <img
        src="${href}"
        alt="${escapedCaption}"
        title="${escapedCaption}"
        loading="lazy"
        decoding="async"
        data-zoomable="true"
        class="post-image zoomable rounded-xl shadow-md cursor-zoom-in inline-block max-h-[75vh] max-w-full h-auto object-contain transition duration-300 hover:shadow-lg hover:scale-[1.01]"
      />
      ${caption ? `<span class="post-image-caption block mt-2 text-center text-xs fuwari-text-50">${caption}</span>` : ''}
    </span>`
  }

  renderer.html = function ({ text }: { text: string }) {
    return processEmbeddedMediaHtml(text)
  }

  renderer.code = function (token: any) {
    return renderEnhancedCodeBlock(token, siteConfig.lang)
  }

  // 1. 先进行 LaTeX / KaTeX 数学公式 SSR 静态解析渲染
  let preprocessedContent = renderKaTeXMath(post.content)

  // 2. 解析 Admonitions (彩色告示/警告框)
  preprocessedContent = renderAdmonitions(preprocessedContent, siteConfig.lang)

  // 3. Marked GFM 渲染
  const rawHtmlContent = await marked.parse(preprocessedContent, {
    gfm: true,
    breaks: true,
    renderer,
  })
  const htmlContent = processEmbeddedMediaHtml(rawHtmlContent)

  // Approximate word count
  const chineseChars = (post.content.match(/[\u4e00-\u9fff]/g) || []).length
  const englishWords = post.content
    .replace(/[\u4e00-\u9fff]/g, '')
    .split(/\s+/)
    .filter(Boolean).length
  const wordCount = Math.max(100, chineseChars + englishWords)

  // 访问量统计配置（仅在开启统计功能时前端异步加载）
  const statsEnabled = isStatsEnabled(c.env)

  // Compute minDepth for TOC numbering (exact flare-stack-blog TableOfContents logic)
  let minDepth = 10
  for (const h of toc) {
    if (h.level < minDepth) minDepth = h.level
  }
  let h1Count = 1

  // Compute Prev / Next posts from manifest
  const manifest = (await getManifest(c.env))
    .filter((p) => p.draft !== true && (p.draft as any) !== 'true')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const currentIndex = manifest.findIndex((p) => p.title === post.title || p.slug === post.title)
  const prevPost = currentIndex > 0 ? manifest[currentIndex - 1] : null
  const nextPost =
    currentIndex >= 0 && currentIndex < manifest.length - 1
      ? manifest[currentIndex + 1]
      : null

  const cleanTitle = post.title.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const renderedTitle = post.title.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-(--fuwari-primary) underline hover:opacity-80 transition">$1</a>'
  )

  // 文章详情内容极少变动，边缘长效强缓存 24 小时，SWR 7 天
  setTieredCache(c, {
    edgeMaxAge: 86400,
    swrMaxAge: 604800,
    tags: ['page', 'post', `post-${encodeURIComponent(post.title)}`],
  })

  return c.html(
    <Layout
      title={cleanTitle}
      description={post.excerpt}
      currentPath={`/posts/${encodeURIComponent(post.title)}`}
      isHomePage={false}
      categories={categories}
      tags={tags}
      blogUrl={c.env.BLOG_URL || new URL(c.req.url).origin}
      image={post.cover}
      ogType="article"
      siteConfig={siteConfig}
      env={c.env}
      articleMeta={{
        publishedTime: post.date ? new Date(post.date).toISOString() : undefined,
        modifiedTime: post.updated
          ? new Date(post.updated).toISOString()
          : post.date
          ? new Date(post.date).toISOString()
          : undefined,
        section: post.category,
        tags: post.tags,
        wordCount,
        readingTime: post.readingTime,
      }}
    >
      <div class="relative flex flex-col rounded-(--fuwari-radius-large) py-1 md:py-0 md:bg-transparent gap-4 mb-4 w-full">
        {/* Table Of Contents (Desktop Floating Right - Exact flare-stack-blog port) */}
        {toc.length > 0 && (
          <div
            class="hidden 2xl:block absolute top-0 h-full pl-4"
            style="right: calc(var(--fuwari-toc-width) * -1); width: var(--fuwari-toc-width);"
          >
            <nav
              id="toc-nav-wrapper"
              class="sticky top-14 self-start block w-full transition-all duration-500 opacity-100 translate-y-0"
            >
              <div
                id="toc-scroll-container"
                class="relative toc-root overflow-y-auto overflow-x-hidden fuwari-toc-scrollbar h-[calc(100vh-20rem)]"
                style="scroll-behavior: smooth; mask-image: linear-gradient(to bottom, transparent 0%, black 2rem, black calc(100% - 2rem), transparent 100%);"
              >
                <div class="h-8 w-full" />
                <div id="toc-links-container" class="group relative flex flex-col w-full">
                  {toc
                    .filter((h) => h.level < minDepth + 3)
                    .map((heading) => {
                      const isH1 = heading.level === minDepth
                      const isH2 = heading.level === minDepth + 1
                      const isH3 = heading.level === minDepth + 2

                      return (
                        <a
                          href={`#${heading.id}`}
                          data-toc-target={heading.id}
                          class="toc-item-link px-2 flex gap-2 relative transition w-full min-h-9 rounded-xl py-2 z-10 items-center hover:bg-(--fuwari-toc-btn-hover) active:bg-(--fuwari-toc-btn-active) no-underline"
                        >
                          <div
                            class={`transition w-5 h-5 shrink-0 rounded-lg text-xs flex items-center justify-center font-bold ${
                              isH1
                                ? 'bg-[oklch(0.89_0.050_var(--fuwari-hue))] dark:bg-(--fuwari-btn-regular-bg) text-(--fuwari-btn-content)'
                                : isH2
                                  ? 'ml-4'
                                  : 'ml-8'
                            }`}
                          >
                            {isH1 && h1Count++}
                            {isH2 && (
                              <div class="transition w-2 h-2 rounded-[0.1875rem] bg-[oklch(0.89_0.050_var(--fuwari-hue))] dark:bg-(--fuwari-btn-regular-bg)" />
                            )}
                            {isH3 && (
                              <div class="transition w-1.5 h-1.5 rounded-sm bg-black/15 dark:bg-white/20" />
                            )}
                          </div>
                          <div
                            class={`transition text-sm truncate ${
                              isH1 || isH2 ? 'fuwari-text-50' : 'fuwari-text-30'
                            }`}
                          >
                            {heading.text}
                          </div>
                        </a>
                      )
                    })}

                  {/* Active Indicator Backdrop */}
                  <div
                    id="toc-active-indicator"
                    class="absolute left-0 right-0 rounded-xl transition-all duration-300 ease-out -z-10 border-2 border-dashed pointer-events-none bg-(--fuwari-toc-btn-hover) border-(--fuwari-toc-btn-hover) group-hover:bg-transparent group-hover:border-(--fuwari-toc-btn-active)"
                    style="top: 0px; height: 36px; opacity: 0;"
                  />
                </div>
                <div class="h-8 w-full" />
              </div>
            </nav>
          </div>
        )}

        {/* Main Post Container (Exact flare-stack-blog PostPage port) */}
        <article
          class="fuwari-card-base z-10 px-6 md:px-9 pt-6 pb-4 relative w-full fuwari-onload-animation"
          itemscope
          itemtype="https://schema.org/BlogPosting"
        >
          <meta itemprop="headline" content={post.title} />
          <meta itemprop="description" content={post.excerpt || post.title} />
          <meta itemprop="wordCount" content={String(wordCount)} />

          {/* Word count, reading time and view count */}
          <div class="flex flex-row flex-wrap fuwari-text-30 gap-5 mb-3 transition">
            <div class="flex flex-row items-center">
              <div class="transition h-6 w-6 rounded-md bg-black/5 dark:bg-white/10 fuwari-text-50 flex items-center justify-center mr-2">
                <FileTextIcon strokeWidth={1.5} size={16} />
              </div>
              <div class="text-sm">{wordCount} {i18n(wordCount === 1 ? I18nKey.wordCount : I18nKey.wordsCount, siteConfig.lang)}</div>
            </div>
            <div class="flex flex-row items-center">
              <div class="transition h-6 w-6 rounded-md bg-black/5 dark:bg-white/10 fuwari-text-50 flex items-center justify-center mr-2">
                <ClockIcon strokeWidth={1.5} size={16} />
              </div>
              <div class="text-sm">{post.readingTime} {i18n(post.readingTime === 1 ? I18nKey.minuteCount : I18nKey.minutesCount, siteConfig.lang)}</div>
            </div>
            {statsEnabled && (
              <div id="post-views-container" class="flex-row items-center" style="display: none;">
                <div class="transition h-6 w-6 rounded-md bg-black/5 dark:bg-white/10 fuwari-text-50 flex items-center justify-center mr-2 text-(--fuwari-primary)">
                  <EyeIcon strokeWidth={1.5} size={16} />
                </div>
                <div class="text-sm"><span id="post-views-count"></span> {i18n(I18nKey.viewsCount, siteConfig.lang)}</div>
              </div>
            )}
          </div>

          {/* Title */}
          <div class="relative">
            <h1
              class="transition w-full block font-bold mb-3
                text-3xl md:text-[2.25rem]/[2.75rem]
                fuwari-text-90
                md:before:w-1 before:h-5 before:rounded-md before:bg-(--fuwari-primary)
                before:absolute before:top-3 before:-left-4.5"
            >
              {raw(renderedTitle)}
            </h1>
          </div>

          {/* PostMeta (Exact flare-stack-blog PostMeta port) */}
          <div class="flex flex-wrap text-black/50 dark:text-white/40 items-center gap-4 gap-x-4 gap-y-2 mb-5">
            <div class="flex items-center">
              <div class="fuwari-meta-icon">
                <CalendarIcon strokeWidth={1.5} size={20} />
              </div>
              <time datetime={post.date} itemprop="datePublished" class="text-sm font-medium fuwari-text-50">{formatDate(post.date, siteConfig.lang)}</time>
            </div>

            {post.updated && (
              <div class="flex items-center">
                <div class="fuwari-meta-icon">
                  <EditIcon strokeWidth={1.5} size={20} />
                </div>
                <time datetime={post.updated} itemprop="dateModified" class="text-sm font-medium fuwari-text-50">
                  {formatDate(post.updated, siteConfig.lang)}
                </time>
              </div>
            )}

            <div class="flex items-center">
              <div class="fuwari-meta-icon">
                <TagIcon strokeWidth={1.5} size={20} />
              </div>
              <div class="flex flex-row flex-wrap items-center gap-x-1.5">
                {post.category && (
                  <span class="flex items-center">
                    <a
                      href={`/?category=${encodeURIComponent(post.category)}`}
                      class="transition fuwari-text-50 text-sm font-medium hover:text-(--fuwari-primary) whitespace-nowrap no-underline"
                    >
                      {post.category}
                    </a>
                    {post.tags.length > 0 && (
                      <span class="mx-1.5 text-(--fuwari-meta-divider) text-sm">
                        /
                      </span>
                    )}
                  </span>
                )}
                {post.tags.map((tag, i) => (
                  <span class="flex items-center">
                    {i > 0 && (
                      <span class="mx-1.5 text-(--fuwari-meta-divider) text-sm">
                        /
                      </span>
                    )}
                    <a
                      href={`/?tag=${encodeURIComponent(tag)}`}
                      class="transition fuwari-text-50 text-sm font-medium hover:text-(--fuwari-primary) whitespace-nowrap no-underline"
                    >
                      {tag}
                    </a>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Post Cover Image (Fuwari Specification - natural aspect ratio without harsh cropping) */}
          {post.cover ? (
            <div class="relative w-full overflow-hidden rounded-2xl mb-8 border border-black/5 dark:border-white/10 shadow-xs">
              <img
                src={post.cover}
                alt={post.title}
                width="1200"
                height="630"
                class="w-full h-auto max-h-[650px] object-cover object-center block"
                loading="eager"
                decoding="async"
              />
            </div>
          ) : (
            <div class="border-(--fuwari-meta-divider) border-dashed border-b mb-6 opacity-30" />
          )}

          {/* PostSummary (Exact flare-stack-blog PostSummary port) */}
          {post.excerpt && (
            <div
              class="mb-4 md:mb-6 rounded-2xl bg-(--fuwari-primary)/5 border border-black/5 dark:border-white/10 p-4 md:p-5 flex items-start gap-3 md:gap-4 transition-all hover:bg-(--fuwari-primary)/10 fuwari-onload-animation backdrop-blur-xs"
              style="animation-delay: 200ms"
            >
              <div class="shrink-0 text-(--fuwari-primary) bg-(--fuwari-primary)/10 p-2 md:p-2.5 rounded-xl flex items-center justify-center mt-0.5">
                <QuoteIcon size={18} />
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-[11px] md:text-xs font-bold text-(--fuwari-primary) flex items-center mb-1 md:mb-1.5 uppercase tracking-[0.2em] opacity-80">
                  {i18n(I18nKey.postSummary, siteConfig.lang)}
                </h3>
                <p class="text-sm md:text-[15px] leading-relaxed fuwari-text-70 font-medium m-0">
                  {post.excerpt}
                </p>
              </div>
            </div>
          )}

          {/* Markdown Content */}
          <div
            class="mb-6 prose dark:prose-invert prose-base max-w-none! fuwari-custom-md"
            itemprop="articleBody"
          >
            {raw(htmlContent)}
          </div>

          {/* Article License Card (CC-BY-NC-SA 4.0) */}
          <LicenseCard
            title={cleanTitle}
            url={`${c.env.BLOG_URL || new URL(c.req.url).origin}/posts/${encodeURIComponent(post.title)}`}
            date={post.date}
            siteConfig={siteConfig}
          />

          {/* End of Content Notice */}
          <div class="my-8 flex items-center justify-center w-full">
            <div class="h-px w-full bg-linear-to-r from-transparent via-(--fuwari-meta-divider) to-transparent opacity-20" />
            <span class="mx-4 text-sm font-mono tracking-widest text-(--fuwari-meta-divider) opacity-50 whitespace-nowrap">
              END
            </span>
            <div class="h-px w-full bg-linear-to-r from-(--fuwari-meta-divider) via-transparent to-transparent opacity-20" />
          </div>
        </article>

        {/* Giscus Comments Section */}
        <Giscus env={c.env} lang={siteConfig.lang} />

        {/* Prev / Next Navigation Cards (Fuwari style) */}
        <div
          class="flex flex-col md:flex-row justify-between w-full gap-4 overflow-hidden fuwari-onload-animation"
          style="animation-delay: 200ms"
        >
          {prevPost ? (
            <a
              href={`/posts/${encodeURIComponent(prevPost.title)}`}
              class="fuwari-card-base w-full h-15 px-4 flex items-center gap-3 hover:bg-(--fuwari-btn-plain-bg-hover) active:scale-98 transition no-underline"
            >
              <span class="rotate-180 text-(--fuwari-primary) flex shrink-0">
                <ChevronRightIcon size={24} />
              </span>
              <div class="overflow-hidden">
                <div class="text-xs fuwari-text-50">{i18n(I18nKey.prevPost, siteConfig.lang)}</div>
                <div class="font-bold fuwari-text-75 truncate">{prevPost.title}</div>
              </div>
            </a>
          ) : (
            <div class="w-full hidden md:block" />
          )}

          {nextPost ? (
            <a
              href={`/posts/${encodeURIComponent(nextPost.title)}`}
              class="fuwari-card-base w-full h-15 px-4 flex items-center justify-end gap-3 text-right hover:bg-(--fuwari-btn-plain-bg-hover) active:scale-98 transition no-underline"
            >
              <div class="overflow-hidden">
                <div class="text-xs fuwari-text-50">{i18n(I18nKey.nextPost, siteConfig.lang)}</div>
                <div class="font-bold fuwari-text-75 truncate">{nextPost.title}</div>
              </div>
              <span class="text-(--fuwari-primary) flex shrink-0">
                <ChevronRightIcon size={24} />
              </span>
            </a>
          ) : (
            <div class="w-full hidden md:block" />
          )}
        </div>
      </div>

      {/* Mobile Floating TOC Button (Bottom Right FAB) */}
      {toc.length > 0 && (
        <div class="2xl:hidden fixed bottom-20 right-4 z-40">
          <button
            type="button"
            id="mobile-toc-open"
            class="fuwari-card-base w-12 h-12 rounded-full shadow-lg flex items-center justify-center text-(--fuwari-primary) hover:scale-105 active:scale-95 transition-all cursor-pointer border border-black/5 dark:border-white/10"
            aria-label={i18n(I18nKey.toc, siteConfig.lang)}
            title={i18n(I18nKey.toc, siteConfig.lang)}
          >
            <ListIcon size={20} strokeWidth={2} />
            <span class="sr-only">{i18n(I18nKey.toc, siteConfig.lang)}</span>
          </button>
        </div>
      )}

      {/* Mobile TOC Drawer Sheet */}
      {toc.length > 0 && (
        <div
          id="mobile-toc-drawer"
          class="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs opacity-0 pointer-events-none invisible 2xl:hidden flex flex-col justify-end"
          aria-hidden="true"
        >
          <div
            id="mobile-toc-panel"
            class="fuwari-card-base rounded-b-none! rounded-t-3xl max-h-[75vh] w-full p-5 shadow-2xl translate-y-full transition-transform duration-300 flex flex-col"
          >
            <div class="flex items-center justify-between pb-3 mb-2 border-b border-black/5 dark:border-white/10">
              <div class="flex items-center gap-2 font-bold text-base fuwari-text-90">
                <ListIcon size={18} class="text-(--fuwari-primary)" />
                <span>{i18n(I18nKey.toc, siteConfig.lang)}</span>
              </div>
              <button
                id="mobile-toc-close"
                type="button"
                class="fuwari-expand-animation rounded-lg w-8 h-8 flex items-center justify-center fuwari-text-75 cursor-pointer border-none bg-transparent"
                aria-label={i18n(I18nKey.closeToc, siteConfig.lang)}
                title={i18n(I18nKey.closeToc, siteConfig.lang)}
              >
                <XIcon size={18} />
                <span class="sr-only">{i18n(I18nKey.closeToc, siteConfig.lang)}</span>
              </button>
            </div>
            <div class="overflow-y-auto fuwari-toc-scrollbar py-2 flex flex-col gap-1">
              {toc
                .filter((h) => h.level < minDepth + 3)
                .map((heading) => {
                  const indentClass =
                    heading.level === minDepth
                      ? 'font-bold'
                      : heading.level === minDepth + 1
                        ? 'pl-4'
                        : 'pl-8'
                  return (
                    <a
                      href={`#${heading.id}`}
                      class={`mobile-toc-link py-2 px-3 rounded-xl transition text-sm fuwari-text-75 hover:text-(--fuwari-primary) hover:bg-(--fuwari-btn-plain-bg-hover) flex items-center gap-2 no-underline ${indentClass}`}
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-(--fuwari-primary)/60 shrink-0 inline-block" />
                      <span class="truncate">{heading.text}</span>
                    </a>
                  )
                })}
            </div>
          </div>
        </div>
      )}

      {/* TOC Active Indicator Scroll Spy Script */}
      {toc.length > 0 &&
        raw(`<script>
        (function() {
          var links = Array.from(document.querySelectorAll('.toc-item-link'));
          var indicator = document.getElementById('toc-active-indicator');
          if (!links.length || !indicator) return;

          var headings = links.map(function(l) {
            return document.getElementById(l.getAttribute('data-toc-target'));
          }).filter(Boolean);

          function updateTocIndicator() {
            var scrollY = window.scrollY + 140;
            var activeIdx = 0;
            for (var i = 0; i < headings.length; i++) {
              if (headings[i].offsetTop <= scrollY) {
                activeIdx = i;
              }
            }
            var activeLink = links[activeIdx];
            if (activeLink) {
              indicator.style.top = activeLink.offsetTop + 'px';
              indicator.style.height = activeLink.offsetHeight + 'px';
              indicator.style.opacity = '1';
            }
          }
          window.addEventListener('scroll', updateTocIndicator, { passive: true });
          window.addEventListener('resize', updateTocIndicator);
          setTimeout(updateTocIndicator, 100);
        })();
      </script>`)}

      {/* 访问量统计与上报脚本（仅在开启统计功能时注入） */}
      {statsEnabled &&
        raw(`<script>
        (function() {
          var slug = ${JSON.stringify(post.title)};
          var storageKey = 'fuwari_pv_' + encodeURIComponent(slug);
          var lastViewed = sessionStorage.getItem(storageKey);
          var now = Date.now();
          var isRecent = lastViewed && (now - parseInt(lastViewed, 10)) < 15 * 60 * 1000;

          function renderViews(views) {
            if (typeof views === 'number' && views > 0) {
              var countEl = document.getElementById('post-views-count');
              var containerEl = document.getElementById('post-views-container');
              if (countEl) countEl.textContent = String(views);
              if (containerEl) containerEl.style.display = 'flex';
            }
          }

          // 1. 无论是否处于防刷期，进入或刷新页面始终只读拉取最新浏览量并点亮 DOM（解决刷新阅读量消失问题）
          fetch('/api/stats/post?slug=' + encodeURIComponent(slug))
            .then(function(r) { return r.json(); })
            .then(function(res) {
              if (res && res.success && res.data) {
                renderViews(res.data.views);
              }
            })
            .catch(function() {});

          // 2. 若在 15 分钟会话防刷期内，跳过任何上报操作
          if (isRecent) return;
          sessionStorage.setItem(storageKey, String(now));

          // 3. 延迟 1.5 秒等待 defer 的 script.js 加载就绪；
          // 仅在确认 window.umami 不存在（即被 Adblock 阻断）时才由服务端代理兜底上报，消除竞态双重计数
          setTimeout(function() {
            if (!window.umami) {
              var sessionId = sessionStorage.getItem('fuwari_sid');
              if (!sessionId) {
                sessionId = 's_' + Math.random().toString(36).slice(2) + now.toString(36);
                sessionStorage.setItem('fuwari_sid', sessionId);
              }

              fetch('/api/stats/view', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  slug: slug,
                  url: window.location.pathname,
                  referrer: document.referrer || '',
                  screen: window.screen ? (window.screen.width + 'x' + window.screen.height) : '',
                  language: navigator.language || '',
                  sessionId: sessionId,
                  clientTracked: false
                }),
                keepalive: true
              })
              .then(function(r) { return r.json(); })
              .then(function(res) {
                if (res && res.success && res.data) {
                  renderViews(res.data.views);
                }
              })
              .catch(function() {});
            }
          }, 1500);
        })();
      </script>`)}
    </Layout>
  )
})

export default postPage
