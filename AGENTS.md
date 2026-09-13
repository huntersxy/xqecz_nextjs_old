# AGENTS.md — xqecz monorepo

## 项目概述

小泉动漫二创站（xqecz）— 用户上传/浏览二次创作内容（内容统一为"文本 + 可选媒体"，不分类，贴吧/动态式），含评论、管理后台。

**Monorepo 架构**：NestJS 主后端（API）+ Go 无状态 Worker（文件处理 / 推荐打分）+ Vue 3 前端，通过 pnpm workspace 统一管理。

## 架构

```
前端(Vue3) ──HTTP──→ NestJS API ──TypeORM──→ MySQL
                       │   │  ▲
                       │   │  └── Redis（session / cache / 浏览量 / 推荐 ZSet）
                       │   │
                       │   └──gRPC──→ Go Worker（无状态计算）
                       │                  ├─ GenerateThumbnail / CompressImage（文件处理，读写共享上传目录）
                       │                  ├─ FetchLinkPreview（OG 解析）
                       │                  └─ RefreshRecommend（纯打分，输入来自 NestJS，输出评分回传 NestJS）
                       │
                       └── 共享上传目录（UPLOAD_DIR）：NestJS 与 Worker 指向同一目录、互认绝对路径，处理缩略图
```

**推荐链路（重要）**：NestJS 独占 DB/Redis —— worker **不**直连 MySQL/Redis。
推荐刷新由 api 主导：`ContentService.refreshRecommend()` 读 MySQL approved 内容 → 组装 `RecommendItem[]` 经 gRPC `RefreshRecommend` → worker 纯计算返回 `ScoredItem[]` → api 用 `RedisService.writeRecommendList()` 原子写入 Redis ZSet `recommend:hot`（ioredis `keyPrefix=xqecz:` → 实际 key `xqecz:recommend:hot`）。读取时 `recommend()` 优先读 ZSet，无数据/异常降级到 `view_count` 排序。

## 目录结构

```
D:\xqecz/
├── packages/
│   ├── api/               # NestJS 主后端（TypeORM + MySQL + ioredis）
│   │   ├── src/
│   │   │   ├── auth/      # 认证模块（Redis Session）
│   │   │   ├── content/   # 内容模块（CRUD / 搜索 / 推荐 / 媒体管线）
│   │   │   ├── comment/   # 评论模块（树形评论 / 举报）
│   │   │   ├── poll/      # 投票模块
│   │   │   ├── admin/     # 管理后台（含 refresh-recommend / regenerate 端点）
│   │   │   ├── api-key/   # API 密钥管理
│   │   │   ├── entities/  # TypeORM Entity（10 张表：users/contents/comments/claims/polls/poll_votes/content_likes/content_favorites/comment_reports/api_keys）
│   │   │   ├── guards/    # AuthGuard / AdminGuard / OptionalAuthGuard
│   │   │   ├── redis/     # RedisService（session / cache / view / recommend 读写）
│   │   │   ├── worker/    # WorkerService（gRPC client → Go worker）
│   │   │   └── decorators/# CurrentUser
│   │   ├── .env           # 本地测试配置（gitignore，含 DB/Redis 凭据）
│   │   └── package.json
│   │
│   ├── worker/            # Go 无状态 gRPC 微服务（不连 DB/Redis，无 cron）
│   │   ├── cmd/server/    # 入口（gRPC server）
│   │   ├── server/        # WorkerServer 实现（worker.go / recommend.go / worker_test.go）
│   │   ├── config/        # env 驱动配置（TINIFY_*/UPLOAD_DIR，无 DB/Redis 配置）
│   │   ├── media/         # 缩略图（ffmpeg）、Tinify 压缩
│   │   ├── linkpreview/   # OG/Twitter Card 解析
│   │   ├── proto/         # Go gRPC stub（从 proto/ 生成后复制）
│   │   └── go.mod
│   │
│   └── frontend/          # Vue 3 前端（本仓内 packages/frontend）
│       └── src/
│           ├── components/  # 通用组件（WaterfallCard 用 ResizeObserver 监听整卡高度驱动瀑布流重排）
│           ├── composables/ # 组合式函数；useWaterfallLayout.ts 瀑布流布局（纯算法 computeLayout 与 DOM 解耦）
│           │   └── __tests__/  # vitest 单测（computeLayout 纯函数可直接测，无需 DOM）
│           ├── stores/home.ts  # 首页筛选/分页/滚动位置与瀑布流布局缓存（CachedPosition 含 h/col）
│           └── views/      # 路由页：HomeView 瀑布流首页（自包含布局/加载逻辑）；ContentDetailView 为全屏覆盖式路由页（/content/:id）
│
├── proto/
│   ├── xqecz.proto        # gRPC protobuf 定义（4 文件处理/推荐方法 + Health）
│   ├── gen/               # 生成产物（go/ + ts/）
│   └── package.json
│
├── scripts/
│   ├── run-worker.mjs     # 启动 Go Worker（从 packages/api/.env 注入 UPLOAD_DIR）
│   └── sync-deps.mjs      # 启动前依赖自愈（由 start:backend 首先调用，见「核心约束」）
│
├── pnpm-workspace.yaml
├── package.json            # 根脚本（dev / build / start / worker:build）
└── AGENTS.md               # ← 本文件
```

## gRPC 接口（proto/xqecz.proto）

| 方法 | 入参 | 返回 | 说明 |
|------|------|------|------|
| `Health` | — | status/version | 健康检查 |
| `GenerateThumbnail` | file_path, content_type | thumb_path, success, error | ffmpeg 抽帧/缩放 → webp |
| `CompressImage` | file_path | compressed_path, success, error | Tinify 压缩（proto 兼容保留；API 当前不调用） |
| `FetchLinkPreview` | url | title/image/platform, success, error | 解析 OG 元数据（proto 兼容保留；API 当前不调用） |
| `RefreshRecommend` | items[]（content_id/created_at_unix/view_count/like_count） | results[]（content_id/score）, success | **纯打分**，不碰 DB/Redis；like_count 权重高于 view_count |

> gRPC client 已设 `loader: { keepCase: true }`，proto 字段用 snake_case，与 Go worker 一致。

## 快速命令

> 项目**不使用 Docker**，全部通过 pnpm 脚本本地直启（MySQL/Redis 连云端实例，本机无需安装）。
> 前置要求：Node.js ≥ 20 + pnpm、Go 1.25+（worker 编译需 GOPROXY 可达）、FFmpeg（可选，缩略图用，缺失即降级）。

```bash
# ── 首次准备 ──
pnpm install --shamefully-hoist            # 装依赖（传递依赖需提升；CI=true 可跳过 TTY 确认）
# 确认 packages/api/.env 存在（gitignore，含云端 MySQL/Redis 凭据与 UPLOAD_DIR/WORKER_URL）

# ── 一键开发（推荐）──
pnpm dev                                   # scripts/dev.mjs 编排器：并发起三端（api :3000 / worker :50051 / 前端 :5173，
                                           #   端口被占时自适应顺延，通过环境变量注入各端保证互连；退出时递归清理子进程树）
# 说明：api 读 packages/api/.env；worker 经 scripts/run-worker.mjs 启动，自动从同一 .env 注入 UPLOAD_DIR，两端目录天然一致。
# 前端 Vite 已把 /api、/uploads 等代理到 http://localhost:3000（可用 VITE_PROXY_TARGET 覆盖，dev 编排器按实际端口注入）。

# ── 一键生产运行 ──
pnpm start                                 # = pnpm build（三端全量构建）+ pnpm start:services
pnpm start:services                        # 跳过构建直接起：concurrently 并发 api(node dist/main) + worker + 前端(vite preview :4173)

# ── 拆分命令 ──
pnpm dev:api                               # 仅 NestJS API 开发（热重载，:3000）
pnpm dev:worker                            # 仅 Go Worker（= pnpm run worker:run → scripts/run-worker.mjs）
pnpm dev:fe                                # 仅前端 Vite 开发服务器（:5173）
pnpm build                                 # 三端全量构建（api dist/ + 前端 dist/ + worker 二进制）
pnpm worker:build                          # 仅 Worker 构建
pnpm --filter ./packages/api run typecheck # API 类型检查
cd packages/worker && go test ./...        # Worker 测试
pnpm --filter ./packages/frontend run type-check # 前端类型检查
pnpm --filter ./packages/frontend run build # 前端生产构建
pnpm proto:generate                        # 生成 ts/go stub
```

## 核心约束

- **前端是契约** — `packages/frontend/src/api/index.ts` 是唯一接口定义（前端已并入本仓 `packages/frontend`，不再独立仓库）
- **NestJS 独占 DB/Redis** — Go worker 不访问 MySQL/Redis，也不含 cron 调度；它只做 gRPC 无状态计算，数据经 gRPC 从 NestJS 传入、结果回传 NestJS 落库/写缓存
- **API 密钥认证** — `AuthGuard` 双模式：请求头 `X-API-Key`（sha256 比对 `api_keys.key_hash`，`req.user.api_key` 携带权限）或 Session Cookie；`ApiKeyPermissionGuard` + `@RequireApiKeyPermission('upload'|'delete'|'read')` 仅约束密钥调用，Session 用户不受限。新增受保护接口时按此模式挂守卫
- **共享上传目录** — 文件处理路径通过 gRPC 传入绝对路径，NestJS 与 Go 必须指向同一 `UPLOAD_DIR`；单一配置源为 `packages/api/.env`，worker 由 `scripts/run-worker.mjs` 启动时自动读取该 .env 注入 `UPLOAD_DIR/THUMB_DIR/IMAGES_DIR`
- **统一响应** — `{ code, message, data }` 包装格式
- **内容统一模型** — `contents` 不再有 `type` 列：内容 = 标题 + 正文（`content`）+ 可选媒体文件（`file_path`，null 即纯文本）；媒体类型（图片/视频）按 `file_path` 扩展名识别（`ContentService.isVideoFile()` / `mediaTypeForPath()`），前端据此填充 `img` / `video` 字段渲染。旧 `type/url/platform/og_*/compressed_path` 列已由迁移脚本 `scripts/migrations/2026-08-05-unify-content-schema.sql` 清理（`file_path` 即展示文件，无压缩图概念）
- **Redis 内容缓存** — 公开读路径（`content:{id}` 详情、`content_list:{sha1}` 列表/搜索、`tags`、`comments:{cid}:{page}`、`comment_count:{cid}`）经 `RedisService.getOrSetJSON()` 读穿，TTL 5 分钟仅作兜底；**所有写路径必须显式失效**（`clearContentCache` / `clearContentListCache` / `clearCommentCache` / `clearAllContentCaches`），新增写操作时务必补上失效点，避免缓存不更新
- **软删除** — 所有删除写 `deleted_at`；Entity 已声明 `@DeleteDateColumn()`，TypeORM 的 `find/findOne/findAndCount` 查询自动附加 `WHERE deleted_at IS NULL`，业务代码无需手动过滤
- **降级优先** — 外部依赖（Tinify/Worker）缺失即降级，gRPC 永不返 rpc error，只返 `success=false` + `error` 文本
- **部署只传编译产物，依赖在启动时自愈** — `deploy.yml` 只通过 FTP 覆盖 `packages/api/dist/`、worker 二进制与前端 dist，**不传依赖清单、也不执行安装**，所以服务器上的 `node_modules` 不会随部署更新（2026-09 曾发现它停留在 7 月那次安装，仓库半年的依赖升级从未到达生产）。对齐由 `scripts/sync-deps.mjs` 承担：`start:backend` 首先调用它，把依赖清单同步到 `origin/master`，仅当 `pnpm-lock.yaml` 的 blob 哈希变化时才执行 `pnpm install --frozen-lockfile`，指纹存 `node_modules/.deps-stamp`；任何失败都只记日志、不阻断启动。因此**改依赖后的首次重启会多花一次安装时间**，其余重启秒过

## 技术栈

| 层 | 技术 |
|----|------|
| API 后端 | NestJS 11 + TypeORM + MySQL + ioredis + @nestjs/microservices(gRPC) |
| Worker | Go 1.25 + gRPC + FFmpeg（**无** DB/Redis/cron 依赖） |
| 前端 | Vue 3.5 + TypeScript + Vite + Tailwind CSS + Arco Design Vue |
| 通信 | gRPC（NestJS → Worker，snake_case via keepCase） |
| 数据库 | MySQL + Redis |
| 运行方式 | pnpm 脚本本地直启（dev 用 scripts/dev.mjs 编排器，生产用 concurrently，无 Docker） |

## 修改指南

1. **先读 `packages/frontend/AGENTS.md`** — 理解前端接口契约
2. **API 改动** — 在 `packages/api/src/` 对应模块中改（entity → service → controller）；模块需用 `@UseGuards` 类引用 guard 时，必须 `import { AuthModule }` 并让其 export 该 guard + `TypeOrmModule`
3. **Worker 改动** — 在 `packages/worker/server/` 中实现纯计算逻辑；涉及文件处理就读 `file_path` 绝对路径、写回结果路径
4. **新增/修改 gRPC 接口** — 先改 `proto/xqecz.proto` → `pnpm --filter @xqecz/proto run generate` 生成 stub → 实现 Go 端 + 在 `packages/api/src/worker/worker.service.ts` 调
5. **推荐算法改动** — 只改 `packages/worker/server/recommend.go:computeRecommend()`（纯函数，输入 `RecommendItem`，输出 `ScoredItem`）；刷新节奏/落库在 api `content.service.ts:refreshRecommend()`（多实例通过 Redis 分布式锁防抖，见 `RedisService.acquireLock()`）
6. **数据库变更** — 改 `packages/api/src/entities/`，生产用正式 migration；`synchronize` 仅本地/测试开，勿在生产长期开启
7. **瀑布流布局改动（前端首页）** — 纯布局算法在 `packages/frontend/src/composables/useWaterfallLayout.ts:computeLayout()`（与 DOM 解耦，输出 `Map<id, Position>`，可直接单测，勿写死在组件里）；改布局逻辑优先改纯函数并补 `__tests__/useWaterfallLayout.test.ts`。核心约定：**稳定列**（卡片落列后不再换列，`preserveColumns` 默认 true，仅列数/列宽变化时全量最短列重排）、**full 全量重排**（数据集合变化——分页追加/diff 更新/列表替换——时强制重新平衡列底，避免增量分配被懒加载测量失真带偏导致短列空缺；图片尺寸变化仍走增量顺移）、**列底失衡收敛**（增量后 max-min 列高差超过 `IMBALANCE_THRESHOLD` 时自动补一次带锚定的全量重排）、**单一调度**（图片加载/尺寸/宽度变化合并到一帧 `requestAnimationFrame` 只 layout 一次）、**滚动锚定**（重算前 captureAnchor 固定视口顶部卡片）、卡片高度由 `[data-wf-id]` 批量量取、`restore`/`reset` 管 keep-alive 缓存。**加载策略**：首页进入即自动连续拉取全部页（`loadAllPages`，每页 100 条，1-100 → 101-200 → …），不依赖滚动触发，图片保持懒加载；keep-alive 往返用**增量同步**（`syncLatestOnActivated` 先拉最新一页对比本地头部，无变化仅同步字段，头部变化才全量对账）。**缓存**：`listCache`（localStorage）统一在 `onBeforeRouteLeave` 离开时写一次；`diffLists` 有全量快照守卫（fresh 数量不足 cached 时 removed 恒空，只做新增合并，杜绝列表截断）。列表筛选/搜索用自增 `loadSeq` 丢弃过期响应防竞态
8. **踩坑记忆** — TypeORM `bigint` 主键返字符串，与 Redis ZSet 数值成员比对需 `String()` 归一化；`tsconfig.json` 需 `esModuleInterop:true`（CJS 默认导入）；libvips 的缓存与线程池在 `content/webp.util.ts` 模块加载时全局收紧（`sharp.cache(false)` + `sharp.concurrency(1)`——默认最多 50MB 解码缓存 + 按核数铺开的线程池，在只偶发转图的服务上是净开销），新增 sharp 用法勿再放大缓存；**V8 堆上限只能在进程启动时用 `--max-old-space-size` 设定**，运行期 `v8.setFlagsFromString` 改不动（实测被忽略），而 CI 只覆盖 `packages/api/dist/`、不含启动参数，故启动参数调整改服务器 root `package.json` 的 `start:backend`（其 `NODE_OPTIONS=` 前缀是 POSIX 语法，该脚本只由宝塔 Node 项目调用，Windows 下直接跑会报错，本地请用 `pnpm dev` / `pnpm start:services`）；**pnpm 11 起不再读取 `package.json` 的 `pnpm` 字段**——`overrides` 等设置必须写在 `pnpm-workspace.yaml`（该文件承载传递依赖的安全覆盖，理由见文件内注释）；服务器上**不要用 Corepack 的 `pnpm`**——`/usr/bin/pnpm` 是 corepack shim，默认访问 `registry.npmjs.org`，而该机访问不了它（`curl` 超时），会让命令永久挂起；须使用 `npm i -g pnpm@11` 装出的真实 pnpm（在 `/www/server/nodejs/v26.5.0/bin`），它继承 npm 的 `registry.npmmirror.com`；服务器上 **`pnpm install` 必须显式压低网络并发**（`scripts/sync-deps.mjs` 已固定 `--network-concurrency=8`）——默认并发会在本机开 130+ 条连接，实测吞吐崩到「12 分钟只拉到 2MB」，降到 8 后 832 个包 58 秒装完；排查时不要据此怪镜像，大文件实测 npmmirror 6.4MB/s、华为云 11.9MB/s，都不慢（小文件测速会被 TLS 握手开销误导）

## 迭代规范（AGENTS.md 自身）

每次完成代码改动、提交前（或随代码改动一并提交）应自检是否需迭代本文件。本规范即**本文件的维护 SOP**：代理由此判断"改动多大、哪些重点值得沉淀"，避免文档过期或过度膨胀。

### 触发条件（满足任一即应迭代）

改动若触及以下任一层面，应更新对应章节：

| 触发点 | 需更新的章节 |
|--------|--------------|
| 新增/删除后端模块、`packages/api/src/` 下目录结构变化 | 目录结构 / 修改指南 2 |
| 新增/修改 gRPC 方法或 proto 字段 | gRPC 接口表 / 修改指南 4 |
| 新增/删除数据库表、Entity、列语义变化 | 目录结构 entities / 修改指南 6 / 核心约束·内容统一模型 |
| 新增/删除前端组件、composable、页面或目录调整 | 目录结构 frontend / 修改指南 7 |
| API 密钥权限、Redis 缓存键、软删除、降级策略等约束变化 | 核心约束对应条目 |
| 增减依赖版本或换技术栈 | 技术栈表 |
| 新增/调整根 pnpm 脚本或常用命令 | 快速命令 |
| 出现新的"踩坑记忆"（类型比对、构建、平台差异等） | 修改指南 8 |
| 产生新的迭代教训（下文"沉淀原则"命中者） | 视情况新增小节 |

### 沉淀原则（何时才值得写进文档）

- **只沉淀"再次需要时无法轻易从代码/现有文档推出"的信息**：文件级定位（哪个文件哪个函数）、模块依赖关系、隐含约定、踩坑、跨端契约。
- **可轻易从代码推断的内容不要写**（如某函数签名细节、随版本的常量值）——保持文档精简，避免与代码漂移。
- **沉淀的应是"约束/约定/推理链"，而非"实现快照"**。实现细节会变，约定长期有效。
- 一次改动通常**只新增/修订一两条**；多条大改请拆分提交，避免单次 diff 过大难审。

### 迭代流程（每步均可执行命令核实）

1. **定位真实变更**：用 `git status` 看改了哪些文件、`git diff --stat` 看规模，先读改动后再写，禁止凭记忆描述（前端约束同 `packages/frontend/AGENTS.md` 第十一条）。
2. **对照上表判断命中**：若无命中则不需改本文件（避免为小改动制造噪音）；有命中则找到对应章节。
3. **最小修订**：只改命中条目，不重排非相关内容；措辞沿用中文、与上下文风格一致。
4. **同步关联文档**：根 `AGENTS.md` 与 `packages/frontend/AGENTS.md` 各自维护自己的部分；改前端时若两者都命中，注意两边一致性（同一事实不要写矛盾）。
5. **自校验（提交前必做）**：重新 `git diff AGENTS.md`，确认
   - 目录树图与实际目录一致（新增文件别漏、删掉的别残留）；
   - 文件路径/函数名/章节名可被搜索定位到真实代码；
   - 命令可在仓库内真实执行（不要写不存在/改名过的脚本）；
   - 全文无自相矛盾（陈旧条目如同名功能须同步更新）。
6. **保留版式**：本文件用 2 空格缩进、中文说明、markdown 表格与 `code` 块定位关键文件；新增内容沿用此风格。

### 版本与变更记录约定

- 迭代以**流水修订**为主，不维护独立"版本号"或"CHANGELOG 章节"——本文件的 git 历史即版本记录。
- 一次提交应包含"代码改动 + 相应的 AGENTS.md 迭代"，确保文档与代码同源同步，避免事后追补。

## 已归档

- 旧后端 `xqecz-golang/`、`xqecz-nodejs/` 已完整迁移进本 monorepo，并归档至 `D:/xqecz/archive/`（各自独立 git 仓库，完整历史保留；均打本地 tag `archive/monorepo-migration-2026-07-22`，远程 `xqecz-all.git` 的 `golang`/`nodejs` 分支亦保留）。monorepo 已 gitignore `/archive/`。
- 独立前端仓库 `xqecz_frontend` 已并入本仓 `packages/frontend`（源文件直接纳入 monorepo，不再独立仓库/symlink）；原独立仓库整体移至 `D:/xqecz/archive/xqecz_frontend` 保留历史（远程 `xqecz_frontend.git` 的 `dev` 分支亦保留）。
