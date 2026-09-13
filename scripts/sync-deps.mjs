#!/usr/bin/env node
/**
 * 启动前的依赖自愈 —— 由 start:backend 首先调用，宝塔每次启动项目都会执行一次。
 *
 * 背景：部署链路只通过 FTP 覆盖 packages/api/dist/ 等编译产物，服务器上的依赖清单
 * （package.json / pnpm-lock.yaml / pnpm-workspace.yaml）与 node_modules 都不随之更新，
 * 于是仓库里的依赖升级从未到达生产 —— 2026-09 排查时服务器上的依赖仍停在 7 月那次安装，
 * 且因缺 packages/* /node_modules 而靠 NODE_PATH 兜底解析。这里在每次启动时把依赖清单
 * 同步到远端分支，并仅在 lockfile 变化时重装依赖。
 *
 * 行为约定：
 * - **永不阻止应用启动**：任何失败都只记录日志并以 0 退出，避免一次安装失败把站点打挂；
 * - 以 pnpm-lock.yaml 的 blob 哈希为指纹（写入 node_modules/.deps-stamp），未变化时秒退，
 *   因此日常重启不会有额外开销；
 * - 只同步依赖清单，不碰源码；源码由部署链路的 dist/ 覆盖；
 * - 仅用于服务器：start:backend 以 XQECZ_SYNC_DEPS=1 调用，本地开发请用 pnpm dev。
 *
 * 服务器前提（已具备）：www 用户对 .git 与 node_modules 有写权限；可访问 GitHub（git fetch）
 * 与 npm 镜像（pnpm install）；pnpm 在 PATH 中。注意不要用 Corepack 的 pnpm shim —— 它默认
 * 访问 registry.npmjs.org，在本机不可达会永久挂起，需使用真实安装的 pnpm。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 需要随远端同步的依赖清单（不含源码）。 */
const MANIFESTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/api/package.json',
  'packages/frontend/package.json',
  'proto/package.json',
]

const STAMP = join(ROOT, 'node_modules', '.deps-stamp')
/** 单次安装的上限；超时即放弃（沿用旧依赖启动），避免启动被无限期挂住。 */
const INSTALL_TIMEOUT_MS = Number(process.env.XQECZ_SYNC_DEPS_TIMEOUT_MS) || 15 * 60 * 1000
const REMOTE = process.env.XQECZ_SYNC_REMOTE || 'origin'
const BRANCH = process.env.XQECZ_SYNC_BRANCH || 'master'

const log = (message) => console.log(`[sync-deps] ${message}`)
const firstLine = (error) =>
  String(error?.stderr || error?.message || error).trim().split('\n')[0]

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function main() {
  if (process.env.XQECZ_SYNC_DEPS !== '1') {
    log('未启用（需 XQECZ_SYNC_DEPS=1；本地开发请用 pnpm dev）')
    return
  }

  // 1. 取远端清单指针。网络不通时沿用现有依赖直接启动。
  try {
    git(['fetch', '--quiet', REMOTE, BRANCH])
  } catch (error) {
    log(`跳过：git fetch ${REMOTE}/${BRANCH} 失败（${firstLine(error)}），沿用现有依赖`)
    return
  }

  let lockBlob
  try {
    lockBlob = git(['rev-parse', `FETCH_HEAD:pnpm-lock.yaml`])
  } catch (error) {
    log(`跳过：读取 FETCH_HEAD 的 pnpm-lock.yaml 失败（${firstLine(error)}）`)
    return
  }

  // 2. 指纹未变则不做任何事 —— 日常重启的常态路径。
  const stamp = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : ''
  if (stamp === lockBlob) {
    log('依赖清单未变化，跳过安装')
    return
  }
  log(`依赖清单已变化（${stamp.slice(0, 12) || '无记录'} -> ${lockBlob.slice(0, 12)}）`)

  try {
    execFileSync('pnpm', ['--version'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    log('跳过：PATH 中找不到可用的 pnpm（勿用 Corepack shim，它会挂起）')
    return
  }

  // 3. 同步清单文件。目标提交里不存在的路径直接忽略。
  for (const file of MANIFESTS) {
    try {
      git(['checkout', 'FETCH_HEAD', '--', file])
    } catch {
      /* 该文件在目标提交中不存在，忽略 */
    }
  }

  // 4. 安装。失败只记录，仍以旧依赖启动，下次重启会重试。
  //    --network-concurrency 必须显式压低：默认值会在本机开 130+ 条并发连接，
  //    实测导致吞吐崩到几乎为零（12 分钟只拉到 2MB），降到 8 后 832 个包 58 秒装完。
  //    timeout 是兜底：任何原因导致的停滞都不会把启动无限期挂住。
  try {
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--network-concurrency=8'],
      { cwd: ROOT, stdio: 'inherit', timeout: INSTALL_TIMEOUT_MS },
    )
  } catch (error) {
    log(`安装失败（${firstLine(error)}），沿用旧依赖启动，下次重启会重试`)
    return
  }

  // 5. 只有安装成功才记账，失败则不写指纹以便重试。
  try {
    mkdirSync(dirname(STAMP), { recursive: true })
    writeFileSync(STAMP, `${lockBlob}\n`)
  } catch (error) {
    log(`写入指纹失败（${firstLine(error)}），下次重启会重复安装`)
  }
  log('依赖同步完成')
}

try {
  main()
} catch (error) {
  // 兜底：任何未预期异常都不能阻止应用启动。
  log(`未预期异常（${firstLine(error)}），沿用现有依赖启动`)
}
