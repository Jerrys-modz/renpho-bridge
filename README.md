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

3. `npm install && npm run sync -- --dry-run`, then `npm run sync`. Run it from cron/systemd for regular syncs.

Flags: `--dry-run`, `--tape-only`, `--scale-only`, `--since=YYYY-MM-DD`.

## Mapping

| RENPHO | SparkyFitness |
| --- | --- |
| Tape: neck, waist, hip | check-in `neck`, `waist`, `hips` (cm) |
| Tape: shoulder, chest, abdomen, arm (and left/right), thigh, calf | custom measurements (cm), categories auto-created |
| Scale: weight, body fat %, body water %, BMR | check-in `weight`, `body_fat`, `body_water_percentage`, `bmr` |

Inch values are converted to cm. Days use the timezone stored on each RENPHO record. Records already sent are
tracked in the state file and are not re-sent; if SparkyFitness rejects any entry in a run, none are marked as
synced and the next run retries.

Scale support is untested against real hardware (the author of the original proposal owns only the tape
measure); testers with a RENPHO scale are welcome.

## Development

`npm test`, `npm run typecheck`. Licensed MIT; protocol details derived from `renpho-api` (MIT, danvaneijck).
