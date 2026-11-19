// Zhipu BigModel GLM Coding Plan quota (5-hour / weekly windows).
//
// Queries the plan's monitoring endpoint with the API key DSH already stores
// for the `zai-coding-cn` provider route. The wire format follows ZCode's
// documented integration: `GET <host>/api/monitor/usage/quota/limit` with the
// raw API key in the `authorization` header (no Bearer prefix).
// `percentage` on each limit is the USED percent; remaining = 100 - used.

export const QUOTA_PATH = '/api/monitor/usage/quota/limit'
export const DEFAULT_QUOTA_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'

const errors = {
  NOT_CONFIGURED: '未找到智谱 Coding Plan 的 API Key，请先在 DSH 模型设置里配置智谱。',
  AUTH: '智谱额度凭据无效或已过期，请检查 DSH 的模型设置。',
  UNAVAILABLE: '智谱额度服务暂时不可用，稍后可重新刷新。',
  INVALID_RESPONSE: '智谱额度服务返回了无法识别的数据。',
}

function quotaError(code) {
  return Object.assign(new Error(errors[code]), { code })
}

// Window unit codes used by the monitor API (per ZCode / community tooling):
// 3 = hours, 4 = days, 5 = months, 6 = weeks. Only the token windows the
// Coding Plan footer needs are classified here; anything else is ignored.
function windowSlot(limit) {
  if (limit?.type !== 'TOKENS_LIMIT') return null
  if (limit.unit === 3 && Number.isFinite(limit.number) && limit.number >= 1 && limit.number <= 48) return 'fiveHour'
  if (limit.unit === 6 && Number.isFinite(limit.number) && limit.number >= 1 && limit.number <= 8) return 'weekly'
  return null
}

function windowRemaining(limit) {
  if (!Number.isFinite(limit.percentage) || limit.percentage < 0 || limit.percentage > 100) return null
  const used = Math.round(limit.percentage)
  return { usedPercent: used, remainingPercent: 100 - used }
}

function windowReset(limit) {
  if (!Number.isFinite(limit.nextResetTime) || limit.nextResetTime <= 0) return null
  return limit.nextResetTime
}

export function parseQuotaBody(body) {
  const data = body?.data ?? body
  if (data === null || typeof data !== 'object' || !Array.isArray(data.limits) || data.limits.length === 0
    || data.limits.length > 16) throw quotaError('INVALID_RESPONSE')
  const slots = {}
  for (const limit of data.limits) {
    const slot = windowSlot(limit)
    if (!slot || slots[slot]) continue
    const remaining = windowRemaining(limit)
    if (!remaining) continue
    slots[slot] = { ...remaining, resetAt: windowReset(limit) }
  }
  if (!slots.fiveHour && !slots.weekly) throw quotaError('INVALID_RESPONSE')
  const level = typeof data.level === 'string' && data.level.length <= 24 ? data.level : null
  return { level, fiveHour: slots.fiveHour ?? null, weekly: slots.weekly ?? null }
}

function serviceOf(ctx, name) {
  try { return ctx.get?.(name) ?? ctx[name] } catch { return undefined }
}

function zhipuDirectoryEntry(ctx) {
  const rows = serviceOf(ctx, 'llm')?.listConfigurableProviders?.() ?? []
  return rows.find((row) => row?.provider === 'zai-coding-cn') ?? rows.find((row) => row?.provider === 'zai')
}

export function zhipuProviderNamespace(ctx) {
  return zhipuDirectoryEntry(ctx)?.settingsNs
}

// The configured apiKeyEnv/baseURL live in the pi-ai settings document under
// `providers.<id>`; the directory entry carries the catalog defaults. Both are
// best-effort: a missing shape falls back to the standard env names.
function resolveRoute(ctx, environment) {
  const entry = zhipuDirectoryEntry(ctx)
  let providerConfig = {}
  try {
    const rows = ctx.settings?.describe?.() ?? []
    const row = rows.find((form) => entry?.settingsNs && form.ns === entry.settingsNs)
    const configured = entry ? row?.value?.providers?.[entry.provider] : undefined
    if (configured && typeof configured === 'object') providerConfig = configured
  } catch {}
  const nativeEnv = Array.isArray(entry?.nativeAuth?.env) ? entry.nativeAuth.env : []
  const refs = [
    typeof providerConfig.apiKeyEnv === 'string' ? providerConfig.apiKeyEnv : null,
    ...nativeEnv,
    'ZAI_CODING_CN_API_KEY',
    'ZAI_API_KEY',
    'ZHIPU_API_KEY',
  ].filter((ref) => typeof ref === 'string' && /^[A-Z0-9_]+$/.test(ref) && ref.length <= 64)
  const baseURL = typeof providerConfig.baseURL === 'string' && providerConfig.baseURL.trim()
    ? providerConfig.baseURL
    : (typeof entry?.defaultBaseURL === 'string' && entry.defaultBaseURL.trim()) || DEFAULT_QUOTA_BASE_URL
  const launch = serviceOf(ctx, 'launchEnvironment')
  const envValue = (name) => launch ? launch.get(name)?.value : environment[name]
  return { refs: [...new Set(refs)], baseURL, envValue }
}

async function resolveKey(ctx, refs, envValue) {
  const credentials = serviceOf(ctx, 'credentials')
  for (const ref of refs) {
    try {
      const credential = credentials ? await credentials.resolve(ref) : { value: envValue(ref) }
      if (typeof credential?.value === 'string' && credential.value.trim()) return credential.value.trim()
    } catch {}
  }
  return null
}

async function responseText(response) {
  if (!response.body?.getReader) return response.text()
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32768) {
        await reader.cancel().catch(() => {})
        throw quotaError('INVALID_RESPONSE')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

export function createZhipuQuotaQuery(ctx, { fetchImpl = fetch, environment = process.env } = {}) {
  return async (_source = 'auto', signal) => {
    const route = resolveRoute(ctx, environment)
    const key = await resolveKey(ctx, route.refs, route.envValue)
    if (!key) throw quotaError('NOT_CONFIGURED')
    const base = new URL(route.baseURL)
    if (base.username || base.password || (base.protocol !== 'https:'
      && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
      throw quotaError('UNAVAILABLE')
    }
    const url = new URL(base.origin + QUOTA_PATH)
    const response = await fetchImpl(url, {
      // The monitor endpoint rejects Bearer-prefixed keys; send it raw.
      headers: { authorization: key },
      signal, redirect: 'error',
    })
    if (!response.ok) throw quotaError([401, 403].includes(response.status) ? 'AUTH' : 'UNAVAILABLE')
    const text = await responseText(response)
    if (text.length > 32768) throw quotaError('INVALID_RESPONSE')
    let body
    try { body = JSON.parse(text) } catch { throw quotaError('INVALID_RESPONSE') }
    return parseQuotaBody(body)
  }
}

function formatReset(ms, now = Date.now()) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  if (sameDay) return time
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + time
}

function windowLine(label, window, now) {
  const reset = window.resetAt ? `（${formatReset(window.resetAt, now)}重置）` : ''
  return `${label}剩余 ${window.remainingPercent}%${reset}`
}

// Rotation lines for the bubble footer. Silent while loading or unconfigured;
// failures stay visible so the user can tell the quota stopped refreshing.
export function zhipuQuotaLines(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.status === 'disabled' || snapshot.status === 'loading'
    || snapshot.status === 'not-configured') return []
  if (snapshot.status !== 'ready') return [{ key: 'zhipu-error', text: '智谱额度暂不可用' }]
  const lines = []
  if (snapshot.fiveHour) lines.push({ key: 'zhipu-5h', text: windowLine('智谱5小时额度', snapshot.fiveHour, now) })
  if (snapshot.weekly) lines.push({ key: 'zhipu-weekly', text: windowLine('智谱周额度', snapshot.weekly, now) })
  return lines
}

export function createZhipuQuotaMonitor({ query, onChange = () => {}, now = Date.now, intervalMs = 60000, timeoutMs = 10000 }) {
  let snapshot = { status: 'disabled', level: null, fiveHour: null, weekly: null, checkedAt: null, error: null }
  let enabled = false
  let stopped = false
  let generation = 0
  let lastAttempt = -Infinity
  let timer
  let pending
  let controller
  const publish = (next) => {
    snapshot = next
    onChange(snapshot)
  }
  const refresh = async (force = false) => {
    if (stopped || !enabled) return snapshot
    if (pending) return pending
    if (now() - lastAttempt < (force ? 5000 : intervalMs)) return snapshot
    const started = generation
    lastAttempt = now()
    controller = new AbortController()
    const signal = controller.signal
    let timeout
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller?.abort(); reject(quotaError('UNAVAILABLE')) }, timeoutMs)
      timeout.unref?.()
    })
    pending = Promise.resolve().then(async () => {
      try {
        if (started !== generation || stopped) return snapshot
        const result = await Promise.race([query('auto', signal), expired])
        if (started === generation && !stopped) {
          publish({ ...result, checkedAt: now(), status: 'ready', error: null })
        }
      } catch (error) {
        if (started === generation && !stopped) {
          const code = Object.hasOwn(errors, error?.code) ? error.code : 'UNAVAILABLE'
          const retained = ['NOT_CONFIGURED', 'AUTH'].includes(code)
            ? { fiveHour: null, weekly: null, level: null, checkedAt: null } : {}
          publish({ ...snapshot, ...retained, status: code === 'NOT_CONFIGURED' ? 'not-configured' : 'error', error: errors[code] })
        }
      } finally {
        clearTimeout(timeout)
        pending = undefined
      }
      return snapshot
    })
    return pending
  }
  const poll = () => {
    clearTimeout(timer)
    if (!enabled || stopped) return
    timer = setTimeout(() => { void refresh().finally(poll) }, intervalMs)
    timer.unref?.()
  }
  return {
    get: () => snapshot,
    refresh,
    configure(nextEnabled, invalidate = false) {
      if (stopped || (!invalidate && enabled === nextEnabled)) return
      enabled = nextEnabled
      generation += 1
      controller?.abort()
      lastAttempt = -Infinity
      clearTimeout(timer)
      const next = { status: enabled ? 'loading' : 'disabled', level: null, fiveHour: null, weekly: null, checkedAt: null, error: null }
      if (enabled || snapshot.status !== 'disabled') publish(next)
      void Promise.resolve(pending).then(() => refresh()).finally(poll)
    },
    stop() {
      stopped = true
      generation += 1
      clearTimeout(timer)
      controller?.abort()
    },
  }
}
