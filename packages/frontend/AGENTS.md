# AGENTS.md

## 关键命令

```bash
# 启动开发服务器（热更新，API 代理到 localhost:3000）
pnpm --filter ./packages/frontend run dev

# 生产构建（先 type-check 再 vite build）
pnpm --filter ./packages/frontend run build

# 仅 TypeScript 类型检查（不构建）
pnpm --filter ./packages/frontend run type-check

# 完整 lint：oxlint + eslint 自动修复
pnpm --filter ./packages/frontend run lint

# Prettier 格式化 src/ 下所有文件
pnpm --filter ./packages/frontend run format

# 单元测试
pnpm --filter ./packages/frontend run test
```

---

## 技术栈

| 类别 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 框架 | Vue | ^3.5 | Composition API + `<script setup>` |
| 语言 | TypeScript | ~6.0 | strict 模式，全量类型覆盖 |
| 构建 | Vite | ^8.0 | 开发/构建，插件生态 |
| 组件库 | Arco Design Vue | ^2.58 | `@arco-design/web-vue`，按需自动引入（ArcoResolver），图标用 `@arco-design/web-vue/es/icon` |
| 路由 | vue-router | ^5.0 | hash 模式，懒加载，路由守卫 |
| 状态 | Pinia | ^3.0 | Setup Store 语法 |
| CSS | Tailwind CSS | ^4.3 | 原子类优先，`@theme` 自定义变量 |
| HTTP | ofetch | ^1.5 | 统一封装，自动重试，超时控制 |
| Markdown | marked + DOMPurify | ^18.0 / ^3.4 | 渲染 + XSS 防护 |
| 编辑器 | vditor | ^3.11 | Markdown 编辑器（上传页/评论） |
| 图片查看 | viewerjs | ^1.11 | 全屏图片查看器 |
| 校验 | zod | ^4.4 | 运行时校验（schemas.ts） |
| 测试 | vitest + @vue/test-utils + jsdom | ^4.1 / ^2.4 / ^30 | 单元测试（components/composables/stores/utils `__tests__/`） |
| 校验 | oxlint | ~1.78 | Rust 高性能 lint（correctness 规则） |
| 校验 | ESLint | ^10.8 | vue-ts + oxlint 插件（插件版本与 oxlint 对齐） |
| 格式化 | Prettier | 3.9 | 统一代码风格 |
| 图像 | vite-plugin-image-optimizer | ^2.0 | 构建时压缩 PNG/JPEG/WebP/AVIF/SVG |

---

## 架构

### 目录结构

```
src/
├── api/              # HTTP 请求层，按业务域分模块导出
│   └── index.ts      # authApi / contentApi / commentApi / pollApi / adminApi / apiKeyApi
├── assets/
│   ├── main.css      # Tailwind 入口 + CSS 变量（:root / html.dark）
│   ├── bg.webp       # 背景图
│   └── logo.webp     # Logo
├── components/
│   ├── admin/        # 后台管理组件（Arco + Sass 控制台设计系统，见「后台设计系统」节）
│   ├── __tests__/    # 组件单测（ConfirmDialog / MediaImage / WaterfallCard）
│   └── *.vue         # 通用 UI 组件
├── composables/      # 组合式函数
│   ├── useGlobalSearch.ts   # 全局搜索单例（watchGlobalSearch 供跨页联动）
│   ├── useSearchFilter.ts   # 搜索/标签筛选（标签列表 useStorage 按天缓存）
│   ├── useContentBrowse.ts  # 内容浏览/分页加载（总览或标签模式）
│   ├── useListCache.ts      # localStorage 列表缓存 + diffLists 差量合并（快照守卫：部分拉取 removed 恒空）
│   ├── useRecommendLoader.ts # 推荐内容加载
│   ├── useWaterfallLayout.ts # 瀑布流布局（纯算法 computeLayout 与 DOM 解耦）
│   ├── useFilePicker.ts     # 文件选择/校验（md5 重命名）
│   ├── useToast.ts          # 确认对话框 + toast
│   └── __tests__/    # composable 单测（useSearchFilter / useWaterfallLayout / useListCache）
├── router/
│   └── index.ts      # 路由表 + 导航守卫 + 后台预加载队列
├── stores/           # Pinia 全局状态
│   ├── theme.ts      # 明暗模式（body arco-theme 属性驱动）
│   ├── home.ts       # 首页搜索/筛选/分页/滚动位置/瀑布流布局缓存
│   ├── admin.ts      # 后台管理状态（含 pendingCounts 待办角标）
│   ├── user.ts       # 登录态 / 用户信息
│   └── __tests__/    # store 单测（home / user）
├── types/
│   ├── index.ts      # 所有 TypeScript 类型定义
│   └── schemas.ts    # Zod schema（运行时校验 + transform）
├── utils/
│   ├── index.ts      # getImageUrl / getRemoteFallbackUrl / getAvatarUrl / formatTime / getPreviewText / renderMarkdown / toFormData
│   ├── constants.ts  # CC 协议文本 / 视频条款文本
│   ├── webVitals.ts  # Web Vitals 监控
│   └── __tests__/    # utils 单测
├── views/            # 页面级组件
│   ├── HomeView.vue         # 瀑布流首页（自包含推荐区 + 自动全量加载 + 卡片点击路由跳转）
│   ├── ContentDetailView.vue # 全屏覆盖式详情页（两栏布局 + 评论 + 认领）
│   ├── QuickUploadView.vue  # 游客快速上传
│   ├── LoginView.vue        # 登录页
│   └── AdminView.vue        # 后台管理（控制台外壳：AdminNav 侧栏 + AdminPanel 面板）
├── App.vue           # 根组件：导航栏/页脚/Toast/Confirm/路由过渡
└── main.ts           # 入口：createApp → Pinia → Router → mount
# 包根另含 env.d.ts（环境变量类型定义）、vite.config.ts、vitest.config.ts
```

### 数据流

```
View（薄层，组装组件）
  └── Composable（业务逻辑，调用 API + Store）
        ├── Store（Pinia，跨组件共享状态）
        └── API（ofetch，HTTP 通信）
              └── Type（types/index.ts，请求/响应类型约束）
```

- **View 只管渲染**：从 composable 取数据，绑定到模板，不直接调 API
- **Composable 管逻辑**：拥有本地状态，调用 API 和 Store，暴露方法给 View
- **Store 管全局状态**：theme / home / admin / user 四个领域，Setup Store 语法

### 明暗模式

明暗模式通过 `stores/theme.ts` 管理，仅操作 `<body arco-theme="dark">` 属性（`setAttribute`/`removeAttribute`），触发 Arco 原生暗色；亮/暗偏好持久化到 `localStorage`（`theme_mode`）。CSS 变量值由 `main.css` 中的 `:root` / `html.dark`（即 `body[arco-theme='dark']` 选择器）控制，随属性自动翻日/夜，不通过 JS 逐个 setProperty。

- `App.vue` header 下拉切换日间/暗色
- Arco token（`--color-bg-*` / `--color-text-*` / `--primary-*` 等）随 `<body arco-theme="dark">` 自动切换，组件无需逐个适配
- Tailwind 组件可用 `dark:` 前缀或 `var(--theme-*)` / `var(--color-*)` CSS 变量

### 路由

| 路径 | 组件 | 说明 |
|------|------|------|
| `/` | HomeView | 瀑布流首页（推荐区 + 自动全量加载，图片懒加载） |
| `/content/:id` | ContentDetailView | 全屏覆盖式详情页 |
| `/quick-upload` | QuickUploadView | 游客快速上传 |
| `/login` | LoginView | 登录页 |
| `/admin` | AdminView | 后台管理（requiresAuth） |

- 所有视图使用 `defineAsyncComponent` 按需加载
- 首页加载后通过 `requestIdleCallback` 按优先级延迟预加载其他视图
- 路由切换有淡入淡出过渡（`route-fade` Transition）

### 详情页交互

点击瀑布流卡片 → `homeStore.saveState()` 保存筛选/滚动位置 → `router.push('/content/:id')` 无痕切换到全屏详情页。

详情页采用 `position: fixed; inset: 0` 全屏覆盖布局（覆盖 App header/footer）：
- 左侧 60%：媒体区（图片点击触发 viewerjs 全屏看图 / 视频播放器 / 外链卡片 / 纯文字）
- 右侧 40%：作者卡 + 标签 + 简介（Markdown 渲染）+ 参考图 + 生成参数 + 评论列表
- 底部：点赞/收藏/分享/下载交互栏
- 顶部返回箭头 / ESC / 浏览器后退 → `router.back()` 返回瀑布流
- 窄屏 <768px 上下堆叠

---

## 规范

### 一、Vue 组件

#### 1.1 模板
- **必须**使用 `<script setup lang="ts">`
- Props 用纯类型语法 `defineProps<Props>()`，默认值用 `withDefaults`
- Emits 用类型语法 `defineEmits<{ event: [payload: Type] }>()`
- 需要暴露给父组件的方法/状态用 `defineExpose({ ... })`
- 样式**必须**加 `scoped`

```vue
<script setup lang="ts">
interface Props {
  title: string
  count?: number
}

const props = withDefaults(defineProps<Props>(), {
  count: 0,
})

const emit = defineEmits<{
  submit: [value: string]
  cancel: []
}>()
</script>

<template>
  <div class="...">{{ props.title }}</div>
</template>

<style scoped>
/* 仅当 Tailwind 无法实现时写在这里 */
</style>
```

#### 1.2 组件拆分
- View 组件尽量薄，不超过 **200 行**
- 通用组件不超过 **500 行**
- 业务逻辑必须下沉到 composable
- `components/admin/` 下为后台专用组件

#### 1.3 组件通信
- 父子：Props down / Emits up
- 跨组件共享状态：Pinia Store
- 临时跨层级：`provide/inject`

### 二、样式

#### 2.1 Tailwind 优先（强制）
**能用 Tailwind 原子类实现的效果，禁止写普通 CSS。**

- 间距、颜色、字体、边框、阴影、圆角等一律用 Tailwind 类
- 响应式用 `sm:` / `lg:` / `xl:` 前缀
- 暗色模式用 `dark:` 前缀
- 状态变体：`hover:` / `focus:` / `disabled:`
- 过渡动画：`transition-*` / `duration-*` / `ease-*`

```vue
<!-- 正确 -->
<div class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">

<!-- 错误 -->
<div style="padding: 8px 16px; background: #3b82f6;">
```

#### 2.2 CSS 变量
项目通过 `main.css` 的 `:root` / `html.dark` 定义 CSS 变量，可直接用 Tailwind 任意值语法：

```vue
<span class="text-[var(--theme-text)]">...</span>
<div class="bg-[var(--theme-card-bg)] rounded-xl shadow-md">...</div>
```

新代码推荐用 `--color-*` 命名（如 `var(--color-primary)`），旧代码兼容别名 `--theme-*`（如 `var(--theme-primary)`）。

常用变量：`--color-text`、`--color-text-secondary`、`--color-primary`、`--color-surface`、`--color-card`、`--color-border`、`--color-hover`、`--color-bg`（兼容别名 `--theme-*` 同名映射）

#### 2.3 后台设计系统（/admin）

后台为独立控制台设计语言（2026-08 重设计），与其他页面互不干扰：

- **作用域令牌**：运行时令牌定义在 `AdminView.vue` 非 scoped 样式的 `.admin-theme` 类上（`--admin-text/-2/-3`、`--admin-border(-soft)`、`--admin-fill`、`--admin-surface`、`--admin-primary(-soft)`、`--admin-danger(-soft)`、`--admin-radius`、`--admin-shadow`），亮/暗双套。teleport 到 body 的抽屉/弹层（`AdminContentDrawer`、移动端导航抽屉）必须带 `admin-theme` 类才能解析这些变量；弹窗内的局部样式只用全局 Arco token
- **编译期层**：`components/admin/_admin.scss` 提供 `$admin-*` 别名与 mixin（`content-thumb` / `mobile-card` / `ellipsis` 等），仅编译期，不含运行时输出
- **面板模式**：所有页签面板套 `<AdminPanel title desc>`（`#actions` 放筛选/主操作/刷新），表格、幽灵图标按钮（`.admin-icon-btn` + `.is-primary/.is-danger`）、单元格文本（`.admin-cell-2/-3/-title`、`.admin-mono`）、移动端卡片（`.admin-mobile-*`）样式集中在 AdminPanel 的 `:deep` 里，子面板不写重复 CSS
- **状态展示**：一律用 `<AdminStatus type label>` 状态点（成功/警告/危险/信息/中性），不用高饱和填充 Tag；类型/角色等分类仍可用 Arco Tag（`:bordered="false"`）
- **侧边导航**：`AdminNav`（分组 + 待办角标 + 用户卡），角标数据来自 store 的 `pendingCounts`（`loadPendingCounts()`，独立于列表分页状态，切页签自动刷新）
- **Arco 与 antd 的 API 差异**（迁移教训，Arco 对不认识的属性**静默忽略**）：
  - Menu 无 `:items`，必须 `<a-menu-item>` 子组件；无 `mode="inline"`（用 vertical）
  - Table 列定义无 `key`（用 `dataIndex`/`slotName`）；分页无 `showSizeChanger`
  - Form 的 `model` 为类型必填（无校验也传 `:model="{}"`）；Progress 无 `status="active"`
  - Button 危险态用 `status="danger"`（无 `danger` prop）；图标一律 `@arco-design/web-vue/es/icon`


### 三、TypeScript

- 开启 `strict: true`
- 类型定义集中于 `src/types/index.ts`
- 环境变量类型定义在 `env.d.ts`
- 统一使用 `@/` 别名导入（对应 `src/`），禁止相对路径 `../../`
- `vue-router` 的 RouteMeta 通过 `declare module` 扩展
- 禁止 `any`，除非是第三方库的不得已场景

```ts
// 正确
import { useUserStore } from '@/stores/user'
import type { Content } from '@/types'

// 错误
import { useUserStore } from '../../stores/user'
```

### 四、API 层

- 所有 HTTP 请求通过 `@/api` 统一出口，禁止在组件中直接调用 `ofetch`
- 按业务域分模块：`authApi` / `contentApi` / `commentApi` / `pollApi` / `adminApi` / `apiKeyApi`
- 统一响应格式：

```ts
interface ApiResponse<T = unknown> {
  code: number    // 200 = 成功
  message: string
  data: T
}
```

- 文件上传使用 `FormData` + `XMLHttpRequest`（需要进度回调）
- 普通请求使用 `ofetch`，内置 3 次重试、10 秒超时
- 拦截器通过 `addInterceptor()` 注册（统一处理 401 跳转登录等）

```ts
// 正确：通过 api 模块调用
import { contentApi } from '@/api'
const res = await contentApi.list({ page: 1 })

// 错误：直接调 ofetch
import { ofetch } from 'ofetch'
const res = await ofetch('/api/content/list')
```

### 五、Composable（组合式函数）

- 文件名以 `use` 开头，camelCase：`useContentLoader.ts`
- 函数名与文件名一致
- 返回**对象**（非数组），便于按需解构
- 有副作用的逻辑（watch/onMounted）放在 composable 内，不在 View 中

```ts
// src/composables/useXxx.ts
export function useXxx() {
  const data = ref<Type[]>([])
  const loading = ref(false)

  async function fetch() { /* ... */ }

  return { data, loading, fetch }
}
```

### 六、Pinia Store

- 使用 Setup Store 语法（`defineStore('name', () => { ... })`）
- Store 文件命名：`stores/<domain>.ts`
- Store 命名：`use<Domain>Store`
- 仅存放真正需要跨组件/跨路由共享的状态

```ts
export const useThemeStore = defineStore('theme', () => {
  const mode = ref<'light' | 'dark'>('light')

  function setMode(newMode: 'light' | 'dark') { /* ... */ }

  return { mode, setMode }
})
```

### 七、命名规范

| 对象 | 规范 | 示例 |
|------|------|------|
| Vue 组件 | PascalCase | `CommentItem.vue` |
| 视图组件 | PascalCase + `View` 后缀 | `HomeView.vue` |
| Composable | camelCase + `use` 前缀 | `useRecommendLoader` |
| Pinia Store | camelCase + `use` 前缀 + `Store` 后缀 | `useThemeStore` |
| API 模块 | camelCase + `Api` 后缀 | `contentApi` |
| Type 文件 | 集中 `types/index.ts` | — |
| 常量 | SCREAMING_SNAKE_CASE | `CC_LICENSE_TEXT` |
| CSS 变量 | kebab-case + `--color-` 前缀 | `--color-primary` |

### 八、错误处理

- 所有 async 函数内用 try/catch 包裹
- catch 中至少 `console.error` 记录
- 用户可见错误通过 `emit('message', text)` 或 toast 反馈
- 请求竞态用**自增 requestId** 模式防抖：

```ts
let requestId = 0

async function load() {
  const currentId = ++requestId
  const res = await api()
  if (currentId !== requestId) return  // 过期响应，丢弃
  data.value = res.data
}
```

### 九、格式化

所有项目文件必须符合以下规则（由 Prettier + EditorConfig 强制）：

| 规则 | 值 |
|------|-----|
| 缩进 | 2 空格 |
| 分号 | 无 |
| 引号 | 单引号 |
| 行宽 | 100 字符 |
| 换行符 | LF |
| 编码 | UTF-8 |
| 行尾空格 | 自动去除 |
| 文件末尾 | 保留空行 |

### 十、性能

- **路由懒加载**：所有 view 使用 `defineAsyncComponent` + `() => import(...)`，禁止同步 import
- **后台预加载**：首页渲染后，低优先级 view 通过 `requestIdleCallback` 按延迟队列预加载
- **标签缓存**：标签列表用 `localStorage` 按天缓存，减少 API 请求
- **图片懒加载**：`<img loading="lazy">`（已默认）
- **构建分包**：vite config 中 `manualChunks` 分离 vue-vendor（vue/pinia）、arco-vendor（@arco-design）、utils-vendor（marked/dompurify/ofetch）；配置文件里仍有 motion-vendor 残留分支（motion-v 依赖已移除，属死代码，勿依赖）

### 十一、分析规范

**对项目文件存在性、结构、状态的任何断言，必须先实际读取再下结论，禁止凭记忆或推测。**

- 判断目录是否为空 → 先 `read` 该目录
- 判断文件是否存在 → 先 `glob` 或 `read`
- 判断某功能是否已实现 → 先 `grep` 搜索关键代码
- 判断依赖是否被使用 → 先 `grep` 搜索 import 语句
- 评估项目质量 → 逐项核实后列出，标注"已确认"和"未确认"

### 十二、CI/CD

项目已有 GitHub Actions 工作流（`.github/workflows/`）：

| 文件 | 触发条件 | 流程 |
|------|---------|------|
| `ci.yml` | push 到 `master` / PR | 三端 CI：api typecheck+build、frontend type-check+vitest 测试、worker `go test`（覆盖率上传 Codecov） |
| `deploy.yml` | push 到 `master` / 手动 | 三端构建 → FTP 部署（api/worker/frontend 三份 dist）→ 宝塔面板 API 重启服务（项目名 `xqecz2`） |
| `sonarcloud.yml` | push 到 `master` / PR | SonarCloud 静态分析（worker Go 覆盖率 + 前端/后端扫描） |
