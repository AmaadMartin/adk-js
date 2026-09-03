/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {LlmAgentConfig} from './llm_agent.js';

/**
 * `GenerateContentConfig` fields that already have a dedicated `LlmAgent`
 * option. Passing one directly to the constructor points at that option.
 */
const GENERATE_CONTENT_FIELDS_OWNED_BY_AGENT: Readonly<Record<string, string>> =
  {
    systemInstruction: 'instruction',
    responseSchema: 'outputSchema',
    baseUrl: 'model',
  };

/**
 * Every `GenerateContentConfig` field name.
 *
 * `satisfies` pins each entry to a real genai field, so a name that genai
 * renames or drops fails the typecheck instead of silently never matching.
 */
const GENERATE_CONTENT_FIELD_NAMES = [
  'abortSignal',
  'audioTimestamp',
  'automaticFunctionCalling',
  'cachedContent',
  'candidateCount',
  'enableEnhancedCivicAnswers',
  'frequencyPenalty',
  'httpOptions',
  'imageConfig',
  'labels',
  'logprobs',
  'maxOutputTokens',
  'mediaResolution',
  'modelArmorConfig',
  'modelSelectionConfig',
  'presencePenalty',
  'responseJsonSchema',
  'responseLogprobs',
  'responseMimeType',
  'responseModalities',
  'responseSchema',
  'routingConfig',
  'safetySettings',
  'seed',
  'serviceTier',
  'speechConfig',
  'stopSequences',
  'systemInstruction',
  'temperature',
  'thinkingConfig',
  'toolConfig',
  'tools',
  'topK',
  'topP',
] as const satisfies readonly (keyof GenerateContentConfig)[];

const GENERATE_CONTENT_FIELD_NAME_SET: ReadonlySet<string> = new Set(
  GENERATE_CONTENT_FIELD_NAMES,
);

/**
 * Every `LlmAgentConfig` key, including the inherited agent and node keys.
 *
 * A TypeScript interface has no runtime key list, so this is the only defence
 * against drift: `satisfies` fails the typecheck when an option is added to
 * {@link LlmAgentConfig} and not listed here. Without it a new option whose
 * name collides with a genai field would be rejected as misplaced.
 */
const LLM_AGENT_CONFIG_KEY_FLAGS = {
  afterAgentCallback: true,
  afterModelCallback: true,
  afterToolCallback: true,
  beforeAgentCallback: true,
  beforeModelCallback: true,
  beforeToolCallback: true,
  codeExecutor: true,
  contextCompactors: true,
  description: true,
  disallowTransferToParent: true,
  disallowTransferToPeers: true,
  generateContentConfig: true,
  globalInstruction: true,
  includeContents: true,
  inputSchema: true,
  instruction: true,
  isolationScope: true,
  mode: true,
  model: true,
  name: true,
  onModelErrorCallback: true,
  onToolErrorCallback: true,
  outputKey: true,
  outputSchema: true,
  parallelWorker: true,
  parentAgent: true,
  requestProcessors: true,
  rerunOnResume: true,
  responseProcessors: true,
  retryConfig: true,
  stateSchema: true,
  subAgents: true,
  timeout: true,
  tools: true,
  waitForOutput: true,
} as const satisfies Record<keyof LlmAgentConfig, true>;

const LLM_AGENT_CONFIG_KEYS: ReadonlySet<string> = new Set(
  Object.keys(LLM_AGENT_CONFIG_KEY_FLAGS),
);

/** Returns whether an `httpOptions` value carries a base URL. */
function hasBaseUrl(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'baseUrl' in value &&
    !!value.baseUrl
  );
}

function formatRedirects(redirected: Array<[string, string]>): string {
  return (
    redirected
      .map(
        ([source, destination]) =>
          `\`${source}\` must be set via LlmAgent.${destination}, not via ` +
          `LlmAgent(${source}=...)`,
      )
      .join('. ') + '.'
  );
}

function formatMisplacedFields(fields: string[]): string {
  const verb = fields.length === 1 ? 'is a' : 'are';
  const suffix = fields.length === 1 ? '' : 's';
  const example = fields.map((name) => `${name}: ...`).join(', ');
  return (
    `${fields.join(', ')} ${verb} GenerateContentConfig field${suffix}. ` +
    `Pass generateContentConfig={${example}} instead.`
  );
}

/**
 * Rejects generation settings passed straight to the `LlmAgent` constructor.
 *
 * Generation settings belong on `generateContentConfig`, and three of them
 * (`systemInstruction`, `responseSchema`, `baseUrl`) have a dedicated agent
 * option instead. TypeScript already rejects them in an object literal; this
 * catches construction from a parsed document, where the object is untyped.
 *
 * Ported from adk-python's
 * `LlmAgent._reject_misplaced_generate_content_kwargs`, with two deliberate
 * differences, both because TypeScript has no keyword arguments. An
 * unrecognized key on its own is accepted, since an object carrying extra
 * properties is legal; such keys are named only when the same object also
 * carries a misplaced setting. And a key whose value is `undefined` carries no
 * setting, so it is ignored — spreading an optional value leaves the key
 * behind.
 *
 * @param config The raw constructor argument.
 * @throws Error naming the option to use instead.
 */
export function assertNoMisplacedGenerateContentKwargs(config: object): void {
  const redirected: Array<[string, string]> = [];
  const misplaced: string[] = [];
  const extras: string[] = [];
  const transportErrors: string[] = [];
  const entries: Array<[string, unknown]> = Object.entries(config);

  for (const [key, value] of entries) {
    if (LLM_AGENT_CONFIG_KEYS.has(key) || value === undefined) {
      continue;
    }
    if (key === 'httpOptions' && hasBaseUrl(value)) {
      transportErrors.push(
        'Base URL is a transport setting and must be set via LlmAgent.model, ' +
          `not via LlmAgent(${key}=...).`,
      );
      continue;
    }
    const agentOption = GENERATE_CONTENT_FIELDS_OWNED_BY_AGENT[key];
    if (agentOption !== undefined) {
      redirected.push([key, agentOption]);
      continue;
    }
    if (GENERATE_CONTENT_FIELD_NAME_SET.has(key)) {
      misplaced.push(key);
      continue;
    }
    extras.push(key);
  }

  const parts: string[] = [...transportErrors];
  if (redirected.length) {
    parts.push(formatRedirects(redirected));
  }
  if (misplaced.length) {
    parts.push(formatMisplacedFields(misplaced));
  }
  if (!parts.length) {
    return;
  }
  if (extras.length) {
    parts.push(`Extra inputs are not permitted: ${extras.join(', ')}.`);
  }
  throw new Error(parts.join(' '));
}
