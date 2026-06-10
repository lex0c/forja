## Summary

- tighten the retry backoff in src/queue.ts
- 1 files edited, 1 commands run

## Changes

### `~/proj/src/queue.ts`

- edited (line counts unavailable)

## Test plan

- [x] bun test tests/queue/

## Notes

- recovered: provider.rate_limit — upstream 429; backed off and retried twice
