import { DEFAULT_OLLAMA_BASE_URL } from './http.ts';

// Daemon diagnosis for `agent doctor` and for gating the integration smoke
// (run-or-skip). `probeOllama` never throws — any failure becomes
// `reachable: false`. `ollamaReadiness` turns a probe into a doctor-style verdict.

export interface OllamaProbe {
  reachable: boolean;
  version?: string;
  models?: string[];
  error?: string;
}

export interface OllamaReadiness {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  remediation?: string;
}

// Compare dotted version strings numerically. Tolerant of a leading `v` and of
// per-segment suffixes (`0.5.0-rc1` → [0,5,0]) — Ollama's /api/version is usually
// clean ("0.5.7"), but a proxy/build may decorate it; a `v` prefix on the major
// would otherwise parse to 0 and corrupt the comparison.
const compareVersions = (a: string, b: string): number => {
  const segs = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((seg) => {
        const m = seg.match(/^\d+/);
        return m ? Number.parseInt(m[0], 10) : 0;
      });
  const pa = segs(a);
  const pb = segs(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
};

// A model counts as pulled if the daemon lists it exactly, or — when asked for a
// bare name (no tag) — if any pulled tag of it is present (e.g. "llama3" ↔
// "llama3:latest"). Ollama's /api/tags always returns tagged names.
const isPulled = (models: string[], model: string): boolean => {
  if (models.includes(model)) {
    return true;
  }
  if (!model.includes(':')) {
    return models.some((m) => m.startsWith(`${model}:`));
  }
  return false;
};

const getJson = async (url: string, fetchImpl: typeof fetch): Promise<unknown> => {
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

// GET /api/version (+ /api/tags for the pulled-model list). Reachability is the
// primary signal; a failing /api/tags still counts as reachable (models stay
// undefined). Catch-all → reachable:false so callers branch on a single field.
export const probeOllama = async (
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaProbe> => {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const version = (await getJson(`${base}/api/version`, fetchImpl)) as { version?: unknown };
    const result: OllamaProbe = { reachable: true };
    if (typeof version.version === 'string') {
      result.version = version.version;
    }
    try {
      const tags = (await getJson(`${base}/api/tags`, fetchImpl)) as {
        models?: Array<{ name?: unknown }>;
      };
      result.models = (tags.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      // /api/tags is best-effort; reachability already established by /api/version.
    }
    return result;
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
};

// Turn a probe into an ok/warn/fail verdict with an actionable next step.
// `minVersion` flags a daemon too old (or whose version couldn't be read);
// `model` flags a catalog model that isn't pulled. Both degrade to `warn`
// (usable-ish); only an unreachable daemon is `fail`.
export const ollamaReadiness = (
  probe: OllamaProbe,
  opts: { model?: string; minVersion?: string } = {},
): OllamaReadiness => {
  if (!probe.reachable) {
    return {
      status: 'fail',
      detail: `Ollama unreachable: ${probe.error ?? 'unknown error'}`,
      remediation: 'Start the daemon (`ollama serve`) or set FORJA_OLLAMA_BASE_URL.',
    };
  }

  const parts: string[] = [`reachable${probe.version !== undefined ? ` (v${probe.version})` : ''}`];
  let status: OllamaReadiness['status'] = 'ok';
  let remediation: string | undefined;

  if (opts.minVersion !== undefined) {
    if (probe.version === undefined) {
      status = 'warn';
      parts.push('version unknown');
      remediation = `Could not read the Ollama version — ensure it is >= ${opts.minVersion}.`;
    } else if (compareVersions(probe.version, opts.minVersion) < 0) {
      status = 'warn';
      parts.push(`below the recommended v${opts.minVersion}`);
      remediation = `Update Ollama to >= ${opts.minVersion} (native tools / format schema / think).`;
    }
  }

  if (
    opts.model !== undefined &&
    probe.models !== undefined &&
    !isPulled(probe.models, opts.model)
  ) {
    status = 'warn';
    parts.push(`model ${opts.model} not pulled`);
    remediation = `Pull the model: \`ollama pull ${opts.model}\``;
  }

  const verdict: OllamaReadiness = { status, detail: parts.join('; ') };
  if (remediation !== undefined) {
    verdict.remediation = remediation;
  }
  return verdict;
};
