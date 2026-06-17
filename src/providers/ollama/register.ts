import type { ModelRegistry } from '../registry.ts';
import { OLLAMA_CAPS, OLLAMA_MODEL_NAMES } from './capabilities.ts';
import { type CreateOllamaProviderOptions, createOllamaProvider } from './index.ts';

export const registerOllamaModels = (reg: ModelRegistry): void => {
  for (const modelName of OLLAMA_MODEL_NAMES) {
    const caps = OLLAMA_CAPS[modelName];
    if (caps === undefined) {
      throw new Error(`internal: OLLAMA_CAPS missing entry for ${modelName}`);
    }
    reg.register({
      id: `ollama/${modelName}`,
      family: 'ollama',
      modelName,
      capabilities: caps,
      factory: (opts?: unknown) =>
        createOllamaProvider(modelName, (opts as CreateOllamaProviderOptions | undefined) ?? {}),
    });
  }
};
