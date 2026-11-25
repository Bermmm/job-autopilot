import type { Config } from '../config/config.schema.js';
import { readEnv, requireApiKey } from '../config/env.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAiClient } from './openai.js';
import type { LlmClient } from './types.js';

/**
 * Builds the client `config.llm.provider` selects.
 *
 * This is the only place that knows both providers exist. Adding a third
 * means one new file and one new case here.
 */
export function createLlmClient(config: Config): LlmClient {
  const env = readEnv();

  switch (config.llm.provider) {
    case 'anthropic':
      return new AnthropicClient({
        apiKey: requireApiKey('anthropic'),
        baseURL: env.ANTHROPIC_BASE_URL,
        config: config.llm,
      });
    case 'openai':
      return new OpenAiClient({
        apiKey: requireApiKey('openai'),
        baseURL: env.OPENAI_BASE_URL,
        config: config.llm,
      });
  }
}
