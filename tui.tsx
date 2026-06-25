/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message, Part, Provider, TextPart } from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { readFileSync, existsSync } from "fs"

// --- API response shapes ----------------------------------------------------

interface TokenLimit {
  type: "TOKENS_LIMIT"
  // unit encodes the TIME window, not tokens: 3 = 5h session, 6 = 7d weekly.
  unit: number
  number: number
  percentage: number
  nextResetTime: number
  // Real absolute token counts. Present on Max/Pro plans, OMITTED on Lite.
  usage?: number        // total token limit for this window
  currentValue?: number // tokens consumed
  remaining?: number    // tokens remaining
}

interface UsageDetail {
  modelCode: string
  usage: number
}

interface TimeLimit {
  type: "TIME_LIMIT"
  unit: number
  number: number
  usage: number
  currentValue: number
  remaining: number
  percentage: number
  nextResetTime: number
  usageDetails: UsageDetail[]
}

interface QuotaApiResponse {
  code: number
  msg?: string
  data: {
    limits: (TokenLimit | TimeLimit)[]
    level: string
  }
}

// Optional absolute token counts, present ONLY when the API returns them
// (Max/Pro plans). Lite plans omit usage/currentValue, so absolute is null.
interface AbsoluteQuota {
  usedPct: number
  remainingPct: number
  nextResetEpoch: number
  used: number      // tokens/calls consumed (real API value)
  total: number     // tokens/calls allowed   (real API value)
}

interface QuotaData {
  level: string
  tokenUsedPct: number
  tokenRemainingPct: number
  tokenNextResetEpoch: number
  tokenAbsolute: AbsoluteQuota | null
  weeklyLimit: AbsoluteQuota | null
  timeLimit: {
    usedPct: number
    remainingPct: number
    nextResetEpoch: number
    total: number
    used: number
    usageDetails: UsageDetail[]
  } | null
}

// --- Constants --------------------------------------------------------------

// unit encodes the TIME window, not tokens: 3 = 5h session, 6 = 7d weekly.
const TIME_UNIT = {
  SESSION_5H: 3,
  WEEKLY_7D: 6,
} as const

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
const ZAI_PROVIDER_ID = "zai-coding-plan"
const KV_BASELINE_KEY = "glm_reset_baseline_sgt"
const KV_CYCLE_MS_KEY = "glm_reset_cycle_ms"
const FALLBACK_BASELINE_SGT = "2026-05-28 00:45:44"
const FALLBACK_CYCLE_MS = 5 * 3600 * 1000
const BAR_WIDTH = 20
const API_POLL_MS = 60_000
const EXHAUSTED_POLL_MS = 300_000
const TICK_MS = 1000
const RESET_PARSE_RE = /Your limit will reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
const RETRY_AFTER_RE = /reset after (\d+h)?(\d+m)?(\d+s)?/i
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

const ACCOUNT_JSON_PATHS = [
  `${process.env.HOME || ""}/.config/opencode/account.json`,
  `${process.env.HOME || ""}/.local/share/opencode/account.json`,
]

// --- Pure helpers -----------------------------------------------------------

function safeNumber(val: unknown, fallback: number): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

function clampPct(pct: number): number {
  return Math.min(100, Math.max(0, pct))
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "Resetting..."
  const totalSec = Math.floor(ms / 1000)
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// Compact absolute-count formatter: 50 -> "50", 5000 -> "5.0K", 5_000_000 -> "5.0M"
function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function buildBar(percent: number): { filled: string; empty: string } {
  const clamped = clampPct(percent)
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH)))
  return {
    filled: "█".repeat(filled),
    empty: "░".repeat(BAR_WIDTH - filled),
  }
}

function parseSgt(dateStr: string): number | null {
  if (!dateStr || typeof dateStr !== "string") return null
  const parts = dateStr.split(" ")
  if (parts.length !== 2) return null
  const [ymd, hms] = parts
  const dateParts = ymd.split("-").map(Number)
  const timeParts = hms.split(":").map(Number)
  if (dateParts.length !== 3 || timeParts.length !== 3) return null
  const [y, m, d] = dateParts
  const [hh, mm, ss] = timeParts
  if ([y, m, d, hh, mm, ss].some(v => !Number.isFinite(v))) return null
  return Date.UTC(y, m - 1, d, hh, mm, ss) - SGT_OFFSET_MS
}

function nextResetEpoch(baselineEpoch: number, cycleMs: number, now: number): number {
  const elapsed = now - baselineEpoch
  if (elapsed < 0) return baselineEpoch
  const cyclesPast = Math.floor(elapsed / cycleMs)
  return baselineEpoch + (cyclesPast + 1) * cycleMs
}

function isPeakHour(epochMs: number): boolean {
  // Peak hours are 14:00 - 18:00 SGT (UTC+8) daily
  const dateInSgt = new Date(epochMs + SGT_OFFSET_MS)
  const utcHour = dateInSgt.getUTCHours()
  return utcHour >= 14 && utcHour < 18
}

// Pull a regex match out of session content. Message text lives in the message's
// *parts* (api.state.part(id)), not on the Message object itself, so we walk
// messages newest-first and inspect each text part.
function scanMessageParts(
  messages: readonly Message[],
  partReader: (messageID: string) => readonly Part[],
  regex: RegExp,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const parts = partReader(msg.id)
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p && p.type === "text") {
        const match = (p as TextPart).text.match(regex)
        if (match) return match[0]
      }
    }
  }
  return null
}

// --- API key discovery ------------------------------------------------------

interface AccountFile {
  version: number
  active?: Record<string, string>
  accounts?: Record<string, AccountEntry>
}

interface AccountEntry {
  serviceID: string
  credential?: { key: string }
}

function findKeyFromFiles(): string | null {
  for (const filePath of ACCOUNT_JSON_PATHS) {
    try {
      if (!existsSync(filePath)) continue
      const raw = readFileSync(filePath, "utf-8")
      const data = JSON.parse(raw)
      const key = keyFromAccountFile(data) ?? keyFromAccountArray(data)
      if (key) return key
    } catch (err) {
      console.error("[glm-reset] Failed to read account file:", err)
    }
  }
  return null
}

function keyFromAccountFile(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const file = data as AccountFile
  if (file.version !== 2 || !file.accounts) return null
  const activeId = file.active?.[ZAI_PROVIDER_ID]
  if (activeId && file.accounts[activeId]?.credential?.key) {
    return file.accounts[activeId].credential.key
  }
  for (const entry of Object.values(file.accounts)) {
    if (entry?.serviceID === ZAI_PROVIDER_ID && entry.credential?.key) {
      return entry.credential.key
    }
  }
  return null
}

function keyFromAccountArray(data: unknown): string | null {
  if (!Array.isArray(data)) return null
  const found = data.find(
    (x): x is AccountEntry =>
      typeof x === "object" && x !== null && (x as AccountEntry).serviceID === ZAI_PROVIDER_ID,
  )
  return found?.credential?.key ?? null
}

function findKeyFromProviders(providers: readonly Provider[]): string | null {
  const zai = providers.find(p => p.id === ZAI_PROVIDER_ID)
  return zai?.key ?? null
}

// --- Quota fetch + normalization -------------------------------------------

async function fetchQuota(apiKey: string): Promise<QuotaData | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(ZAI_QUOTA_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!res.ok) {
      console.error(`[glm-reset] API returned ${res.status}`)
      return null
    }
    const payload = await res.json() as QuotaApiResponse
    if (payload?.code !== 200) {
      console.error(`[glm-reset] API code ${payload?.code}: ${payload?.msg || "unknown"}`)
      return null
    }
    const data = payload.data
    if (!data || !Array.isArray(data.limits)) {
      console.error("[glm-reset] API response missing data.limits")
      return null
    }
    const rawLevel = String(data.level || "Unknown")
    const level = rawLevel.charAt(0).toUpperCase() + rawLevel.slice(1).toLowerCase()
    const tokensLimits = data.limits.filter((l): l is TokenLimit => l.type === "TOKENS_LIMIT")
    const tokenLimit = tokensLimits.find(l => l.unit === TIME_UNIT.SESSION_5H) || tokensLimits[0]
    const weeklyLimit = tokensLimits.find(l => l.unit === TIME_UNIT.WEEKLY_7D && l !== tokenLimit)
    const timeLimit = data.limits.find((l): l is TimeLimit => l.type === "TIME_LIMIT")

    // Build an AbsoluteQuota ONLY when the API returns real counts (usage/currentValue).
    // Lite plans omit these, so absolute is null and the UI shows percentage-only.
    function absoluteFromToken(l: TokenLimit, usedPct: number): AbsoluteQuota | null {
      const total = safeNumber(l.usage, 0)
      if (!l.usage || total <= 0) return null
      const used = safeNumber(l.currentValue, Math.round(total * usedPct / 100))
      return {
        usedPct,
        remainingPct: clampPct(100 - usedPct),
        nextResetEpoch: safeNumber(l.nextResetTime, 0),
        total,
        used,
      }
    }

    let tokenUsedPct = 0
    let tokenNextResetEpoch = 0
    let tokenAbsolute: AbsoluteQuota | null = null
    if (tokenLimit) {
      tokenUsedPct = clampPct(safeNumber(tokenLimit.percentage, 0))
      tokenNextResetEpoch = safeNumber(tokenLimit.nextResetTime, 0)
      tokenAbsolute = absoluteFromToken(tokenLimit, tokenUsedPct)
    }
    let weeklyQuota: AbsoluteQuota | null = null
    if (weeklyLimit) {
      weeklyQuota = absoluteFromToken(weeklyLimit, clampPct(safeNumber(weeklyLimit.percentage, 0)))
    }
    let timeQuota: QuotaData["timeLimit"] = null
    if (timeLimit) {
      const timeUsedPct = clampPct(safeNumber(timeLimit.percentage, 0))
      timeQuota = {
        usedPct: timeUsedPct,
        remainingPct: clampPct(100 - timeUsedPct),
        nextResetEpoch: safeNumber(timeLimit.nextResetTime, 0),
        total: safeNumber(timeLimit.usage, 0),
        used: safeNumber(timeLimit.currentValue, 0),
        usageDetails: Array.isArray(timeLimit.usageDetails) ? timeLimit.usageDetails : [],
      }
    }
    return {
      level,
      tokenUsedPct,
      tokenRemainingPct: clampPct(100 - tokenUsedPct),
      tokenNextResetEpoch,
      tokenAbsolute,
      weeklyLimit: weeklyQuota,
      timeLimit: timeQuota,
    }
  } catch (err) {
    console.error("[glm-reset] fetchQuota error:", err)
    return null
  }
}

// --- Pure display computation (module scope — no component closure) ---------

interface DisplayState {
  source: "api" | "retry-after" | "heuristic"
  level: string
  isPeak: boolean
  token: {
    usedPct: number
    remainingPct: number
    nextResetEpoch: number
    absolute: AbsoluteQuota | null
    countdown: string
  }
  weekly: {
    usedPct: number
    remainingPct: number
    nextResetEpoch: number
    absolute: AbsoluteQuota | null
    countdown: string
  } | null
  time: {
    usedPct: number
    remainingPct: number
    nextResetEpoch: number
    total: number
    used: number
    countdown: string
    usageDetails: UsageDetail[]
  } | null
}

function computeDisplay(
  t: number,
  apiQuota: QuotaData | null,
  ra: number | null,
  bs: string,
  cy: number,
): DisplayState {
  const isPeak = isPeakHour(t)
  const hasTokenQuota = apiQuota && apiQuota.tokenNextResetEpoch > 0
  if (hasTokenQuota) {
    const tokenRemaining = apiQuota.tokenNextResetEpoch - t
    return {
      source: "api",
      level: apiQuota.level,
      isPeak,
      token: {
        usedPct: apiQuota.tokenUsedPct,
        remainingPct: apiQuota.tokenRemainingPct,
        nextResetEpoch: apiQuota.tokenNextResetEpoch,
        // absolute is null on Lite (API omits usage); real counts on Max/Pro
        absolute: apiQuota.tokenAbsolute,
        countdown: formatRemaining(tokenRemaining),
      },
      weekly: apiQuota.weeklyLimit
        ? {
          usedPct: apiQuota.weeklyLimit.usedPct,
          remainingPct: apiQuota.weeklyLimit.remainingPct,
          nextResetEpoch: apiQuota.weeklyLimit.nextResetEpoch,
          absolute: apiQuota.weeklyLimit,
          countdown: formatRemaining(apiQuota.weeklyLimit.nextResetEpoch - t),
        }
        : null,
      time: apiQuota.timeLimit
        ? {
          usedPct: apiQuota.timeLimit.usedPct,
          remainingPct: apiQuota.timeLimit.remainingPct,
          nextResetEpoch: apiQuota.timeLimit.nextResetEpoch,
          total: apiQuota.timeLimit.total,
          used: apiQuota.timeLimit.used,
          countdown: formatRemaining(apiQuota.timeLimit.nextResetEpoch - t),
          usageDetails: apiQuota.timeLimit.usageDetails,
        }
        : null,
    }
  }
  if (ra && ra > t) {
    return {
      source: "retry-after",
      level: "Rate limited",
      isPeak,
      token: {
        usedPct: 0,
        remainingPct: 0,
        nextResetEpoch: ra,
        absolute: null,
        countdown: formatRemaining(ra - t),
      },
      weekly: null,
      time: null,
    }
  }
  const baseEpoch = parseSgt(bs)
  const nextEpoch = baseEpoch !== null ? nextResetEpoch(baseEpoch, cy, t) : t + cy
  const remaining = nextEpoch - t
  return {
    source: "heuristic",
    level: "",
    isPeak,
    token: {
      usedPct: 0,
      remainingPct: 0,
      nextResetEpoch: nextEpoch,
      absolute: null,
      countdown: formatRemaining(remaining),
    },
    weekly: null,
    time: null,
  }
}

// --- Component --------------------------------------------------------------

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current

  // API key: file discovery first, then the typed provider list.
  const [apiKey, setApiKey] = createSignal<string | null>(findKeyFromFiles())
  createEffect(() => {
    const key = findKeyFromProviders(props.api.state.provider)
    if (key) setApiKey(key)
  })

  const [quotaTrigger, setQuotaTrigger] = createSignal(0)
  const [quotaData, setQuotaData] = createSignal<QuotaData | null>(null)
  const [hasFetched, setHasFetched] = createSignal(false)

  createEffect(() => {
    const key = apiKey()
    // quotaTrigger() is read here to subscribe the effect to re-fetches.
    quotaTrigger()
    if (!key) {
      setHasFetched(true)
      return
    }
    fetchQuota(key).then(data => {
      setQuotaData(data)
      setHasFetched(true)
    }).catch(() => {
      setQuotaData(null)
      setHasFetched(true)
    })
  })

  // Re-fetch every 60s (or 5min when the 5H token quota is exhausted).
  createEffect(() => {
    const key = apiKey()
    if (!key) return
    const data = quotaData()
    const isExhausted = data ? data.tokenRemainingPct <= 0 : false
    const pollMs = isExhausted ? EXHAUSTED_POLL_MS : API_POLL_MS
    const id = setInterval(() => setQuotaTrigger((x: number) => x + 1), pollMs)
    onCleanup(() => clearInterval(id))
  })

  const [baselineSgt, setBaselineSgt] = createSignal<string>(FALLBACK_BASELINE_SGT)
  const [cycleMs, setCycleMs] = createSignal<number>(FALLBACK_CYCLE_MS)
  createEffect(() => {
    try {
      const storedBase = props.api.kv.get<string>(KV_BASELINE_KEY)
      if (storedBase) setBaselineSgt(storedBase)
      const storedCycle = props.api.kv.get<number>(KV_CYCLE_MS_KEY)
      if (storedCycle) setCycleMs(Number(storedCycle) || FALLBACK_CYCLE_MS)
    } catch { /* KV not ready */ }
  })

  const messages = createMemo(() => {
    try {
      return props.api.state.session.messages(props.sessionID)
    } catch {
      return [] as Message[]
    }
  })

  const partReader = (messageID: string): readonly Part[] => {
    try {
      return props.api.state.part(messageID)
    } catch {
      return []
    }
  }

  createEffect(() => {
    const found = scanMessageParts(messages(), partReader, RESET_PARSE_RE)
    if (found) {
      const match = found.match(RESET_PARSE_RE)
      const resetTime = match ? match[1] : null
      if (resetTime && resetTime !== baselineSgt()) {
        setBaselineSgt(resetTime)
        try { props.api.kv.set(KV_BASELINE_KEY, resetTime) } catch { /* best-effort */ }
      }
    }
  })

  const [retryAfterEpoch, setRetryAfterEpoch] = createSignal<number | null>(null)
  createEffect(() => {
    const found = scanMessageParts(messages(), partReader, RETRY_AFTER_RE)
    if (!found) {
      setRetryAfterEpoch(null)
      return
    }
    const match = found.match(RETRY_AFTER_RE)
    if (!match) {
      setRetryAfterEpoch(null)
      return
    }
    const h = match[1] ? parseInt(match[1]) : 0
    const m = match[2] ? parseInt(match[2]) : 0
    const s = match[3] ? parseInt(match[3]) : 0
    const totalSec = h * 3600 + m * 60 + s
    setRetryAfterEpoch(totalSec > 0 ? Date.now() + totalSec * 1000 : null)
  })

  const [now, setNow] = createSignal(Date.now())
  const tickId = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(tickId))

  const [displayState, setDisplayState] = createSignal(computeDisplay(
    Date.now(), null, null, FALLBACK_BASELINE_SGT, FALLBACK_CYCLE_MS,
  ))

  createEffect(() => {
    setDisplayState(computeDisplay(
      now(), quotaData(), retryAfterEpoch(), baselineSgt(), cycleMs(),
    ))
  })

  const [open, setOpen] = createSignal(false)

  return (
    <box flexDirection="column">
      {(() => {
        if (!hasFetched()) {
          return (
            <box flexDirection="column">
              <text fg={theme().textMuted}>Loading GLM Reset...</text>
            </box>
          )
        }

        const s = displayState()

        if (s.source === "heuristic") {
          return (
            <box flexDirection="column">
              <text fg={theme().text} attributes={TextAttributes.BOLD}>GLM Reset (est)</text>
              <text fg={theme().text}>  Reset: {s.token.countdown}</text>
            </box>
          )
        }

        const canExpand = s.source === "api"
        const rem = s.token.remainingPct
        const apiColor = rem <= 10 ? theme().error : rem <= 30 ? theme().warning : theme().success
        const apiBar = buildBar(rem)

        return (
          <box flexDirection="column">
            {/* Header row */}
            <box flexDirection="row" gap={1} onMouseDown={() => canExpand && setOpen((x: boolean) => !x)}>
              <Show when={canExpand}>
                <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
              </Show>
              <text fg={theme().text} attributes={TextAttributes.BOLD}>
                GLM Reset{s.level ? `: ${s.level}` : ""}
              </text>
              <Show when={s.source === "api"}>
                <text fg={s.isPeak ? theme().warning : theme().success}>
                  {s.isPeak ? " ⚡Peak (3x)" : " 🌙Off-Peak"}
                </text>
              </Show>
            </box>

            {/* 1x space below Title */}
            <box height={1} />

            {/* 5H row - always visible */}
            <box flexDirection="row" gap={0}>
              <text fg={apiColor}>{"5H\u00A0\u00A0\u00A0\u00A0"}</text>
              <text fg={apiColor}>{apiBar.filled}</text>
              <text fg={theme().textMuted}>{apiBar.empty}</text>
              <text fg={apiColor}>{" "}{rem.toFixed(0)}%</text>
            </box>

            {/* Expanded section */}
            <Show when={open()}>
              <box flexDirection="column">
                {/* 5H usage detail + reset countdown (absolute only when API provides it) */}
                <Show when={s.token.absolute} fallback={<text fg={theme().textMuted}>  Reset in {s.token.countdown}</text>}>
                  {(abs) => (
                    <text fg={theme().textMuted}>  {formatCount(abs().used)} / {formatCount(abs().total)} tokens · Reset in {s.token.countdown}</text>
                  )}
                </Show>

                {/* Weekly (7D) limit details */}
                {(() => {
                  if (s.weekly) {
                    const w = s.weekly
                    const wRem = w.remainingPct
                    const wColor = wRem <= 10 ? theme().error : wRem <= 30 ? theme().warning : theme().success
                    const wBar = buildBar(wRem)
                    return (
                      <box flexDirection="column">
                        <box flexDirection="row" gap={0}>
                          <text fg={wColor}>{"7D\u00A0\u00A0\u00A0\u00A0"}</text>
                          <text fg={wColor}>{wBar.filled}</text>
                          <text fg={theme().textMuted}>{wBar.empty}</text>
                          <text fg={wColor}>{" "}{wRem.toFixed(0)}%</text>
                        </box>
                        <Show when={w.absolute} fallback={<text fg={theme().textMuted}>  Reset in {w.countdown}</text>}>
                          {(wAbs) => (
                            <text fg={theme().textMuted}>  {formatCount(wAbs().used)} / {formatCount(wAbs().total)} tokens · Reset in {w.countdown}</text>
                          )}
                        </Show>
                      </box>
                    )
                  } else {
                    return (
                      <box flexDirection="column">
                        <box flexDirection="row" gap={0}>
                          <text fg={theme().success}>{"7D\u00A0\u00A0\u00A0\u00A0"}</text>
                          <text fg={theme().textMuted}>Unlimited (Legacy)</text>
                        </box>
                      </box>
                    )
                  }
                })()}

                {/* Tool section */}
                <Show when={s.time !== null}>
                  {(() => {
                    const tu = s.time
                    if (tu === null) return null
                    const tRem = tu.remainingPct
                    const tColor = tRem <= 10 ? theme().error : tRem <= 30 ? theme().warning : theme().success
                    const tBar = buildBar(tRem)
                    return (
                      <box flexDirection="column">
                        {/* 1x space above Tool section */}
                        <box height={1} />
                        <box flexDirection="row" gap={0}>
                          <text fg={tColor}>{"Tool\u00A0\u00A0"}</text>
                          <text fg={tColor}>{tBar.filled}</text>
                          <text fg={theme().textMuted}>{tBar.empty}</text>
                          <text fg={tColor}>{" "}{tRem.toFixed(0)}%</text>
                        </box>
                        <text fg={theme().textMuted}>  {formatCount(tu.used)} / {formatCount(tu.total)} calls · Reset in {tu.countdown}</text>
                        <Show when={tu.usageDetails && tu.usageDetails.some(u => u.usage > 0)}>
                          <box flexDirection="column">
                            <For each={tu.usageDetails.filter(u => u.usage > 0)}>
                              {(detail) => (
                                <text fg={theme().textMuted}>  {detail.modelCode}: {detail.usage}</text>
                              )}
                            </For>
                          </box>
                        </Show>
                      </box>
                    )
                  })()}
                </Show>
              </box>
            </Show>
          </box>
        )
      })()}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const { slots } = api

  slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "farrukh.glm-reset",
  tui,
}

export default plugin
