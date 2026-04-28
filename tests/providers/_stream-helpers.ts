import type { StreamEvent } from '../../src/providers/types.ts';

// Drain a normalized stream into an array. Tests that care about the
// exact event sequence (the majority of stream normalizer tests) use
// `collectNonUsage` to elide the `usage` event — usage sits between the
// last content event and `stop` in every well-formed turn and would
// force boilerplate on every assertion. Tests that DO care about usage
// import `collect` directly and inspect the `kind: 'usage'` event.
export const collect = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
};

export const collectNonUsage = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> =>
  (await collect(stream)).filter((e) => e.kind !== 'usage');
