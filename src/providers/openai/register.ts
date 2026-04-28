import type { ModelRegistry } from '../registry.ts';
import { OPENAI_CAPS, OPENAI_MODEL_NAMES } from './capabilities.ts';
import { type CreateOpenAIProviderOptions, createOpenAIProvider } from './index.ts';

export const registerOpenAIModels = (reg: ModelRegistry): void => {
  for (const modelName of OPENAI_MODEL_NAMES) {
    const caps = OPENAI_CAPS[modelName];
    if (caps === undefined) {
      throw new Error(`internal: OPENAI_CAPS missing entry for ${modelName}`);
    }
    reg.register({
      id: `openai/${modelName}`,
      family: 'openai',
      modelName,
      capabilities: caps,
      factory: (opts?: unknown) =>
        createOpenAIProvider(modelName, (opts as CreateOpenAIProviderOptions | undefined) ?? {}),
    });
  }
};
