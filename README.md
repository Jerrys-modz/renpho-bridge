# sparkyfitness-renpho

Community tool that syncs **RENPHO smart tape measure** (and optionally smart scale) measurements into
[SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness) through its existing `POST /api/health-data` endpoint.
It is a standalone tool and needs no changes to SparkyFitness.

> **Unofficial API.** RENPHO has no public API. This tool talks to the same cloud endpoints as the RENPHO
> app, using the protocol documented by the MIT-licensed
> [`renpho-api`](https://github.com/danvaneijck/renpho-api) Python client (ported to TypeScript).
> It may break if RENPHO changes its API, and use may be restricted by RENPHO's Terms of Service. Use it only
> with your own account and at your own risk. Not affiliated with RENPHO or SparkyFitness.

## Setup

1. In SparkyFitness, create an API key with write access (Settings -> API keys).
2. Set environment variables (see `.env.example`):

   | Variable | Meaning |
   | --- | --- |
   | `RENPHO_EMAIL` / `RENPHO_PASSWORD` | RENPHO account (an email/password login; SSO-only accounts need a password set) |
   | `SPARKY_URL` | Base URL of your SparkyFitness server, e.g. `https://fit.example.com` |
   | `SPARKY_API_KEY` | The API key from step 1 |
   | `STATE_PATH` | Optional, default `state.json`: record ids already synced |
   | `LENGTH_UNIT` | Optional, `cm` (default) or `in`: unit for the custom tape sites (chest, arms, ...). Set to `in` if your SparkyFitness measurement unit is inches |
   | `SYNC_INTERVAL_MINUTES` | Optional: if > 0 the process keeps running and syncs on this interval |

3. `npm install && npm run sync -- --dry-run`, then `npm run sync`. Run it from cron/systemd for regular syncs.

**Test mode:** `--dry-run` (alias `--test`) or `TEST_MODE=true` logs in to RENPHO, reads your data and prints every entry that would be sent (date, type, value, unit), without contacting SparkyFitness or saving state, so `SPARKY_URL` / `SPARKY_API_KEY` aren't needed. Records that were already synced earlier are not shown again. In Docker, set `TEST_MODE=true` in `.env` and watch `docker compose logs`.

Flags: `--dry-run`/`--test`, `--tape-only`, `--scale-only`, `--since=YYYY-MM-DD`.

## Docker

```bash
cp .env.example .env   # fill in the values
docker compose up -d
docker compose logs -f
```

`docker-compose.yml` pulls the prebuilt multi-arch image (amd64/arm64) from
`ghcr.io/jerrys-modz/renpho-bridge:latest`, published by the `Docker` workflow on every push to `main` and on
`v*` tags. To build from source instead, replace the `image:` line with `build: .` and use `up -d --build`.

The container syncs every `SYNC_INTERVAL_MINUTES` (default 60) and keeps its state in the `renpho-state`
volume. Set `SYNC_INTERVAL_MINUTES=0` to sync once and exit (for an external scheduler), e.g.
`docker compose run --rm sparkyfitness-renpho --dry-run`. If SparkyFitness runs in another compose project,
point `SPARKY_URL` at a host the container can reach (e.g. `http://host.docker.internal:3010`).

## Mapping

| RENPHO | SparkyFitness |
| --- | --- |
| Tape: neck, waist, hip | check-in `neck`, `waist`, `hips` (cm) |
| Tape: shoulder, chest, abdomen, arm (and left/right), thigh, calf | custom measurements (cm), categories auto-created |
| Scale: weight, body fat %, body water %, BMR | check-in `weight`, `body_fat`, `body_water_percentage`, `bmr` |

Units: whatever unit the RENPHO app displays, each record carries its own unit code and the tool converts to
cm first. neck/waist/hips are always sent in cm, because SparkyFitness stores them in cm and shows them in the
user's chosen unit. The custom sites are stored with the unit they are sent in, so set `LENGTH_UNIT=in` if you
use inches (changing it later creates a separate category, since the category is keyed on name and unit). Days use the timezone stored on each RENPHO record. Records already sent are
tracked in the state file and are not re-sent; if SparkyFitness rejects any entry in a run, none are marked as
synced and the next run retries.

Scale support is untested against real hardware (the author of the original proposal owns only the tape
measure); testers with a RENPHO scale are welcome.

## Development

`npm test`, `npm run typecheck`. Licensed MIT; protocol details derived from `renpho-api` (MIT, danvaneijck).
