# Honoki

基于 [Hono](https://hono.dev/) 框架构建的轻量级、高性能个人博客系统，支持在 **Cloudflare Workers**、**Vercel Edge** 和 **Netlify Edge** 上全球边缘部署。

---

## ✨ 核心特性

- 📝 **Git 驱动与内容解耦**：
  - 文章统一存放在 `posts/*.md` 中，Worker 代码体积极小（不包含任何文章正文）。
  - 运行时动态拉取 GitHub Raw 内容，结合 KV/内存多级缓存加速。
- 🖥️ **Pages CMS 可视化后台深度支持**：
  - 预配置 [`.pages.yml`](.pages.yml)，无需本地环境，随时随地在 [Pages CMS](https://pagescms.org/) 网页端**在线可视化创建、排版、编辑与删除文章**（支持 Markdown 与所见即所得富文本双向切换）。
  - 支持直接在后台可视化编辑**站点基础信息**（博客名称、作者简介、更换头像、首页大背景图、调整 OKLCH 主题色相、导航栏、社交链接）与**友情链接**。
  - **多云边缘图片反代与长效缓存**：Pages CMS 上传的新图片自动由 Worker/Edge 代理并缓存在 CDN 节点（30 天），免重新部署，国内高速秒开。
- 💬 **Giscus 评论系统深度定制**：
  - 免数据库 GitHub Discussions 评论系统，外观深度重构贴合博客主题。
  - 配备富文本格式快捷栏（粗体、斜体、代码、引用、列表等）与实时表情互动。
- 🗄️ **Umami 访问统计 (Zero-Database & Umami Analytics)**：
  - **原生 Umami 统计整合**：接入开源现代化统计平台 [Umami](https://umami.is/)（支持官方免费云端 Umami Cloud 或自建实例）。
  - **纯异步渲染与容灾隐藏（零拖累首屏 TTFB）**：首页与详情页服务端直出完全不等待统计上报，0ms 阻塞；浏览量由前端后台静默异步拉取，若请求失败、超时或未配置则自动保持隐藏，绝无空数据或报错干扰。首页严格按时间倒序排列，最新文章排在最上方。
  - **纯零统计极速模式**：若未配置 Umami，博客自动以纯静态/零统计模式运行，不展示阅读计数，不发送任何统计请求，性能极致轻快。

---

## ✍️ 撰写与管理文章

你可以选择 **Pages CMS 可视化后台（强烈推荐）** 或 **传统 Git 仓库提交** 两种方式来管理博客文章：

本项目已针对 [Pages CMS](https://pagescms.org/) 进行了开箱即用的深度适配：

1. **登录授权**：打开 [Pages CMS](https://pagescms.org/)，使用你的 GitHub 账号登录并授权绑定本博客仓库。
2. **可视化创建新文章**：
   - 在左侧菜单点击 **「文章」** -> 右上角 **「New item」**（新建文章）。
   - 输入文章标题（系统将自动以 `{title}.md` 规范命名保存）、选择发布日期、分类与标签。
   - 上传或挑选封面图片（图片将自动存储在 `public/images/` 中，并在各大云平台上享受自动边缘代理与 CDN 缓存）。
   - 正文编辑器支持在 **Markdown 源码** 与 **所见即所得富文本**（WYSIWYG）之间随时切换。
3. **可视化编辑已有文章**：
   - 在文章列表中点击任意文章卡片即可进入编辑，修改内容、标签、摘要、封面图或更新日期。
4. **实时保存与发布**：
   - 点击右上角 **Save**，Pages CMS 会将修改自动 commit 并推送到 GitHub 仓库。
   - GitHub Actions 将自动重新生成文章清单并通知 Worker 预热缓存，**几秒内线上即刻展示，无需重新构建部署应用**！
5. **站点设置与友情链接**：
   - **「站点设置」**：可直观修改博客标题、作者昵称与简介、一键上传更换站长头像与首页大背景图、调整 OKLCH 主题色相数值（0~360）、自定义导航栏菜单及社交平台链接。
   - **「友情链接」**：以表单列表形式随时新增、编辑、删除友链，保存后即刻刷新生效。
6. **关于本站**：
   - **「关于本站」**：支持以 Markdown 格式直接在线编辑网站的“关于”页面。

### 💡 嵌入视频与自定义 HTML（兼容 Pages CMS 富文本）

若需要在文章中嵌入 **Bilibili / YouTube 视频（`<iframe>`）** 或自定义 HTML 结构，推荐使用渲染代码块语法包裹：

````markdown
```html:render
<iframe src="//player.bilibili.com/player.html?bvid=BV1xx&autoplay=0" 
        scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" 
        loading="lazy"
        style="width: 100%; height: 500px;"></iframe>
```
````
*(亦支持声明为 ```` ```html render ````)*

> 🌟 **机制与优势**：
> - **杜绝富文本清洗丢失**：Pages CMS 的所见即所得富文本（WYSIWYG）编辑器默认会过滤清洗不安全的 `<iframe>` 等原生标签。将其包裹在渲染代码块中，后台会将其作为代码安全对待，**无论在富文本和源码之间如何切换保存，代码 100% 完整保留，绝不损坏文章**。
> - **前端自动解构成原生 DOM**：博客前端的 Markdown 解析引擎会自动识别该标记，将其以原生 HTML 形式输出到页面。
> - **权限硬拦截（杜绝自动播放）**：嵌入的媒体标签会自动接入前端安全管道，显式注入 `allow="autoplay 'none'; fullscreen"`，从浏览器内核层彻底杜绝外链视频未经用户点击时的意外自动播放。
> - **全向兼容**：若通过本地编辑器或 GitHub 提交，直接裸写的原生 `<iframe ...>` 标签依然保持 100% 兼容渲染。

---

## 📊 Umami 访问统计接入（可选功能）

> 💡 **说明**：**文章浏览量统计为完全可选功能**。
> - **零数据库超轻量模式（默认）**：若未配置统计服务，博客自动以纯静态/零数据库模式运行，前端不展示阅读计数，浏览器端完全不发送任何上报请求，性能极致轻快。所有文章展示、TOC 目录、分类标签、代码高亮、Giscus 评论等核心功能 100% 正常使用。
> - **Umami 统计（免数据库零配置）**：
>   原生接入开源现代统计 [Umami](https://umami.is/)（支持官方免费云端 Umami Cloud 或自建实例）。**完全无需任何传统数据库，无需建表**，彻底免除 Cloudflare D1 权限报错！只需配置 `UMAMI_WEBSITE_ID` 与 `UMAMI_API_KEY`，即可获得文章阅读量展示（异步拉取，失败自动隐匿）以及精美的独立可视化访客大屏。首页严格按发布时间倒序排列，最新文章始终排在最上方。

| 环境变量 | 配置位置 | 必填/可选 | 说明 |
| :--- | :---: | :---: | :--- |
| `UMAMI_WEBSITE_ID` | Variables / Secrets | **必填** (开启统计时) | Umami 站点 UUID，配置后系统自动激活统计服务 |
| `UMAMI_API_KEY` | Secrets | **建议配置** | 用于服务端安全拉取文章浏览量数据字典供前端异步展示 |
| `UMAMI_HOST` | Variables | 可选 | 默认 `https://cloud.umami.is`（自建实例填自建域名如 `https://analytics.example.com`） |
| `ENABLE_UMAMI_SCRIPT` | Variables | 可选 | 默认为 `true`（客户端注入轻量追踪脚本） |

> 📖 **关于获取 Website ID、API Key 与完整接入配置，请查阅**：👉 [**`docs/Umami接入.md`**](docs/Umami接入.md)

---

## 🚀 部署指南

本项目原生支持部署到全球主流边缘计算平台。关于详细的操作步骤、所需权限、必要与可选环境变量清单，请直接参阅完整部署指南：

- ⚡ [Cloudflare 部署指南](docs/部署流程.md#cloudflare部署)（主推推荐，支持 GitHub Actions 自动化 CI/CD 与无感建表）👉 [查看所需环境变量配置表](docs/部署流程.md#52-平台独立环境变量)
- ▲ [Vercel 部署指南](docs/部署流程.md#vercel部署)（基于 Vercel Edge Runtime，支持 GitHub Actions 自动化与环境变量一键同步）👉 [查看所需环境变量配置表](docs/部署流程.md#52-平台独立环境变量)
- 🌐 [Netlify 部署指南](docs/部署流程.md#netlify部署)（不推荐！现在免费额度太少了）👉 [查看所需环境变量配置表](docs/部署流程.md#52-平台独立环境变量)

> 📖 完整多平台部署文档请查阅：[`docs/部署流程.md`](docs/部署流程.md)

---

## 🔄 日常运维与自动刷新

- **发布 / 更新文章**：
  推荐直接在 **Pages CMS** 后台新建或编辑文章保存，也可以在本地或 GitHub 仓库修改/添加 `posts/*.md` 并推送到 `main` 分支。
  - GitHub Actions 将自动触发 `Sync Posts & Manage Cache`（[`sync-posts.yml`](.github/workflows/sync-posts.yml)）。
  - 自动更新清单并向博客发起 Webhook 刷新缓存，**几秒内即可看到更新，无需重新构建部署**。
- **修改站点信息与友链**：
  在 **Pages CMS** 后台「站点设置」或「友情链接」中可视化编辑并保存（或直接修改 `blog.config.json` / `friends.json` 并推送），保存后自动同步生效。
- **同步上游模板更新**：
  如果本仓库是通过 GitHub **「Use this template」** 按钮创建的衍生博客，当上游主仓库有新功能或 Bug 修复发布时：
  - 进入 GitHub 仓库的 **Actions** 标签页，在左侧选择 **Sync Template Updates**。
  - 点击 **Run workflow** -> 选择 `direct`（直接合并）即可一键同步！工作流会自动精准关联上游历史，安全保留你自定义的文章（`posts/`）、站点配置（`blog.config.json`）与友链（`friends.json`）。
  - 💡 **自动部署提示**：若希望代码同步合并后**立即自动触发后续部署工作流**，可在仓库 Secrets 中配置个人访问令牌 `PAT_TOKEN`（或 `GH_TOKEN`），以绕过 GitHub 默认 Token 的防递归触发机制。
- **文章同步与缓存管理 (Sync Posts & Manage Cache)**：
  支持随时在 GitHub Actions 页面（选择 `Sync Posts & Manage Cache`）或 **Pages CMS** 后台一键手动触发。
  - **下拉框自由选择**：支持【全部执行】、【清除 KV 缓存并重新拉取】或【仅清除 CDN 缓存】。
  - **功能**：重新生成文章清单，通知博客服务端预热，并调用 Cloudflare / Netlify / Vercel 官方控制平面毫秒级强制清空全球边缘节点缓存。
  - 💡 **安全解耦特性（自动跳过未配置平台）**：工作流内置严格的凭证判空守卫。若你仅部署了其中某一平台（如 Cloudflare），工作流会自动检测并安全跳过未配置的其他平台，整个流程保持 100% 成功状态（绿色对勾 ✅），绝不报错阻断。
- **查看统计与运行状态**：
  访问 `/api/stats/status` 端点可直接查看当前 Umami 统计引擎的运行状态与配置详情（`provider` 为 `umami` 或 `none`）。

---

## 📁 目录结构

```text
.
├── .github/workflows/
│   ├── deploy.yml            # 多平台自动化部署工作流 (Cloudflare / Vercel / Netlify 下拉选择)
│   ├── sync-posts.yml        # 文章同步与缓存管理工作流 (更新清单 / 刷新 KV / 清除 CDN 下拉选择)
│   └── sync-template.yml     # 一键从上游模板仓库同步最新功能与修复工作流
├── .pages.yml                # Pages CMS 可视化内容管理后台配置文件
├── blog.config.json          # 博客全局基础设置 (标题、作者、头像、背景图、主题色等)
├── api/
│   └── index.ts              # Vercel Edge Function 入口
├── netlify/
│   └── edge-functions/       # Netlify Edge Function 入口
├── netlify.toml              # Netlify 部署配置
├── vercel.json               # Vercel 部署路由配置
├── posts/                    # 文章存放目录 (Markdown)
│   ├── manifest.json         # 自动生成的文章元数据清单
│   └── *.md                  # 文章源文件
├── friends.json              # 友情链接数据源 (支持动态更新与自动刷新缓存)
├── public/                   # 静态资源 (头像、背景图、Favicon 等)
├── scripts/
│   ├── gen-manifest.mjs      # 文章清单生成脚本
│   ├── prepare-wrangler.mjs  # CI/CD 环境变量动态注入与配置清理脚本
│   ├── deploy-vercel.mjs     # Vercel 自动化部署与环境变量同步脚本
│   └── deploy-netlify.mjs    # Netlify 自动化部署与环境变量同步脚本
├── src/
│   ├── components/           # Hono JSX 页面组件 (Layout, Navbar, Giscus 等)
│   ├── pages/                # 页面路由控制器 (首页、文章详情、归档、关于)
│   ├── routes/               # API 路由 (/api/posts, /api/stats, /sitemap.xml 等)
│   ├── services/
│   │   ├── db/               # Umami 统计客户端与缓存抽象层
│   │   ├── storage.ts        # 基于 unstorage 的统一键值存储服务
│   │   ├── github.ts         # GitHub 内容拉取与多级缓存服务
│   │   └── stats.ts          # 阅读量统计与热门榜单业务代理
│   ├── types/                # TypeScript 类型定义
│   ├── blog.config.ts        # 博客全局基础信息与配置
│   ├── styles.ts             # Tailwind / Fuwari 核心样式表
│   └── index.ts              # 应用核心入口
├── wrangler.jsonc            # Cloudflare Worker 配置文件模板
└── package.json
```

---

## ⚡ 全球 CDN 分层缓存与 SWR (Tiered Cache & SWR)

本项目内置生产级的**四层渐进式分层缓存架构**（客户端浏览器、全球边缘 CDN、分布式持久化存储、源数据源），结合 **SWR (Stale-While-Revalidate)** 异步预热机制与全球 CDN 强刷工作流：
- **极致首屏加速**：99% 的读者访问直接由 Cloudflare / Vercel / Netlify 全球 300+ 边缘机房毫秒级响应，彻底杜绝 GitHub API 限流。
- **静态媒体长效强缓存**：背景图、站长头像及网站 Favicon 图标默认配置 **30 天本地浏览器强缓存 + 1 年全球边缘 CDN 强缓存**（HIT），秒级直出；若更换图片，可通过一键强刷工作流毫秒级全局失效。
- **实时内容生效**：通过 GitHub Actions 与 Webhook 机制，更新文章或修改配置时支持毫秒级广播清除全球 CDN 缓存。
- **智能解耦与自动跳过**：内置的同步与缓存管理工作流（`Sync Posts & Manage Cache`）具备安全兜底机制，自动识别各平台凭证配置情况，未配置的平台将自动优雅跳过且流程保持成功，单平台部署与多平台容灾均无缝适配。

> 📖 **关于四层渐进式架构原理、三大平台边缘控制头适配与强制缓存失效环境变量配置，请查阅完整文档**：[**`docs/缓存.md`**](docs/缓存.md)。

---

## 🛠️ 本地开发

### 环境准备

- [Node.js](https://nodejs.org/) (>= 18.0.0)
- [pnpm](https://pnpm.io/) (推荐)

### 安装与运行

```bash
# 1. 安装依赖
pnpm install

# 2. 生成本地文章清单
pnpm gen:manifest

# 3. 启动本地开发服务（unstorage 自动使用内存缓存驱动，免配云 KV）
pnpm dev
```

本地服务启动后，可在浏览器访问 `http://localhost:8787` 预览博客。

---

## 📄 License

MIT License.
