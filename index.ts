/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { TextAttributes } from "@opentui/core"

// ── Types ──────────────────────────────────────────────────────────────────

interface QuotaData {
  level: string
  usedPct: number
  total: number
  remainingPct: number
  nextResetEpoch: number
}

// ── Constants ──────────────────────────────────────────────────────────────

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
const ZAI_PROVIDER_ID = "zai-coding-plan"

const KV_BASELINE_KEY = "glm_reset_baseline_sgt"
const KV_CYCLE_MS_KEY = "glm_reset_cycle_ms"
const FALLBACK_BASELINE_SGT = "2026-05-28 00:45:44"
const FALLBACK_CYCLE_MS = 5 * 3600 * 1000
const BAR_WIDTH = 20
const API_POLL_MS = 60_000
const TICK_MS = 1000
const RESET_PARSE_RE = /Your limit will reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
const RETRY_AFTER_RE = /reset after (\d+h)?(\d+m)?(\d+s)?/i
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000

// ── Quota API ───────────────────────────────────────────────────────────────

async function fetchQuota(apiKey: string): Promise<QuotaData | null> {
  try {
    const res = await fetch(ZAI_QUOTA_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null

    const payload: any = await res.json()
    if (payload?.code !== 200) return null

    const data = payload.data || {}
    const limits = Array.isArray(data.limits) ? data.limits : []
    const tokenLimit = limits.find((l: any) => l?.type === "TOKENS_LIMIT")
    if (!tokenLimit) return null

    const usedPct = Number(tokenLimit.percentage) ?? 0
    const nextResetEpoch = Number(tokenLimit.nextResetTime) ?? 0
    const rawLevel = String(data.level || "Unknown")

    return {
      level: rawLevel.charAt(0).toUpperCase() + rawLevel.slice(1).toLowerCase(),
      usedPct: Math.min(100, Math.max(0, usedPct)),
      total: 100,
      remainingPct: Math.min(100, Math.max(0, 100 - usedPct)),
      nextResetEpoch,
    }
  } catch {
    return null
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRemaining(ms: number): string {
  if (ms <= 0) return "Resetting..."
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatLocalTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const ss = d.getSeconds().toString().padStart(2, "0")
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const shortTz = tz.split("/").pop() || tz
  return `${hh}:${mm}:${ss} ${shortTz}`
}

function buildBar(percent: number): { filled: string; empty: string; clamped: number } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH)))
  return {
    filled: "█".repeat(filled),
    empty: "░".repeat(BAR_WIDTH - filled),
    clamped,
  }
}

function parseSgt(dateStr: string): number {
  const [ymd, hms] = dateStr.split(" ")
  const [y, m, d] = ymd.split("-").map(Number)
  const [hh, mm, ss] = hms.split(":").map(Number)
  return Date.UTC(y, m - 1, d, hh, mm, ss) - SGT_OFFSET_MS
}

function nextResetEpoch(baselineEpoch: number, cycleMs: number, now: number): number {
  const elapsed = now - baselineEpoch
  if (elapsed < 0) return baselineEpoch
  const cyclesPast = Math.floor(elapsed / cycleMs)
  return baselineEpoch + (cyclesPast + 1) * cycleMs
}

function findResetTimeInMessages(messages: readonly any[]): string | null {
  for (const msg of messages) {
    const content = msg?.content ?? msg?.text ?? ""
    if (typeof content !== "string") continue
    const match = content.match(RESET_PARSE_RE)
    if (match) return match[1]
  }
  return null
}

function findRetryAfterInMessages(messages: readonly any[]): number | null {
  for (const msg of messages) {
    const content = msg?.content ?? msg?.text ?? ""
    if (typeof content !== "string") continue
    const match = content.match(RETRY_AFTER_RE)
    if (match) {
      let totalSec = 0
      const h = match[1] ? parseInt(match[1]) : 0
      const m = match[2] ? parseInt(match[2]) : 0
      const s = match[3] ? parseInt(match[3]) : 0
      totalSec = h * 3600 + m * 60 + s
      if (totalSec > 0) return Date.now() + totalSec * 1000
    }
  }
  return null
}

// ── View ────────────────────────────────────────────────────────────────────

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current

  // ── Get z.ai API key from the zai-coding-plan provider ──
  const [apiKey, setApiKey] = createSignal<string | null>(null)

  createEffect(() => {
    try {
      const providers: any[] = props.api.state.provider as any[]
      const zaiProvider = providers.find(p => p.id === ZAI_PROVIDER_ID)
      if (zaiProvider?.key) {
        setApiKey(zaiProvider.key)
      }
    } catch { /* providers not ready */ }
  })

  // ── Quota API resource ──
  const [quotaTrigger, setQuotaTrigger] = createSignal(0)

  const [quotaData] = createResource(
    () => ({ key: apiKey(), t: quotaTrigger() }),
    async ({ key }) => {
      if (!key) return null
      return fetchQuota(key)
    },
  )

  // Re-fetch every 60s (or 5min when exhausted)
  createEffect(() => {
    if (!apiKey()) return
    const data = quotaData()
    const isExhausted = data ? data.remainingPct <= 0 : false
    const pollMs = isExhausted ? 300_000 : API_POLL_MS
    const id = setInterval(() => setQuotaTrigger(x => x + 1), pollMs)
    onCleanup(() => clearInterval(id))
  })

  // ── Fallback: message scanning ──
  const [baselineSgt, setBaselineSgt] = createSignal<string>(FALLBACK_BASELINE_SGT)
  const [cycleMs, setCycleMs] = createSignal<number>(FALLBACK_CYCLE_MS)

  createEffect(() => {
    try {
      const storedBase = props.api.kv.get<string>(KV_BASELINE_KEY)
      if (storedBase) setBaselineSgt(storedBase)
      const storedCycle = props.api.kv.get<number>(KV_CYCLE_MS_KEY)
      if (storedCycle) setCycleMs(storedCycle)
    } catch { /* KV not ready */ }
  })

  const messages = createMemo(() => {
    try { return props.api.state.session.messages(props.sessionID) as any[] } catch { return [] }
  })
  createEffect(() => {
    const found = findResetTimeInMessages(messages())
    if (found && found !== baselineSgt()) {
      setBaselineSgt(found)
      try { props.api.kv.set(KV_BASELINE_KEY, found) } catch { /* best-effort */ }
    }
  })

  const [retryAfterEpoch, setRetryAfterEpoch] = createSignal<number | null>(null)
  createEffect(() => {
    const ra = findRetryAfterInMessages(messages())
    if (ra) setRetryAfterEpoch(ra)
  })

  // ── Live tick ──
  const [now, setNow] = createSignal(Date.now())
  const tickId = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(tickId))

  // ── Display derivation ──
  const display = createMemo(() => {
    const t = now()
    const apiQuota = quotaData()
    const hasKey = !!apiKey()

    // Primary: live API data from z.ai
    if (apiQuota && apiQuota.nextResetEpoch > 0) {
      const remaining = apiQuota.nextResetEpoch - t
      return {
        source: "api" as const,
        sourceLabel: "Live",
        level: apiQuota.level,
        usedPct: apiQuota.usedPct,
        remainingPct: apiQuota.remainingPct,
        total: apiQuota.total,
        countdown: formatRemaining(remaining),
        localTime: formatLocalTime(apiQuota.nextResetEpoch),
        expired: remaining <= 0,
        loading: false,
      }
    }

    // Secondary: rate-limit retry-after from error messages
    const ra = retryAfterEpoch()
    if (ra && ra > t) {
      const remaining = ra - t
      return {
        source: "retry-after" as const,
        sourceLabel: "Live",
        level: "Rate limited",
        usedPct: 0,
        remainingPct: 0,
        total: 0,
        countdown: formatRemaining(remaining),
        localTime: formatLocalTime(ra),
        expired: remaining <= 0,
        loading: false,
      }
    }

    // Tertiary: message-scanning heuristic
    const baseEpoch = parseSgt(baselineSgt())
    const cycle = cycleMs()
    const nextEpoch = nextResetEpoch(baseEpoch, cycle, t)
    const remaining = nextEpoch - t
    return {
      source: "heuristic" as const,
      sourceLabel: "Estimated",
      level: "",
      usedPct: 0,
      remainingPct: 0,
      total: 0,
      countdown: formatRemaining(remaining),
      localTime: formatLocalTime(nextEpoch),
      expired: remaining <= 0,
      loading: quotaData.loading && !hasKey,
    }
  })

  const barParts = createMemo(() => buildBar(display().usedPct))
  const barColor = createMemo(() => {
    const up = display().usedPct
    if (up >= 90) return theme().error
    if (up >= 70) return theme().warning
    return theme().success
  })

  // ── Render ──
  return (
    <box>
      <Show when={display().loading} fallback={
        <Show when={!display().expired} fallback={
          <text fg={theme().success}>Reset available</text>
        }>
          <box>
            {/* Title */}
            <text fg={theme().text} attributes={TextAttributes.BOLD}>
              GLM Reset{display().level ? `: ${display().level} plan` : ""}
            </text>

            <Show when={display().source === "api"}>
              <box flexDirection="row" gap={1}>
                <text fg={barColor()}>{barParts().filled}</text>
                <text fg={theme().textMuted}>{barParts().empty}</text>
                <text fg={barColor()}>{display().remainingPct.toFixed(0)}%</text>
              </box>
            </Show>

            {/* Countdown */}
            <text fg={theme().text}>Reset in: {display().countdown}</text>

            {/* Local time + source tag */}
            <text fg={theme().textMuted}>{display().localTime} • {display().sourceLabel}</text>
          </box>
        </Show>
      }>
        <text fg={theme().textMuted}>Loading...</text>
      </Show>
    </box>
  )
}

// ── Plugin registration ────────────────────────────────────────────────────

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
