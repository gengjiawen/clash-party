import { execFile } from 'child_process'
import { createHash } from 'crypto'
import {
  chmodSync,
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { platform } from 'os'
import { basename, join } from 'path'
import { promisify } from 'util'
import { createGunzip } from 'zlib'
import AdmZip from 'adm-zip'
import { extract } from 'tar'
import { restartCore, stopCore } from '../core/manager'
import { getAppConfig } from '../config'
import { mihomoCoreDir, mihomoCorePath } from './dirs'
import * as chromeRequest from './chromeRequest'
import { createLogger } from './logger'

const log = createLogger('GitHub')
const execFilePromise = promisify(execFile)

const GITHUB_PROXIES = [
  'https://gh-proxy.org',
  'https://ghfast.top',
  'https://down.clashparty.org',
  'https://download.mihomo.party'
]

function cleanupTempFile(path: string): void {
  try {
    if (existsSync(path)) rmSync(path)
  } catch (error) {
    log.warn(`Failed to remove temporary file ${path}`, error)
  }
}

function buildDownloadUrls(githubUrl: string, proxyPref = ''): string[] {
  if (proxyPref === 'direct') return [githubUrl]
  if (proxyPref && proxyPref !== 'auto') return [`${proxyPref}/${githubUrl}`]
  return [...GITHUB_PROXIES.map((p) => `${p}/${githubUrl}`), githubUrl]
}

export interface GitHubTag {
  name: string
  zipball_url: string
  tarball_url: string
}

interface VersionCache {
  data: GitHubTag[]
  timestamp: number
}

const CACHE_EXPIRY = 5 * 60 * 1000

const GITHUB_API_CONFIG = {
  BASE_URL: 'https://api.github.com',
  API_VERSION: '2022-11-28',
  TAGS_PER_PAGE: 100
}

const PLATFORM_MAP: Record<string, string> = {
  'win32-x64': 'mihomo-windows-amd64-compatible',
  'win32-ia32': 'mihomo-windows-386',
  'win32-arm64': 'mihomo-windows-arm64',
  'darwin-x64': 'mihomo-darwin-amd64-compatible',
  'darwin-arm64': 'mihomo-darwin-arm64',
  'linux-x64': 'mihomo-linux-amd64-compatible',
  'linux-arm64': 'mihomo-linux-arm64'
}

// meow 的 release 资产名用 Rust target；Linux 用静态链接的 musl 版
const MEOW_PLATFORM_MAP: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-ia32': 'i686-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
}

const versionCache = new Map<string, VersionCache>()

/**
 * 获取 GitHub 仓库的标签列表（带缓存）
 * @param owner 仓库所有者
 * @param repo 仓库名称
 * @param forceRefresh 是否强制刷新缓存
 * @returns 标签列表
 */
export async function getGitHubTags(
  owner: string,
  repo: string,
  forceRefresh = false
): Promise<GitHubTag[]> {
  const cacheKey = `${owner}/${repo}`

  // 检查缓存
  if (!forceRefresh && versionCache.has(cacheKey)) {
    const cache = versionCache.get(cacheKey)
    if (cache && Date.now() - cache.timestamp < CACHE_EXPIRY) {
      log.debug(`Returning cached tags for ${owner}/${repo}`)
      return cache.data
    }
  }

  try {
    log.debug(`Fetching tags for ${owner}/${repo}`)
    const response = await chromeRequest.get<GitHubTag[]>(
      `${GITHUB_API_CONFIG.BASE_URL}/repos/${owner}/${repo}/tags?per_page=${GITHUB_API_CONFIG.TAGS_PER_PAGE}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_CONFIG.API_VERSION
        },
        responseType: 'json',
        timeout: 10000
      }
    )

    // 更新缓存
    versionCache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    })

    log.debug(`Successfully fetched ${response.data.length} tags for ${owner}/${repo}`)
    return response.data
  } catch (error) {
    log.error(`Failed to fetch tags for ${owner}/${repo}`, error)
    if (error instanceof Error) {
      throw new Error(`GitHub API error: ${error.message}`)
    }
    throw new Error('Failed to fetch version list')
  }
}

/**
 * 清除版本缓存
 * @param owner 仓库所有者
 * @param repo 仓库名称
 */
export function clearVersionCache(owner: string, repo: string): void {
  const cacheKey = `${owner}/${repo}`
  const hasCache = versionCache.has(cacheKey)
  versionCache.delete(cacheKey)
  log.debug(`Cache ${hasCache ? 'cleared' : 'not found'} for ${owner}/${repo}`)
}

/**
 * 下载 GitHub Release 资产
 * @param url 下载 URL
 * @param outputPath 输出路径
 */
export async function downloadGitHubAsset(url: string, outputPath: string): Promise<void> {
  const { githubProxy = '' } = await getAppConfig()
  const urls = buildDownloadUrls(url, githubProxy)
  let lastError: unknown
  for (const candidate of urls) {
    try {
      log.debug(`Downloading asset from ${candidate}`)
      const response = await chromeRequest.get(candidate, {
        responseType: 'arraybuffer',
        timeout: 30000
      })
      // chromeRequest 对任何状态码都 resolve，所以这里必须自己判断。否则镜像返回的
      // 404/502 错误页会被当成下载成功写进内核文件，而且直接 return、不再尝试后续镜像。
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      await writeFile(outputPath, Buffer.from(response.data as Buffer))
      log.debug(`Successfully downloaded asset to ${outputPath}`)
      return
    } catch (error) {
      log.warn(`Download failed from ${candidate}, trying next`, error)
      lastError = error
    }
  }
  log.error(`Failed to download asset from all sources`, lastError)
  throw lastError instanceof Error
    ? new Error(`Download error: ${lastError.message}`)
    : new Error('Failed to download core file')
}

/**
 * 安装特定版本的 mihomo 核心
 * @param version 版本号
 */
export async function installMihomoCore(version: string): Promise<void> {
  try {
    log.info(`Installing mihomo core version ${version}`)

    const plat = platform()
    const arch = process.arch

    // 映射平台和架构到 GitHub Release 文件名
    const key = `${plat}-${arch}`
    const name = PLATFORM_MAP[key]

    if (!name) {
      throw new Error(`Unsupported platform "${plat}-${arch}"`)
    }

    const isWin = plat === 'win32'
    const urlExt = isWin ? 'zip' : 'gz'
    const downloadURL = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${name}-${version}.${urlExt}`

    const coreDir = mihomoCoreDir()
    const tempZip = join(coreDir, `temp-core.${urlExt}`)
    const exeFile = `${name}${isWin ? '.exe' : ''}`
    const targetFile = `mihomo-specific${isWin ? '.exe' : ''}`
    const targetPath = join(coreDir, targetFile)

    // 如果目标文件已存在，先停止核心
    if (existsSync(targetPath)) {
      log.debug('Stopping core before extracting new core file')
      // 先停止核心
      await stopCore(true)
    }

    // 下载文件
    await downloadGitHubAsset(downloadURL, tempZip)

    // 解压文件
    if (urlExt === 'zip') {
      log.debug(`Extracting ZIP file ${tempZip}`)
      const zip = new AdmZip(tempZip)
      const entries = zip.getEntries()
      const entry = entries.find((e) => e.entryName.includes(exeFile))

      if (entry) {
        zip.extractEntryTo(entry, coreDir, false, true, false, targetFile)
        log.debug(`Successfully extracted ${exeFile} to ${targetPath}`)
      } else {
        throw new Error(`Executable file not found in zip: ${exeFile}`)
      }
    } else {
      // 处理.gz 文件
      // 先解压到临时文件再原子替换：直接往 targetPath 写的话，解压中途失败
      // 会把原本可用的内核截断成半个文件，用户连回退都没得回退。
      log.debug(`Extracting GZ file ${tempZip}`)
      const stagingPath = `${targetPath}.download`
      const readStream = createReadStream(tempZip)
      const writeStream = createWriteStream(stagingPath)

      try {
        await new Promise<void>((resolve, reject) => {
          const gunzip = createGunzip()
          const onError = (error: Error): void => {
            log.error('Gzip decompression failed', error)
            readStream.destroy()
            gunzip.destroy()
            writeStream.destroy()
            reject(new Error(`Gzip decompression failed: ${error.message}`))
          }

          readStream.on('error', onError)
          gunzip.on('error', onError)
          writeStream.on('error', onError)

          readStream
            .pipe(gunzip)
            .pipe(writeStream)
            .on('finish', () => {
              log.debug('Gunzip finished')
              resolve()
            })
        })

        // 用 chmodSync 而不是拼 shell 命令：macOS 的数据目录是
        // ~/Library/Application Support/... ，路径里带空格，未加引号的
        // `chmod 755 <path>` 必然失败，而失败只被 warn 掉，用户拿到的是
        // 一个没有执行权限的内核，表现为「装好了但起不来」。
        chmodSync(stagingPath, 0o755)
        log.debug('Chmod binary finished')
        renameSync(stagingPath, targetPath)
      } catch (error) {
        try {
          if (existsSync(stagingPath)) rmSync(stagingPath)
        } catch {
          // ignore
        }
        throw error
      }
    }

    // 清理临时文件
    log.debug(`Cleaning up temporary file ${tempZip}`)
    cleanupTempFile(tempZip)

    log.info(`Successfully installed mihomo core version ${version}`)
  } catch (error) {
    // 解压失败时下载的压缩包会一直留在内核目录里，每次重试再落一份
    cleanupTempFile(join(mihomoCoreDir(), `temp-core.zip`))
    cleanupTempFile(join(mihomoCoreDir(), `temp-core.gz`))
    log.error('Failed to install mihomo core', error)
    throw new Error(
      `Failed to install core: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// `meow -v` 输出形如 "Meow Meta 0.26.1"，读不到时返回空串
async function installedMeowVersion(corePath: string): Promise<string> {
  try {
    const { stdout } = await execFilePromise(corePath, ['-v'], { timeout: 5000 })
    const version = stdout.trim().split(/\s+/).pop()
    return version ? `v${version}` : ''
  } catch {
    return ''
  }
}

/**
 * 把 meow 内核升级到最新正式版。meow 没有 mihomo 的 /upgrade 接口，
 * 由应用下载 release 包、校验 sha256 后替换内核文件并重启内核
 */
export async function upgradeMeowCore(): Promise<void> {
  const plat = platform()
  const target = MEOW_PLATFORM_MAP[`${plat}-${process.arch}`]
  if (!target) {
    throw new Error(`Unsupported platform "${plat}-${process.arch}"`)
  }

  const response = await chromeRequest.get<{ tag_name?: string }>(
    `${GITHUB_API_CONFIG.BASE_URL}/repos/meow-rs/meow-rs/releases/latest`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_CONFIG.API_VERSION
      },
      responseType: 'json',
      timeout: 10000
    }
  )
  const version = response.data?.tag_name
  if (response.status !== 200 || !version) {
    throw new Error(`GitHub API error: HTTP ${response.status} ${response.statusText}`)
  }
  // tag 会拼进下载地址和本地文件名，只接受 v 加数字开头、不含路径分隔符的形式
  if (!/^v\d[\w.-]*$/.test(version)) {
    throw new Error(`Unexpected meow release tag: ${version}`)
  }

  const corePath = mihomoCorePath('meow')
  // 和 mihomo 的 /upgrade 报同样的错，界面据此提示已是最新版本
  if ((await installedMeowVersion(corePath)) === version) {
    throw new Error('already using latest version')
  }
  log.info(`Upgrading meow core to ${version}`)

  const isWin = plat === 'win32'
  const asset = `meow-${version}-${target}.${isWin ? 'zip' : 'tar.gz'}`
  const downloadURL = `https://github.com/meow-rs/meow-rs/releases/download/${version}/${asset}`
  const exeFile = basename(corePath)
  // 放在内核目录里：目录不可写时下载前就失败，替换也是同一文件系统内的原子 rename
  const stagingDir = join(mihomoCoreDir(), 'meow-upgrade')
  const archivePath = join(stagingDir, asset)
  const checksumPath = `${archivePath}.sha256`
  const stagedExe = join(stagingDir, exeFile)

  try {
    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir)
    await downloadGitHubAsset(downloadURL, archivePath)
    await downloadGitHubAsset(`${downloadURL}.sha256`, checksumPath)
    // 校验文件内容形如 "<sha256>  <文件名>"
    const expected = (await readFile(checksumPath, 'utf8')).trim().split(/\s+/)[0].toLowerCase()
    const actual = createHash('sha256')
      .update(await readFile(archivePath))
      .digest('hex')
    if (expected !== actual) {
      throw new Error(`Checksum mismatch for ${asset}`)
    }

    // 压缩包里是 meow-<版本>-<target>/ 目录，只取出其中的可执行文件
    if (isWin) {
      const zip = new AdmZip(archivePath)
      const entry = zip.getEntries().find((e) => e.entryName.endsWith(`/${exeFile}`))
      if (!entry) throw new Error(`Executable file not found in zip: ${exeFile}`)
      zip.extractEntryTo(entry, stagingDir, false, true)
    } else {
      await extract({
        file: archivePath,
        cwd: stagingDir,
        strip: 1,
        filter: (entryPath) => entryPath.endsWith(`/${exeFile}`)
      })
    }
    if (!existsSync(stagedExe)) {
      throw new Error(`Executable file not found in archive: ${exeFile}`)
    }
    chmodSync(stagedExe, 0o755)

    // Windows 上运行中的内核文件不能被覆盖，先停内核再替换
    await stopCore(true)
    try {
      renameSync(stagedExe, corePath)
    } catch (error) {
      // 替换失败时把旧版本内核重新拉起来
      await restartCore().catch((e) => log.error('Failed to restart core', e))
      throw error
    }
    log.info(`Successfully upgraded meow core to ${version}`)
  } catch (error) {
    log.error('Failed to upgrade meow core', error)
    throw new Error(
      `Failed to upgrade core: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  await restartCore()
}
