import type { ModelRegistry } from '../registry.ts';
import { ANTHROPIC_CAPS, ANTHROPIC_MODEL_NAMES } from './capabilities.ts';
import { type CreateAnthropicProviderOptions, createAnthropicProvider } from './index.ts';

// Adds every Anthropic model declared in capabilities.ts to the registry.
// Each entry's `factory(opts)` casts the registry-side `unknown` opts back
// to this family's typed options before delegating to createAnthropicProvider.
export const registerAnthropicModels = (reg: ModelRegistry): void => {
  for (const modelName of ANTHROPIC_MODEL_NAMES) {
    const caps = ANTHROPIC_CAPS[modelName];
    if (caps === undefined) {
      throw new Error(`internal: ANTHROPIC_CAPS missing entry for ${modelName}`);
    }
    reg.register({
      id: `anthropic/${modelName}`,
      family: 'anthropic',
      modelName,
      capabilities: caps,
      factory: (opts?: unknown) =>
        createAnthropicProvider(
          modelName,
          (opts as CreateAnthropicProviderOptions | undefined) ?? {},
        ),
    });
  }
};
