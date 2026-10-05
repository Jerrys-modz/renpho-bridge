# Changelog

All notable changes are listed here. To publish a release, update this file and push a tag such as `v0.1.0`;
the Release workflow creates the GitHub release and the Docker workflow publishes the image tags.

## 0.1.0 - 2026-10-05

### Added
- Sync of RENPHO smart tape measure and scale data into SparkyFitness through `POST /api/health-data`.
- Initial full-history sync, then a rolling window of recent days (`SYNC_DAYS`, default 3).
- Test mode (`--dry-run` / `TEST_MODE`), `--debug`, and `--list-devices`.
- Device selection with `SYNC_DEVICES` and `SCALE_TABLES`; inch support for custom sites with `LENGTH_UNIT`.
- Saved RENPHO session token to avoid logging the phone app out on every sync.
- Docker image (amd64/arm64) published to GHCR, with a compose file.
- Retries with backoff for temporary failures, Docker `HEALTHCHECK`, healthchecks.io-style pings and
  ntfy-style failure/recovery alerts.

### Fixed
- 19-digit RENPHO user ids are kept exact instead of being rounded by JSON parsing.
- Muscle and bone mass use the field meanings verified against the RENPHO app.
