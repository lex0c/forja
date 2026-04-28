import type { ModelRegistry } from '../registry.ts';
import { GOOGLE_CAPS, GOOGLE_MODEL_NAMES } from './capabilities.ts';
import { type CreateGoogleProviderOptions, createGoogleProvider } from './index.ts';

export const registerGoogleModels = (reg: ModelRegistry): void => {
  for (const modelName of GOOGLE_MODEL_NAMES) {
    const caps = GOOGLE_CAPS[modelName];
    if (caps === undefined) {
      throw new Error(`internal: GOOGLE_CAPS missing entry for ${modelName}`);
    }
    reg.register({
      id: `google/${modelName}`,
      family: 'google',
      modelName,
      capabilities: caps,
      factory: (opts?: unknown) =>
        createGoogleProvider(modelName, (opts as CreateGoogleProviderOptions | undefined) ?? {}),
    });
  }
};
