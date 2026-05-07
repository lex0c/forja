// Shared seed derivation for `seed_in_eval` (`PLAYBOOKS.md`
// §1.1). The playbook frontmatter exposes the intent as a
// boolean — "this run wants seeded generation for
// reproducibility" — but provider SDKs (OpenAI, Google) take a
// numeric seed. The harness threads the boolean onto
// GenerateRequest.seed_in_eval; adapters call this helper to
// translate boolean intent into a deterministic 32-bit seed.
//
// Derivation strategy: SHA-256 over `system + messages`
// serialized stably, take the first 4 bytes as a SIGNED
// 32-bit integer. Properties this gives us:
//   1. Deterministic across replays of the same request — same
//      conversation surface yields the same seed, the
//      reproducibility contract eval rigs depend on.
//   2. Varies across steps within a run — each step's request
//      includes a longer message history, so the hash differs
//      and the seeded generation does not collapse to repetitive
//      outputs.
//   3. Cheap to compute — one sha256 per request, dominated by
//      the provider RTT in any practical workload.
//
// Signed int32 (range -2_147_483_648 to 2_147_483_647) is the
// strictest seed range we have to satisfy: Gemini's
// `generationConfig.seed` is documented `int32`, OpenAI's
// `seed` accepts any number. Returning the intersection works
// for both. (Earlier this used readUInt32BE and produced values
// up to 2^32-1; roughly half landed outside Google's range and
// would have been silently rejected or coerced.)

import { createHash } from 'node:crypto';
import type { GenerateRequest } from './types.ts';

export const deriveSeedFromRequest = (req: GenerateRequest): number => {
  const hash = createHash('sha256');
  if (req.system !== undefined) hash.update(req.system);
  for (const msg of req.messages) {
    // JSON.stringify ordering depends on insertion order at the
    // construction site. The harness's ProviderMessage builder
    // uses a fixed key order today, so the same conversation
    // value-equally hashes to the same bytes; if a future
    // call site spreads partials or builds via JSON.parse the
    // hash silently drifts. If/when this becomes load-bearing,
    // switch to a canonical-JSON serializer here.
    hash.update(JSON.stringify(msg));
  }
  const digest = hash.digest();
  return digest.readInt32BE(0);
};
