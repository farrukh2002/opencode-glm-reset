# opencode-glm-reset

OpenCode TUI sidebar plugin that shows GLM (`zai-coding-plan`) quota usage,
reset countdowns, and peak/off-peak status in the sidebar.

## Features

- **5H token quota** — used %, live countdown to next reset, and absolute
  token counts (`used / total`) when the plan exposes them (Max/Pro).
- **7D weekly limit** — same bar + countdown; shows "Unlimited (Legacy)"
  when the plan has no weekly cap.
- **Tool-call limit** — used/total calls, per-model breakdown.
- **Color-coded bars** — green while ≥70% remaining, amber at 30–70%,
  red at ≤10% remaining.
- **Peak/off-peak indicator** — ⚡ Peak (14:00–18:00 SGT, 3x usage)
  vs 🌙 Off-Peak.
- **Smart polling** — checks the quota API every 60s, backing off to 5min
  when the 5H quota is exhausted.
- **Expandable** — click the header to show 7D / Tool / absolute details.
- **Heuristic fallback** — if the API is unreachable, scans the session's
  message parts for a reset time and falls back to a clock-based estimate.

## Install

### CLI (recommended)

```bash
opencode plugin @farrukh2002/opencode-glm-reset --global
```

### Manual

Add to your `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "@farrukh2002/opencode-glm-reset"
  ]
}
```

Requires the `zai-coding-plan` provider configured in your opencode `auth.json`.

## How it works

1. Reads the API key from the `zai-coding-plan` provider (falls back to
   `~/.local/share/opencode/auth.json`, then `~/.config/opencode/auth.json`
   and the older `account.json` locations).
2. Polls `https://api.z.ai/api/monitor/usage/quota/limit` every 60s (5min
   when the 5H quota is exhausted).
3. Renders bars + countdowns in the sidebar; expands for absolute counts.

## Development

```bash
npm run build       # copies tui.tsx → dist/tui.tsx
npm run typecheck   # tsc --noEmit
npm pack --dry-run  # preview publish
npm publish         # publish to npm
```
