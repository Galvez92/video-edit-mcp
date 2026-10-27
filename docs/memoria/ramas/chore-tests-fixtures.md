# chore/tests-fixtures
**Status:** pending · **Order:** anytime

## Goal
Shared, reproducible test media and helpers.

## Tools / API
- Extend `scripts/make-fixtures.sh`: portrait clip, silent clip, speech-like clip, clips with differing fps/sizes.
- Test helpers: `probeDuration`, `measureLoudness`, temp dir lifecycle.
- Document license of every non-synthetic asset (only verified-license media allowed).

## Acceptance tests
- Script is idempotent; CI generates fixtures in < 30s.

## Dependencies
main.
