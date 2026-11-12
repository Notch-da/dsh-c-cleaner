/**
 * C盘清理 · Host half.
 *
 * 两件事：
 *  1. 在 /api/dsh-cleaner 下暴露扫描/清理/大文件接口，供 Web 面板调用；
 *  2. 注册三个 Agent 工具（扫描、清理、大文件），与面板共用同一套实现。
 *
 * 安全边界：
 *  - 只处理下面 CATEGORY 表里明确列出的目录，从不递归整个磁盘；
 *  - 遍历时跳过所有符号链接 / 目录联接，防止顺着链接删到别处；
 *  - 只删除根目录"内部"的文件，根目录本身永远保留；
 *  - 被占用的文件自动跳过并如实计数，不做强制删除；
 *  - HTTP 接口只接受本机回环请求。
 */
import { promises as fsp, accessSync, constants as FS, statfsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'

export const name = 'dsh-cleaner'
export const inject = ['webServer']

const API = '/api/dsh-cleaner'
const DRIVE = 'C:\\'
const MAX_BODY = 64 * 1024

/* ------------------------------------------------------------------ */
/* 清理项目白名单                                                       */
/* ------------------------------------------------------------------ */

function categoryTable() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const temp = os.tmpdir()

  return [
    {
      id: 'user_temp', kind: 'dir', risk: 'low', def: true, admin: false,
      name: '用户临时文件', nameEn: 'User temp files',
      desc: '应用程序运行时产生的临时文件，占用最大，可安全删除',
      descEn: 'Temporary files left by applications; the largest and safest category',
      roots: [temp], pattern: '*', recurse: true,
    },
    {
      id: 'win_temp', kind: 'dir', risk: 'low', def: true, admin: true,
      name: '系统临时文件', nameEn: 'System temp files',
      desc: 'C:\\Windows\\Temp 下的系统级临时文件',
      descEn: 'Machine-wide temporary files under C:\\Windows\\Temp',
      roots: [path.join(sysRoot, 'Temp')], pattern: '*', recurse: true,
    },
    {
      id: 'crash', kind: 'dir', risk: 'low', def: true, admin: false,
      name: '应用崩溃转储', nameEn: 'Application crash dumps',
      desc: '程序崩溃时写下的 .dmp 文件，单个可达数百 MB',
      descEn: 'Dump files written when applications crash; a single one can be hundreds of MB',
      roots: [path.join(localApp, 'CrashDumps')], pattern: '*', recurse: true,
    },
    {
      id: 'wer', kind: 'dir', risk: 'low', def: true, admin: true,
      name: 'Windows 错误报告', nameEn: 'Windows error reporting',
      desc: '错误报告的队列与归档文件',
      descEn: 'Queued and archived Windows error reports',
      roots: [
        path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
        path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
        path.join(programData, 'Microsoft', 'Windows', 'WER', 'Temp'),
      ], pattern: '*', recurse: true,
    },
    {
      id: 'inet', kind: 'dir', risk: 'low', def: true, admin: false,
      name: 'Internet 临时文件', nameEn: 'Internet cache',
      desc: 'IE / 系统组件共用的网页与媒体缓存',
      descEn: 'Web and media cache shared by Internet Explorer and system components',
      roots: [path.join(localApp, 'Microsoft', 'Windows', 'INetCache')], pattern: '*', recurse: true,
    },
    {
      id: 'prefetch', kind: 'dir', risk: 'medium', def: false, admin: true,
      name: '预读取文件', nameEn: 'Prefetch data',
      desc: '启动预读缓存，删除后系统会自动重建，前几次启动略慢',
      descEn: 'Boot prefetch cache; Windows rebuilds it, the next few starts are slightly slower',
      roots: [path.join(sysRoot, 'Prefetch')], pattern: '*', recurse: true,
    },
    {
      id: 'wupdate', kind: 'dir', risk: 'medium', def: false, admin: true,
      name: 'Windows 更新缓存', nameEn: 'Windows Update cache',
      desc: '已下载的更新安装包，删除不影响已经安装的更新',
      descEn: 'Downloaded update packages; already installed updates are unaffected',
      roots: [path.join(sysRoot, 'SoftwareDistribution', 'Download')], pattern: '*', recurse: true,
    },
    {
      id: 'delopt', kind: 'dir', risk: 'medium', def: false, admin: true,
      name: '传递优化缓存', nameEn: 'Delivery Optimization cache',
      desc: '更新分发缓存，需要时会重新下载',
      descEn: 'Update distribution cache; re-downloaded on demand',
      roots: [
        path.join(sysRoot, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'),
        path.join(programData, 'Microsoft', 'Network', 'Downloader'),
      ], pattern: '*', recurse: true,
    },
    {
      id: 'cbs', kind: 'file', risk: 'medium', def: false, admin: true,
      name: '系统组件日志', nameEn: 'Component servicing logs',
      desc: 'CBS 组件安装日志，长期使用后可能达到数 GB',
      descEn: 'CBS servicing logs, which can reach several GB over time',
      roots: [path.join(sysRoot, 'Logs', 'CBS')], pattern: '*.log', recurse: false,
    },
    {
      id: 'dump', kind: 'dir', risk: 'medium', def: false, admin: true,
      name: '内存转储文件', nameEn: 'Memory dumps',
      desc: '蓝屏与内核转储，只有排查故障时才需要保留',
      descEn: 'Crash and kernel dumps; keep them only while diagnosing a fault',
      roots: [
        path.join(sysRoot, 'Minidump'),
        path.join(sysRoot, 'LiveKernelReports'),
      ], pattern: '*', recurse: true,
    },
    {
      id: 'thumb', kind: 'file', risk: 'low', def: false, admin: false,
      name: '缩略图缓存', nameEn: 'Thumbnail cache',
      desc: '资源管理器缩略图数据库，清理前建议关闭文件夹窗口，被占用时会跳过',
      descEn: 'Explorer thumbnail database; close folder windows first, locked files are skipped',
      roots: [path.join(localApp, 'Microsoft', 'Windows', 'Explorer')], pattern: 'thumbcache_*.db', recurse: false,
    },
    {
      id: 'icon', kind: 'file', risk: 'low', def: false, admin: false,
      name: '图标缓存', nameEn: 'Icon cache',
      desc: '图标缓存数据库，正在被资源管理器使用的文件会自动跳过',
      descEn: 'Icon cache database; files locked by Explorer are skipped',
      roots: [path.join(localApp, 'Microsoft', 'Windows', 'Explorer')], pattern: 'iconcache_*.db', recurse: false,
    },
    {
      id: 'edge', kind: 'dir', risk: 'medium', def: false, admin: false,
      name: 'Edge 浏览器缓存', nameEn: 'Edge browser cache',
      desc: '网页缓存，清理前请关闭 Edge，否则部分文件会被占用',
      descEn: 'Web cache; close Edge first or some files stay locked',
      roots: [
        path.join(localApp, 'Microsoft', 'Edge', 'User Data', '*', 'Cache'),
        path.join(localApp, 'Microsoft', 'Edge', 'User Data', '*', 'Code Cache'),
        path.join(localApp, 'Microsoft', 'Edge', 'User Data', '*', 'GPUCache'),
      ], pattern: '*', recurse: true,
    },
    {
      id: 'chrome', kind: 'dir', risk: 'medium', def: false, admin: false,
      name: 'Chrome 浏览器缓存', nameEn: 'Chrome browser cache',
      desc: '网页缓存，清理前请关闭 Chrome，否则部分文件会被占用',
      descEn: 'Web cache; close Chrome first or some files stay locked',
      roots: [
        path.join(localApp, 'Google', 'Chrome', 'User Data', '*', 'Cache'),
        path.join(localApp, 'Google', 'Chrome', 'User Data', '*', 'Code Cache'),
        path.join(localApp, 'Google', 'Chrome', 'User Data', '*', 'GPUCache'),
      ], pattern: '*', recurse: true,
    },
    {
      id: 'recycle', kind: 'recycle', risk: 'high', def: false, admin: false,
      name: '回收站', nameEn: 'Recycle Bin',
      desc: '清空 C 盘回收站，删除后无法恢复，请先确认没有误删的文件',
      descEn: 'Empty the C: Recycle Bin; deleted items cannot be recovered',
      roots: [], pattern: '*', recurse: false,
    },
    {
      id: 'winold', kind: 'info', risk: 'manual', def: false, admin: true,
      name: '旧系统备份 (Windows.old)', nameEn: 'Previous Windows installation',
      desc: '系统升级留下的旧版本，请通过「磁盘清理 → 以前的 Windows 安装」移除',
      descEn: 'Left over from a Windows upgrade; remove it with Disk Cleanup instead',
      roots: [path.join(DRIVE, 'Windows.old')], pattern: '*', recurse: true,
    },
    {
      id: 'hiber', kind: 'info', risk: 'manual', def: false, admin: true,
      name: '休眠文件 (hiberfil.sys)', nameEn: 'Hibernation file',
      desc: '关闭休眠可释放：以管理员运行 powercfg /h off',
      descEn: 'Disable hibernation to free it: run powercfg /h off as administrator',
      roots: [path.join(DRIVE, 'hiberfil.sys')], pattern: '*', recurse: false,
    },
    {
      id: 'pagefile', kind: 'info', risk: 'manual', def: false, admin: false,
      name: '虚拟内存文件 (pagefile.sys)', nameEn: 'Page file',
      desc: '系统分页文件，不建议删除，可以在系统属性里把它移到其他磁盘',
      descEn: 'System page file; move it to another disk instead of deleting it',
      roots: [path.join(DRIVE, 'pagefile.sys')], pattern: '*', recurse: false,
    },
  ]
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function categoryById(id) {
  return categoryTable().find(category => category.id === id)
}

function message(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function matchName(pattern, name) {
  if (pattern === '*' || pattern === '*.*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  return new RegExp(source, 'i').test(name)
}

function isLinkError(error) {
  return error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
}

function pushError(bucket, text) {
  if (bucket.errors.length < 6) bucket.errors.push(text)
}

/** 展开带 `*` 的路径，返回真实存在的目录/文件。 */
async function expandRoots(patterns) {
  const out = []
  for (const pattern of patterns) {
    if (!pattern) continue
    if (!pattern.includes('*')) {
      try {
        await fsp.lstat(pattern)
        out.push(pattern)
      } catch { /* 不存在就跳过 */ }
      continue
    }
    const segments = pattern.split(/[\\/]+/).filter(Boolean)
    if (segments.length === 0) continue
    let bases = [/^[A-Za-z]:$/.test(segments[0]) ? segments[0] + '\\' : segments[0]]
    for (let index = 1; index < segments.length; index += 1) {
      const segment = segments[index]
      const next = []
      for (const base of bases) {
        if (segment === '*') {
          let entries = []
          try {
            entries = await fsp.readdir(base, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (entry.isDirectory()) next.push(path.join(base, entry.name))
          }
        } else {
          next.push(path.join(base, segment))
        }
      }
      bases = next
      if (bases.length === 0) break
    }
    for (const candidate of bases) {
      try {
        const stats = await fsp.stat(candidate)
        if (stats.isDirectory() || stats.isFile()) out.push(candidate)
      } catch { /* 忽略 */ }
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                 */
/* ------------------------------------------------------------------ */

async function walkScan(directory, category, accumulator) {
  let entries
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    accumulator.skipped += 1
    return
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    let stats
    try {
      stats = await fsp.lstat(full)
    } catch {
      accumulator.skipped += 1
      continue
    }
    if (stats.isSymbolicLink()) {
      accumulator.skipped += 1
      continue
    }
    if (stats.isDirectory()) {
      if (category.recurse) await walkScan(full, category, accumulator)
      continue
    }
    if (!stats.isFile()) continue
    if (!matchName(category.pattern, entry.name)) continue
    accumulator.bytes += stats.size
    accumulator.files += 1
  }
}

async function scanCategory(category) {
  const result = {
    id: category.id,
    bytes: 0,
    files: 0,
    skipped: 0,
    error: '',
    cleanable: category.kind !== 'info',
    requiresAdmin: category.admin === true,
  }

  if (category.kind === 'recycle') {
    try {
      const info = await recycleInfo()
      result.bytes = info.size
      result.files = info.count
    } catch (error) {
      result.error = message(error)
    }
    return result
  }

  const roots = await expandRoots(category.roots)
  if (roots.length === 0) {
    result.error = 'notfound'
    return result
  }

  for (const root of roots) {
    let stats
    try {
      stats = await fsp.lstat(root)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue

    if (category.kind === 'info') {
      if (stats.isFile()) {
        result.bytes += stats.size
        result.files += 1
      } else if (stats.isDirectory()) {
        await walkScan(root, { ...category, recurse: true, pattern: '*' }, result)
      }
      continue
    }

    if (category.kind === 'file') {
      let entries
      try {
        entries = await fsp.readdir(root, { withFileTypes: true })
      } catch (error) {
        result.error = message(error)
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !matchName(category.pattern, entry.name)) continue
        try {
          const itemStats = await fsp.lstat(path.join(root, entry.name))
          if (!itemStats.isSymbolicLink()) {
            result.bytes += itemStats.size
            result.files += 1
          }
        } catch { /* 忽略 */ }
      }
      continue
    }

    await walkScan(root, category, result)
  }

  return result
}

async function scanAll() {
  const categories = categoryTable()
  const items = await Promise.all(categories.map(async category => ({
    ...(await scanCategory(category)),
    name: category.name,
    nameEn: category.nameEn,
    desc: category.desc,
    descEn: category.descEn,
    risk: category.risk,
    defaultOn: category.def === true,
  })))
  const total = items.reduce((sum, item) => sum + item.bytes, 0)
  return {
    admin: isElevated(),
    disk: diskInfo(),
    totalBytes: total,
    items,
  }
}

/* ------------------------------------------------------------------ */
/* 清理                                                                 */
/* ------------------------------------------------------------------ */

/** 删除单个文件；只读文件先去掉只读属性再重试一次。 */
async function removeFile(target) {
  try {
    await fsp.unlink(target)
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      try {
        await fsp.chmod(target, 0o666)
      } catch { /* 改属性失败就按原错误上报 */ }
      await fsp.unlink(target)
      return
    }
    throw error
  }
}

async function cleanDirectory(directory, category, result, isRoot) {
  let entries
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true })
  } catch (error) {
    pushError(result, `${directory} → ${message(error)}`)
    return
  }

  const subdirectories = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    let stats
    try {
      stats = await fsp.lstat(full)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue

    if (stats.isDirectory()) {
      if (category.recurse) subdirectories.push(full)
      continue
    }
    if (!stats.isFile()) continue
    if (!matchName(category.pattern, entry.name)) continue

    try {
      await removeFile(full)
      result.deleted += 1
      result.freed += stats.size
    } catch (error) {
      result.failed += 1
      result.failedBytes += stats.size
      if (isLinkError(error)) continue
      pushError(result, `${full} → ${message(error)}`)
    }
  }

  for (const subdirectory of subdirectories) {
    await cleanDirectory(subdirectory, category, result, false)
  }

  if (!isRoot) {
    try {
      await fsp.rmdir(directory)
      result.removedDirs += 1
    } catch { /* 非空或占用，保留 */ }
  }
}

async function cleanCategory(category) {
  const result = {
    id: category.id,
    freed: 0,
    deleted: 0,
    failed: 0,
    failedBytes: 0,
    removedDirs: 0,
    errors: [],
  }

  if (category.kind === 'info') return result

  if (category.kind === 'recycle') {
    let before = null
    try {
      before = await recycleInfo()
    } catch { /* 查询失败也继续尝试清空 */ }
    try {
      await emptyRecycle()
    } catch (error) {
      pushError(result, message(error))
      result.failed += 1
    }
    if (before) {
      let after = null
      try {
        after = await recycleInfo()
      } catch { /* 忽略 */ }
      const remaining = after ? after.size : 0
      result.freed = Math.max(0, before.size - remaining)
      result.deleted = before.count
    }
    return result
  }

  const roots = await expandRoots(category.roots)
  for (const root of roots) {
    let stats
    try {
      stats = await fsp.lstat(root)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue

    if (category.kind === 'file') {
      let entries
      try {
        entries = await fsp.readdir(root, { withFileTypes: true })
      } catch (error) {
        pushError(result, `${root} → ${message(error)}`)
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !matchName(category.pattern, entry.name)) continue
        const full = path.join(root, entry.name)
        let size = 0
        try {
          const itemStats = await fsp.lstat(full)
          if (itemStats.isSymbolicLink()) continue
          size = itemStats.size
        } catch {
          continue
        }
        try {
          await removeFile(full)
          result.deleted += 1
          result.freed += size
        } catch (error) {
          result.failed += 1
          result.failedBytes += size
          if (!isLinkError(error)) pushError(result, `${full} → ${message(error)}`)
        }
      }
      continue
    }

    await cleanDirectory(root, category, result, true)
  }

  return result
}

async function cleanMany(ids) {
  const selected = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
  const categories = categoryTable().filter(category => selected.includes(category.id))
  const before = diskInfo()
  const items = []
  for (const category of categories) {
    items.push(await cleanCategory(category))
  }
  const after = diskInfo()
  const freed = items.reduce((sum, item) => sum + item.freed, 0)
  const failed = items.reduce((sum, item) => sum + item.failed, 0)
  return {
    freed,
    failed,
    freeBefore: before.free,
    freeAfter: after.free,
    items,
  }
}

/* ------------------------------------------------------------------ */
/* 大文件                                                               */
/* ------------------------------------------------------------------ */

const BIG_SKIP = new Set(['$recycle.bin', 'system volume information', 'winsxs', 'driverstore'])

/** 扫描一个目录：登记大文件，返回子目录列表。跳过链接与系统组件仓库。 */
async function scanDirForBig(directory, threshold, bucket) {
  let entries
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const subdirectories = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const lower = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      if (BIG_SKIP.has(lower)) continue
      subdirectories.push(path.join(directory, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    if (lower === 'pagefile.sys' || lower === 'hiberfil.sys' || lower === 'swapfile.sys') continue
    const full = path.join(directory, entry.name)
    try {
      const stats = await fsp.stat(full)
      if (stats.size >= threshold) {
        bucket.push({ path: full, size: stats.size, modified: stats.mtime.toISOString() })
      }
    } catch { /* 忽略不可读文件 */ }
  }
  return subdirectories
}

/** 并发广度遍历整盘；outstanding 计数保证队列暂时为空时不会提前退出。 */
async function walkBigConcurrent(threshold, bucket) {
  const queue = [DRIVE]
  let outstanding = 1
  const worker = async () => {
    for (;;) {
      const directory = queue.pop()
      if (directory === undefined) {
        if (outstanding <= 0) return
        await new Promise(resolve => setTimeout(resolve, 2))
        continue
      }
      const subdirectories = await scanDirForBig(directory, threshold, bucket)
      outstanding -= 1
      for (const subdirectory of subdirectories) {
        queue.push(subdirectory)
        outstanding += 1
      }
    }
  }
  await Promise.all(Array.from({ length: 24 }, () => worker()))
}

async function bigFiles(minMb) {
  const threshold = Math.max(10, Number(minMb) || 200) * 1024 * 1024
  const bucket = []
  await walkBigConcurrent(threshold, bucket)
  bucket.sort((left, right) => right.size - left.size)
  return {
    minMb: threshold / (1024 * 1024),
    items: bucket.slice(0, 120),
  }
}
async function revealFile(target) {
  if (typeof target !== 'string' || !target) throw new Error('path required')
  const stats = await fsp.lstat(target)
  if (!stats.isFile()) throw new Error('not a file')
  execFile('explorer.exe', ['/select,', target], { windowsHide: false }, () => {})
  return { revealed: target }
}

/* ------------------------------------------------------------------ */
/* 系统查询                                                             */
/* ------------------------------------------------------------------ */

function diskInfo() {
  try {
    const stats = statfsSync(DRIVE)
    const blockSize = Number(stats.bsize)
    return {
      total: blockSize * Number(stats.blocks),
      free: blockSize * Number(stats.bavail),
    }
  } catch {
    return { total: 0, free: 0 }
  }
}

function isElevated() {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 4000 })
    return true
  } catch {
    return false
  }
}

function runPowerShell(script, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeout || 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout || '').trim())
      },
    )
  })
}

async function recycleInfo() {
  const output = await runPowerShell(
    '$shell = New-Object -ComObject Shell.Application;'
    + ' $size = 0; $count = 0;'
    + ' foreach ($item in $shell.Namespace(10).Items()) { $size += $item.Size; $count += 1 };'
    + " '{0}|{1}' -f $size, $count",
  )
  const [size, count] = String(output).split('|')
  const bytes = Number(size)
  const items = Number(count)
  return {
    size: Number.isFinite(bytes) ? bytes : 0,
    count: Number.isFinite(items) ? items : 0,
  }
}

async function emptyRecycle() {
  await runPowerShell('Clear-RecycleBin -DriveLetter C -Force -ErrorAction Stop', 60000)
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                            */
/* ------------------------------------------------------------------ */

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(payload)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  const parsed = JSON.parse(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** 只接受本机回环请求：桌面端浏览器直连 127.0.0.1 时通过。 */
function isTrustedRequest(request) {
  const raw = String(request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : '').toLowerCase()
  const isLoopback = raw === '::1'
    || raw.startsWith('127.')
    || (raw.startsWith('::ffff:') && raw.slice('::ffff:'.length).startsWith('127.'))
  if (!isLoopback) return false
  if (request.headers['x-forwarded-for'] !== undefined) return false
  if (request.headers['cf-connecting-ip'] !== undefined) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL('http://' + host).hostname
  } catch {
    return false
  }
  const hostOk = hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.')
  if (!hostOk) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function route(handler) {
  return async (request, response) => {
    if (!isTrustedRequest(request)) {
      writeJson(response, 403, { ok: false, error: 'forbidden: loopback only' })
      return
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readBody(request)
      const value = await handler(body)
      writeJson(response, 200, { ok: true, ...value })
    } catch (error) {
      writeJson(response, 500, { ok: false, error: message(error) })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Agent 工具                                                           */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 4) return (value / 1024 ** 4).toFixed(2) + ' TB'
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB'
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

function renderScan(value) {
  const lines = []
  lines.push(`C 盘可清理内容合计 ${formatBytes(value.totalBytes)}（共 ${value.items.length} 项，`
    + `${value.admin ? '管理员权限' : '普通用户权限'}）。`)
  lines.push('')
  lines.push('| 项目 | 大小 | 文件数 | 状态 |')
  lines.push('| --- | --- | --- | --- |')
  for (const category of categoryTable()) {
    const item = value.items.find(entry => entry.id === category.id)
    if (!item) continue
    let status = '可清理'
    if (!item.cleanable) status = '仅提示'
    else if (item.error === 'notfound' || (item.bytes <= 0 && item.files <= 0)) status = '无内容'
    else if (item.requiresAdmin && !value.admin) status = '需管理员'
    lines.push(`| ${category.name} | ${formatBytes(item.bytes)} | ${item.files} | ${status} |`)
  }
  lines.push('')
  lines.push('清理前请先向用户确认要处理的条目，再调用 c_cleaner_clean。')
  return lines.join('\n')
}

function renderClean(value) {
  const lines = []
  lines.push(`本次清理释放 ${formatBytes(value.freed)}，磁盘可用空间 ${formatBytes(value.freeBefore)} → ${formatBytes(value.freeAfter)}。`)
  if (value.failed > 0) lines.push(`有 ${value.failed} 个文件被占用或无权限，已跳过。`)
  const details = value.items.filter(item => item.freed > 0 || item.failed > 0)
  if (details.length > 0) {
    lines.push('')
    for (const item of details) {
      const category = categoryById(item.id)
      lines.push(`- ${category ? category.name : item.id}：释放 ${formatBytes(item.freed)}，删除 ${item.deleted} 个文件`
        + (item.failed > 0 ? `，跳过 ${item.failed} 个` : ''))
      for (const errorText of item.errors.slice(0, 3)) lines.push(`  - ${errorText}`)
    }
  }
  return lines.join('\n')
}

function renderBig(value) {
  if (!value.items.length) return `C 盘上没有找到大于 ${value.minMb} MB 的文件。`
  const lines = [`C 盘中大于 ${value.minMb} MB 的文件（按大小排序，最多 120 个）：`, '']
  for (const item of value.items.slice(0, 40)) {
    lines.push(`- ${formatBytes(item.size)}  ${item.path}`)
  }
  return lines.join('\n')
}

const scanTool = {
  name: 'c_cleaner_scan',
  description: '扫描 Windows C 盘上可安全清理的垃圾（临时文件、浏览器缓存、更新包、日志、崩溃转储等），'
    + '返回每一项的占用大小、文件数与状态。只读操作，不会删除任何文件。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        admin: { type: 'boolean' },
        totalBytes: { type: 'number' },
        disk: { type: 'object', properties: { total: { type: 'number' }, free: { type: 'number' } } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              bytes: { type: 'number' },
              files: { type: 'number' },
              cleanable: { type: 'boolean' },
              requiresAdmin: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
        },
      },
      required: ['items'],
    },
    render: (_args, value) => [{ type: 'text', text: renderScan(value) }],
  },
  execute: async () => scanAll(),
}

const cleanTool = {
  name: 'c_cleaner_clean',
  description: '清理 C 盘垃圾项。ids 取自 c_cleaner_scan 的返回；必须在用户明确同意清理之后才可调用，'
    + '并传入 confirm: true。被占用的文件会自动跳过，返回实际释放的空间。',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '要清理的项目 id 列表，例如 ["user_temp", "crash"]',
      },
      confirm: {
        type: 'boolean',
        description: '必须为 true，表示用户已经明确同意清理这些项目',
      },
    },
    required: ['ids', 'confirm'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        freed: { type: 'number' },
        failed: { type: 'number' },
        freeBefore: { type: 'number' },
        freeAfter: { type: 'number' },
        items: { type: 'array', items: { type: 'object', properties: {} } },
      },
      required: ['freed'],
    },
    render: (_args, value) => [{ type: 'text', text: renderClean(value) }],
  },
  execute: async (args) => {
    const input = args && typeof args === 'object' ? args : {}
    if (input.confirm !== true) {
      throw new Error('拒绝执行：清理会永久删除文件，请先取得用户明确同意，再以 confirm: true 调用。')
    }
    if (!Array.isArray(input.ids) || input.ids.length === 0) {
      throw new Error('ids 不能为空，请先调用 c_cleaner_scan 获取项目 id。')
    }
    return cleanMany(input.ids)
  },
}

const bigTool = {
  name: 'c_cleaner_big_files',
  description: '列出 C 盘中大于指定体积的文件（默认 200 MB），用于排查磁盘占用。只读操作。',
  parameters: {
    type: 'object',
    properties: {
      minMb: { type: 'number', description: '最小体积（MB），默认 200，最小 10' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        minMb: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              size: { type: 'number' },
              modified: { type: 'string' },
            },
          },
        },
      },
      required: ['items'],
    },
    render: (_args, value) => [{ type: 'text', text: renderBig(value) }],
  },
  execute: async (args) => {
    const input = args && typeof args === 'object' ? args : {}
    return bigFiles(input.minMb)
  },
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const routes = [
    ['scan', () => scanAll()],
    ['clean', body => cleanMany(body && body.ids)],
    ['big', body => bigFiles(body && body.minMb)],
    ['reveal', body => revealFile(body && body.path)],
  ]

  ctx.effect(() => {
    const disposers = routes.map(([endpoint, handler]) => ctx.webServer.register({
      kind: 'exact',
      path: `${API}/${endpoint}`,
      handler: route(handler),
    }))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch { /* 关闭阶段忽略 */ }
      }
    }
  }, 'dsh-cleaner: routes')

  const tools = typeof ctx.get === 'function' ? ctx.get('tools', false) : undefined
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => {
      const disposers = [scanTool, cleanTool, bigTool].map(definition => tools.register(definition))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch { /* 关闭阶段忽略 */ }
        }
      }
    }, 'dsh-cleaner: tools')
  }
}

/* 供自检与外部调试使用；Cordis 只读取 apply / name / inject。 */
export { scanAll, cleanMany, bigFiles, diskInfo, categoryTable }
