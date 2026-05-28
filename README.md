# opencode-glm-reset

OpenCode TUI sidebar plugin that shows GLM token limit reset countdown for the `zai-coding-plan` provider.

## Features

- **Live quota** from z.ai API — shows used/remaining token %, plan level, progress bar
- **Color-coded bar** — green (<70%), amber (70-90%), red (≥90%)
- **Reset countdown** — live ticking countdown to next quota reset
- **Heuristic fallback** — scans session messages for reset times when API is unavailable
- **Polling backoff** — slows to 5min checks when quota is exhausted

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

Requires `zai-coding-plan` provider configured in your opencode `account.json`.

## How it works

1. Reads the API key from the `zai-coding-plan` provider
2. Calls `https://api.z.ai/api/monitor/usage/quota/limit` every 60s
3. Shows the countdown in the sidebar with a progress bar

## Development

```bash
npm run build     # copies index.ts → dist/tui.tsx
npm pack --dry-run # preview publish
npm publish        # publish to npm
```
