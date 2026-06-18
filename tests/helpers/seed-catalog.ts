// Materialize the seed model catalog at the user-scope path for the
// current env. The model catalog (`model_providers.json`) is mandatory
// at boot now — `forja init` writes it — so any test that bootstraps
// must have it on disk. Tests set XDG_CONFIG_HOME to a tmp dir; this
// writes the same bytes `forja init`'s model_providers step would,
// exercising the real on-disk read path rather than a seam.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { modelProvidersPath, serializeModelProviders } from '../../src/providers/catalog-io.ts';
import { CANONICAL_MODEL_PROVIDERS } from '../../src/providers/seed-catalog.ts';

// Write the bundled catalog seed to the resolved user-scope path.
// Returns the path written. Throws when no config dir is derivable
// (the test forgot to set XDG_CONFIG_HOME / HOME).
export const seedModelCatalog = (env: NodeJS.ProcessEnv = process.env): string => {
  const path = modelProvidersPath(env);
  if (path === null) {
    throw new Error('seedModelCatalog: no user config dir — set XDG_CONFIG_HOME or HOME first');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeModelProviders(CANONICAL_MODEL_PROVIDERS));
  return path;
};
