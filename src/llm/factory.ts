import type { Config, LlmTask, ResolvedLlmConfig } from '../config/config.schema.js';
import { resolveLlmConfig } from '../config/config.schema.js';
import { readEnv, requireApiKey } from '../config/env.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAiClient } from './openai.js';
import type { LlmClient } from './types.js';

/**
 * Builds the client for one task, on the provider `config.llm.provider` names.
 *
 * This is the only place that knows both providers exist. Adding a third means
 * one new file and one new case here.
 *
 * The task argument picks the model: `score` runs over every fresh posting and
 * wants something cheap, `draft` writes one letter and wants something good.
 */
export function createLlmClient(config: Config, task: LlmTask): LlmClient {
  const env = readEnv();
  const resolved: ResolvedLlmConfig = resolveLlmConfig(config.llm, task);

  switch (resolved.provider) {
    case 'anthropic':
      return new AnthropicClient({
        apiKey: requireApiKey('anthropic'),
        baseURL: env.ANTHROPIC_BASE_URL,
        config: resolved,
      });
    case 'openai':
      return new OpenAiClient({
        apiKey: requireApiKey('openai'),
        baseURL: env.OPENAI_BASE_URL,
        config: resolved,
      });
  }
}
