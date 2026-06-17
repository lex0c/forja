import {
  ERROR_CODES,
  type SearchToolsResult,
  type Tool,
  type ToolResult,
  toolError,
} from '../types.ts';

// tool_search — reveal a deferred tool so it can be called (AGENTIC_CLI §7.6).
//
// The base tool surface is curated to the common path; rarer tools are
// "deferred" — registered and usable, but kept out of the per-turn tool list to
// cut selection pressure (principle 3). This tool is how the model reaches them:
// it searches the deferred catalog and REVEALS the matches, which then stay
// callable for the rest of the session (sticky). The matched schemas come back
// in the result, so the very next turn the model can invoke them directly.
//
// The catalog of available deferred tools (name + blurb) is appended to this
// tool's description by the harness at build time — generated from the registry
// so it never drifts from what's actually deferred. The model reads that list
// to know what to search for.

export interface ToolSearchInput {
  // Either a keyword query (ranked over deferred tool names + descriptions) or
  // `select:name1,name2` to fetch specific deferred tools by exact name.
  query: string;
}

// Max keyword hits returned per search — caps how many tools one search can
// reveal (and how many schemas land in the result). `select:` is exact, so it
// isn't capped here.
const MAX_KEYWORD_HITS = 8;

// Pure ranking over a deferred-tool catalog. Two forms:
//   - `select:a,b` → exact name match; names with no match come back in
//     `notFound` so the model learns the typo instead of silently getting less.
//   - otherwise → keyword: score by how many query terms appear in the tool's
//     name+description (case-insensitive), drop zero-score, rank desc, cap.
// Returns matched NAMES (the caller maps them back to live tools); kept pure +
// dependency-free so it unit-tests without a registry or ctx.
export const rankDeferredTools = (
  catalog: ReadonlyArray<{ name: string; description: string }>,
  query: string,
): { names: string[]; notFound: string[] } => {
  const trimmed = query.trim();
  if (trimmed.startsWith('select:')) {
    const present = new Set(catalog.map((t) => t.name));
    const seen = new Set<string>();
    const names: string[] = [];
    const notFound: string[] = [];
    for (const raw of trimmed.slice('select:'.length).split(',')) {
      const name = raw.trim();
      // Dedupe: `select:a,a` must reveal/return `a` once, not twice — otherwise
      // the caller pushes the same schema multiple times into the result.
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      if (present.has(name)) names.push(name);
      else notFound.push(name);
    }
    return { names, notFound };
  }
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const names = catalog
    .map((t) => {
      const hay = `${t.name} ${t.description}`.toLowerCase();
      return {
        name: t.name,
        score: terms.reduce((acc, term) => acc + (hay.includes(term) ? 1 : 0), 0),
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_KEYWORD_HITS)
    .map((x) => x.name);
  return { names, notFound: [] };
};

export const toolSearchTool: Tool<ToolSearchInput, SearchToolsResult> = {
  name: 'tool_search',
  description:
    'Reveal a deferred tool so you can call it. Some tools are kept off the default list to reduce clutter; search here to bring one into scope, then call it on the next turn (it stays available for the rest of the session). `query` is either keywords (e.g. "cancel background") or `select:name1,name2` to fetch exact tools by name. Returns each match\'s name, description, and input schema. The set of deferred tools is listed below.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keywords to rank deferred tools, or `select:name1,name2` to fetch specific ones by exact name.',
      },
    },
    required: ['query'],
  },
  metadata: {
    category: 'misc',
    // Reveals tools into the session surface — a harness-internal state change,
    // not an external mutation, but not idempotent/parallel-safe either (it
    // grows the revealed set, which the loop reads to rebuild the tool list).
    writes: false,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<SearchToolsResult>> {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'query must be a non-empty string');
    }
    if (ctx.searchTools === undefined) {
      // No deferred surface in this context (subagent / headless): everything
      // already-whitelisted is directly visible, so there is nothing to reveal.
      return toolError(
        ERROR_CODES.toolSearchUnavailable,
        'tool_search is unavailable here — the full tool surface is already visible',
        { retryable: false },
      );
    }
    return ctx.searchTools(args.query);
  },
};
