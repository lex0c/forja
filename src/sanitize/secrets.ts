// Slice 177 (review — P1). Canonical secret-redaction patterns
// shared by the recap renderer, the permission engine's prompt
// builder, and any future surface that displays operator-visible
// free text derived from raw args.
//
// Originally lived in `src/recap/format.ts`. Promoted here so the
// permissions engine can import without a layering reversal
// (permissions → recap would invert the responsibility ordering).
// `recap/format.ts` re-exports from this module to preserve its
// public surface.
//
// Pattern audit (sec spec §6.1):
//   - anthropic-key / openai-key / aws-access-key / github-token
//     / google-api-key / slack-token / jwt / bearer-token —
//     known shapes with strong bound checks (length floors;
//     `\b` boundaries where the body lets us; negative
//     lookaheads to avoid double-matching).
//   - env-secret — KEY=VALUE forms where KEY's suffix strongly
//     suggests a secret. Preserves the key so the operator sees
//     WHAT was redacted (e.g. `FOO_API_KEY=<redacted:env-secret>`).

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  // When true, the pattern's first capturing group is preserved
  // (typically the env-var key) so the operator sees what was
  // redacted. When false, the entire match is replaced.
  readonly preserveKey: boolean;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, preserveKey: false },
  { name: 'openai-key', pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g, preserveKey: false },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, preserveKey: false },
  {
    name: 'github-token',
    pattern: /\b(?:ghp|ghs|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    preserveKey: false,
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    preserveKey: false,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    preserveKey: false,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    preserveKey: false,
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    preserveKey: false,
  },
  {
    name: 'env-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH_KEY|PRIVATE_KEY))\s*=\s*['"]?([A-Za-z0-9_./+=:-]{8,})['"]?/g,
    preserveKey: true,
  },
];

export const redactSecrets = (text: string): string => {
  if (text.length === 0) return text;
  let result = text;
  for (const { name, pattern, preserveKey } of SECRET_PATTERNS) {
    if (preserveKey) {
      result = result.replace(pattern, (_match, key) => `${key}=<redacted:${name}>`);
    } else {
      result = result.replace(pattern, `<redacted:${name}>`);
    }
  }
  return result;
};
