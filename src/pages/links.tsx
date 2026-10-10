import { Hono } from 'hono'
import { raw } from 'hono/html'
import type { AppEnv } from '../types/env.js'
import { Layout, Giscus } from '../components/index.js'
import { ExternalLinkIcon } from '../components/Icons.js'
import { getSidebarData, getFriends, getBlogConfig } from '../services/github.js'
import { setTieredCache } from '../utils/cache.js'
import { i18n, I18nKey } from '../i18n/index.js'

const links = new Hono<AppEnv>()

links.get('/', async (c) => {
  const [{ categories, tags }, friends, siteConfig] = await Promise.all([
    getSidebarData(c.env),
    getFriends(c.env),
    getBlogConfig(c.env),
  ])
  const baseUrl = (c.env.BLOG_URL || '').replace(/\/$/, '') || new URL(c.req.url).origin
  const avatarUrl = siteConfig.theme.fuwari.avatar.startsWith('http')
    ? siteConfig.theme.fuwari.avatar
    : `${baseUrl}${siteConfig.theme.fuwari.avatar}`

  const emailSocial = siteConfig.social.find((s) => s.platform === 'email')
  const adminEmail = emailSocial ? emailSocial.url.replace(/^mailto:/i, '') : ''

  const siteInfoText = `${i18n(I18nKey.siteName, siteConfig.lang)}：${siteConfig.title}
${i18n(I18nKey.siteDesc, siteConfig.lang)}：${siteConfig.description}
${i18n(I18nKey.siteUrl, siteConfig.lang)}：${baseUrl}
${i18n(I18nKey.siteAvatar, siteConfig.lang)}：${avatarUrl}`

  const applyTemplateText = `- ${i18n(I18nKey.siteName, siteConfig.lang)}：...
- ${i18n(I18nKey.siteDesc, siteConfig.lang)}：...
- ${i18n(I18nKey.siteUrl, siteConfig.lang)}：https://example.com
- ${i18n(I18nKey.siteAvatar, siteConfig.lang)}：https://example.com/avatar.webp`

  const mailtoSubject = encodeURIComponent(`申请交换友链 - 来自 ${siteConfig.title} 的访客`)
  const mailtoBody = encodeURIComponent(
    `你好，我想申请与贵站交换友情链接：\n\n${applyTemplateText}\n\n已在贵站先行添加友链，期待回复！`
  )
  const mailtoUrl = adminEmail
    ? `mailto:${adminEmail}?subject=${mailtoSubject}&body=${mailtoBody}`
    : ''

  // 友链聚合页边缘缓存 30 分钟，SWR 24 小时
  setTieredCache(c, { edgeMaxAge: 1800, swrMaxAge: 86400, tags: ['page', 'links'] })

  return c.html(
    <Layout
      title={i18n(I18nKey.links, siteConfig.lang)}
      description={i18n(I18nKey.linksSubtitle, siteConfig.lang)}
      currentPath="/links"
      isHomePage={false}
      categories={categories}
      tags={tags}
      blogUrl={baseUrl}
      siteConfig={siteConfig}
      env={c.env}
    >
      {/* 头部标题卡片：左侧标题，右侧“申请友链”按钮 */}
      <div
        class="fuwari-card-base px-6 md:px-9 py-6 relative w-full fuwari-onload-animation flex flex-col md:flex-row md:items-center justify-between gap-4"
        style="animation-delay: 100ms"
      >
        <div>
          <div class="relative mb-2">
            <h1 class="transition w-full block font-bold text-3xl fuwari-text-90 md:before:w-1 before:h-5 before:rounded-md before:bg-(--fuwari-primary) before:absolute before:top-2.5 before:-left-4.5">
              {i18n(I18nKey.linksTitle, siteConfig.lang)}
            </h1>
          </div>
          <p class="fuwari-text-50 text-sm leading-relaxed">
            {i18n(I18nKey.linksSubtitle, siteConfig.lang)}
          </p>
        </div>

        {/* 申请友链按钮 */}
        <button
          id="apply-toggle-btn"
          type="button"
          class="fuwari-btn-regular px-4 py-2.5 rounded-xl text-sm font-bold text-(--fuwari-primary) flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer shrink-0 transition-all border-none"
        >
          <span class="apply-btn-icon text-base leading-none font-bold">+</span>
          <span class="apply-btn-text">{i18n(I18nKey.applyLinks, siteConfig.lang)}</span>
        </button>
      </div>

      {/* 申请友链与规则展开面板（默认收起隐藏，点击上方按钮展开） */}
      <div
        id="apply-panel"
        class="hidden fuwari-card-base px-6 md:px-9 pt-6 pb-8 relative w-full fuwari-onload-animation border-2 border-(--fuwari-primary)/30 transition-all"
        style="animation-delay: 50ms"
      >
        <div class="flex items-center justify-between mb-4 pb-3 border-b border-black/5 dark:border-white/10">
          <div class="font-bold text-xl fuwari-text-90 flex items-center gap-2">
            <span
              class="w-1 h-4 rounded-md inline-block"
              style="background-color: var(--fuwari-primary)"
            />
            {i18n(I18nKey.applyRules, siteConfig.lang)}
          </div>
          <span class="text-xs fuwari-text-50">{i18n(I18nKey.applyRulesSubtitle, siteConfig.lang)}</span>
        </div>

        {/* 规则与信息双列网格 */}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
          {/* 本站信息卡片 */}
          <div class="bg-black/3 dark:bg-white/4 p-4.5 rounded-xl flex flex-col justify-between">
            <div>
              <div class="font-bold text-sm fuwari-text-90 mb-2.5 flex items-center gap-1.5">
                <span>{i18n(I18nKey.siteInfo, siteConfig.lang)}</span>
              </div>
              <ul class="text-xs fuwari-text-75 space-y-1.5 font-mono leading-relaxed list-none p-0 m-0">
                <li><span class="fuwari-text-50 font-sans">{i18n(I18nKey.siteName, siteConfig.lang)}：</span>{siteConfig.title}</li>
                <li><span class="fuwari-text-50 font-sans">{i18n(I18nKey.siteDesc, siteConfig.lang)}：</span>{siteConfig.description}</li>
                <li><span class="fuwari-text-50 font-sans">{i18n(I18nKey.siteUrl, siteConfig.lang)}：</span>{baseUrl}</li>
                <li><span class="fuwari-text-50 font-sans">{i18n(I18nKey.siteAvatar, siteConfig.lang)}：</span>{avatarUrl}</li>
              </ul>
            </div>
            <button
              type="button"
              onclick={`copyFriendText(${JSON.stringify(siteInfoText)}, this)`}
              class="fuwari-btn-regular mt-3 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer self-start border-none"
            >
              {i18n(I18nKey.copySiteInfo, siteConfig.lang)}
            </button>
          </div>

          {/* 申请格式卡片 */}
          <div class="bg-black/3 dark:bg-white/4 p-4.5 rounded-xl flex flex-col justify-between">
            <div>
              <div class="font-bold text-sm fuwari-text-90 mb-2.5 flex items-center gap-1.5">
                <span>{i18n(I18nKey.applyTemplate, siteConfig.lang)}</span>
              </div>
              <pre class="text-xs fuwari-text-75 font-mono m-0 p-0 bg-transparent leading-relaxed whitespace-pre-wrap">{applyTemplateText}</pre>
            </div>
            <button
              type="button"
              onclick={`copyFriendText(${JSON.stringify(applyTemplateText)}, this)`}
              class="fuwari-btn-regular mt-3 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer self-start border-none"
            >
              {i18n(I18nKey.copyApplyTemplate, siteConfig.lang)}
            </button>
          </div>
        </div>

        {/* 申请方式一：邮件申请 */}
        <div class="p-4 rounded-xl bg-(--fuwari-primary)/10 border border-(--fuwari-primary)/20 mb-4">
          <div class="font-bold text-sm fuwari-text-90 flex items-center gap-1.5 mb-1.5">
            <span>{i18n(I18nKey.emailApply, siteConfig.lang)}</span>
          </div>
          <p class="text-xs fuwari-text-75 leading-relaxed mb-3">
            {i18n(I18nKey.emailApplyDesc, siteConfig.lang)}
          </p>
          <div class="flex flex-wrap items-center gap-2.5">
            {adminEmail ? (
              <>
                <a
                  href={mailtoUrl}
                  class="fuwari-btn-primary px-3.5 py-1.5 rounded-lg text-xs font-bold no-underline inline-flex items-center gap-1.5 shadow-xs"
                >
                  <span>{i18n(I18nKey.sendEmail, siteConfig.lang)}</span>
                </a>
                <button
                  type="button"
                  onclick={`copyFriendText('${adminEmail}', this)`}
                  class="fuwari-btn-regular px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border-none"
                >
                  {i18n(I18nKey.copyEmail, siteConfig.lang)}
                </button>
              </>
            ) : (
              <span class="text-xs fuwari-text-50">{i18n(I18nKey.noPublicEmail, siteConfig.lang)}</span>
            )}
          </div>
        </div>

        {/* 申请方式二：评论申请 */}
        <div class="p-4 rounded-xl bg-black/3 dark:bg-white/4 border border-black/5 dark:border-white/10 mb-2">
          <div class="font-bold text-sm fuwari-text-90 flex items-center gap-1.5 mb-1.5">
            <span>{i18n(I18nKey.commentApply, siteConfig.lang)}</span>
          </div>
          <p class="text-xs fuwari-text-75 leading-relaxed mb-3">
            {i18n(I18nKey.commentApplyDesc, siteConfig.lang)}
          </p>
          <button
            type="button"
            id="toggle-public-comments-btn"
            class="fuwari-btn-regular px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer border-none flex items-center gap-1.5 text-(--fuwari-primary)"
          >
            <span id="comment-toggle-text">{i18n(I18nKey.expandComments, siteConfig.lang)}</span>
          </button>
          <div id="public-comments-wrap" class="hidden mt-4 pt-4 border-t border-black/5 dark:border-white/10">
            <Giscus env={c.env} lang={siteConfig.lang} />
          </div>
        </div>
      </div>

      {/* 主页面核心内容：仅展示已有的友链卡片网格列表 */}
      <div
        class="grid grid-cols-1 md:grid-cols-2 gap-4 fuwari-onload-animation"
        style="animation-delay: 150ms"
      >
        {friends.map((friend) => (
          <a
            href={friend.url}
            target="_blank"
            rel="noreferrer noopener"
            class="fuwari-card-base p-4 flex items-center gap-4 transition-all duration-300 hover:-translate-y-1 hover:border-(--fuwari-primary)/50 group no-underline relative"
          >
            <img
              src={friend.avatar}
              alt={friend.title}
              loading="lazy"
              class="w-14 h-14 rounded-full object-cover shrink-0 border border-black/5 dark:border-white/10 group-hover:rotate-6 transition-transform duration-300 bg-black/5 dark:bg-white/5"
            />
            <div class="min-w-0 flex-1">
              <div class="font-bold text-base fuwari-text-90 group-hover:text-(--fuwari-primary) transition-colors flex items-center gap-1.5 truncate">
                <span>{friend.title}</span>
                <ExternalLinkIcon size={13} class="opacity-50 shrink-0 group-hover:opacity-100" />
              </div>
              <p class="text-xs fuwari-text-50 line-clamp-2 mt-1 leading-relaxed">
                {friend.description}
              </p>
            </div>
          </a>
        ))}
      </div>

      {/* 页面交互脚本：展开/收起申请面板 & 一键复制 */}
      {raw(`<script>
        (function() {
          var btn = document.getElementById('apply-toggle-btn');
          var panel = document.getElementById('apply-panel');
          var collapseRulesText = ${JSON.stringify(i18n(I18nKey.collapseRules, siteConfig.lang))};
          var applyLinksText = ${JSON.stringify(i18n(I18nKey.applyLinks, siteConfig.lang))};
          var expandCommentsText = ${JSON.stringify(i18n(I18nKey.expandComments, siteConfig.lang))};
          var collapseCommentsText = ${JSON.stringify(i18n(I18nKey.collapseComments, siteConfig.lang))};
          var copiedText = ${JSON.stringify(i18n(I18nKey.copied, siteConfig.lang))};

          if (btn && panel) {
            btn.addEventListener('click', function() {
              var isHidden = panel.classList.contains('hidden');
              if (isHidden) {
                panel.classList.remove('hidden');
                btn.querySelector('.apply-btn-text').textContent = collapseRulesText;
                btn.querySelector('.apply-btn-icon').textContent = '✕';
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              } else {
                panel.classList.add('hidden');
                btn.querySelector('.apply-btn-text').textContent = applyLinksText;
                btn.querySelector('.apply-btn-icon').textContent = '+';
              }
            });
          }

          var commentToggleBtn = document.getElementById('toggle-public-comments-btn');
          var commentWrap = document.getElementById('public-comments-wrap');
          var commentText = document.getElementById('comment-toggle-text');
          if (commentToggleBtn && commentWrap) {
            commentToggleBtn.addEventListener('click', function() {
              var isHidden = commentWrap.classList.toggle('hidden');
              if (commentText) {
                commentText.textContent = isHidden ? expandCommentsText : collapseCommentsText;
              }
            });
          }

          window.copyFriendText = function(text, btnElement) {
            if (!navigator.clipboard) return;
            navigator.clipboard.writeText(text).then(function() {
              var original = btnElement.textContent;
              btnElement.textContent = copiedText;
              setTimeout(function() {
                btnElement.textContent = original;
              }, 2000);
            });
          };
        })();
      </script>`)}
    </Layout>
  )
})

export default links
