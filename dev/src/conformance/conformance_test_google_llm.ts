/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A model that serves recorded LLM responses, and verifies that the runtime
 * asked for what was recorded.
 *
 * Ported from adk-python's
 * `src/google/adk/cli/conformance/_conformance_test_google_llm.py`. adk-python
 * swaps this model in from `base_llm_flow.py` when a replay config is present
 * in session state. adk-js has no such hook yet: `TestRunner` injects
 * `DummyLlm` and replays through `ReplayPlugin.beforeModelCallback`, which
 * verifies nothing. This module is the verifying half; wiring it into the
 * runtime is a separate change.
 */

import {isDeepStrictEqual} from 'node:util';

import {
  BaseLlm,
  BaseLlmConnection,
  getLogger,
  LlmRequest,
  LlmResponse,
} from '@google/adk';

import {
  isRecord,
  normalizeRelayedAgentContent,
  normalizeToolConfig,
} from './replay_normalizers.js';

/**
 * Matches the default in `Gemini`'s constructor
 * (`core/src/models/google_llm.ts`), so a replayed request names the same model
 * a live one would.
 */
const DEFAULT_REPLAY_MODEL = 'gemini-2.5-flash';

/**
 * Request fields that legitimately vary between two runs of the same
 * conversation, and so take no part in the comparison.
 */
const EXCLUDED_CONFIG_FIELDS: readonly string[] = [
  // A live handle rather than request data.
  'abortSignal',
  'httpOptions',
  'labels',
];

/** One recorded LLM call. */
export interface ReplayLlmRecording {
  llmRequest?: LlmRequest;
  /**
   * adk-python records a list of responses per call. adk-js's existing
   * `LlmRecording` records a single one; both are accepted, the list first.
   */
  llmResponses?: LlmResponse[];
  llmResponse?: LlmResponse;
}

/** One recorded step of a conformance test. */
export interface ReplayRecording {
  userMessageIndex: number;
  agentName: string;
  llmRecording?: ReplayLlmRecording;
}

/** Everything the replay model needs for one model call. */
export interface ConformanceReplayModelConfig {
  recordings: {recordings: ReplayRecording[]};
  agentName: string;
  userMessageIndex: number;
  /** Which of this agent's recorded calls in this turn is being served. */
  replayIndex: number;
  /** Defaults to `'gemini-2.5-flash'`, matching `Gemini`. */
  model?: string;
}

/** Identifies the call a verification failure belongs to. */
export interface ReplayRequestContext {
  agentName: string;
  userMessageIndex: number;
  replayIndex: number;
}

/** Raised when a replayed run diverges from its recording. */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}

/** Whether `e` is a {@link ReplayVerificationError}. */
export function isReplayVerificationError(
  e: unknown,
): e is ReplayVerificationError {
  return e instanceof Error && e.name === 'ReplayVerificationError';
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * Deep-copies `value`, dropping properties that are absent or empty.
 *
 * This stands in for Pydantic's `exclude_none` plus `exclude_defaults`.
 * TypeScript cannot know a field's declared default, so emptiness is the
 * closest available proxy: a field explicitly set to `false`, `0` or `''`
 * survives, and so can only differ if one side genuinely set it.
 */
function pruneEmptyValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneEmptyValues);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    const pruned = pruneEmptyValues(entry);
    if (isEmptyContainer(pruned)) {
      continue;
    }
    result[key] = pruned;
  }
  return result;
}

/**
 * Reduces a request to the data worth comparing.
 *
 * `toolsDict` holds live `BaseTool` instances, so it is dropped rather than
 * copied. `liveConnectConfig` and the excluded config fields are the same
 * exclusions adk-python passes to `model_dump`.
 */
function dumpRequest(request: LlmRequest): unknown {
  const {
    toolsDict: _toolsDict,
    liveConnectConfig: _liveConnectConfig,
    config,
    ...rest
  } = request;
  const dumped: Record<string, unknown> = {...rest};
  if (config) {
    const comparableConfig: Record<string, unknown> = {...config};
    for (const field of EXCLUDED_CONFIG_FIELDS) {
      delete comparableConfig[field];
    }
    dumped['config'] = comparableConfig;
  }
  return normalizeRelayedAgentContent(
    normalizeToolConfig(pruneEmptyValues(dumped)),
  );
}

/**
 * Throws unless the live request carries the same data as the recorded one.
 *
 * A recording that predates request capture has no recorded request; there is
 * then nothing to verify and the call is let through.
 *
 * @throws {ReplayVerificationError} when the two requests differ.
 */
export function verifyLlmRequestMatch(
  recordedRequest: LlmRequest | undefined,
  currentRequest: LlmRequest,
  context: ReplayRequestContext,
): void {
  if (!recordedRequest) {
    return;
  }
  const recorded = dumpRequest(recordedRequest);
  const current = dumpRequest(currentRequest);
  if (isDeepStrictEqual(recorded, current)) {
    return;
  }
  throw new ReplayVerificationError(
    `LLM request mismatch in turn ${context.userMessageIndex} for agent ` +
      `'${context.agentName}' (index ${context.replayIndex}):\n` +
      `recorded: ${JSON.stringify(recorded)}\n` +
      `current: ${JSON.stringify(current)}`,
  );
}

function recordedResponses(recording: ReplayLlmRecording): LlmResponse[] {
  if (recording.llmResponses) {
    return recording.llmResponses;
  }
  return recording.llmResponse ? [recording.llmResponse] : [];
}

/**
 * Serves the recorded responses for one (agent, turn, replay index) triple.
 *
 * The model holds no cursor of its own: the caller supplies `replayIndex` and
 * increments it across calls, as adk-python does from session state.
 */
export class ConformanceTestGemini extends BaseLlm {
  private readonly agentName: string;
  private readonly userMessageIndex: number;
  private readonly replayIndex: number;
  private readonly agentLlmRecordings: readonly ReplayLlmRecording[];

  constructor(config: ConformanceReplayModelConfig) {
    super({model: config.model ?? DEFAULT_REPLAY_MODEL});
    this.agentName = config.agentName;
    this.userMessageIndex = config.userMessageIndex;
    this.replayIndex = config.replayIndex;
    this.agentLlmRecordings = config.recordings.recordings
      .filter(
        (recording) =>
          recording.agentName === config.agentName &&
          recording.userMessageIndex === config.userMessageIndex &&
          recording.llmRecording,
      )
      .map((recording) => recording.llmRecording!);
  }

  /**
   * Yields the recorded responses for this call, after checking that
   * `llmRequest` matches the recorded one.
   *
   * @throws {ReplayVerificationError} when the runtime asks for more calls than
   *     were recorded, or when the request does not match.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    getLogger().debug(
      `Replaying LLM response for agent ${this.agentName} (index ${this.replayIndex})`,
    );

    if (this.replayIndex >= this.agentLlmRecordings.length) {
      throw new ReplayVerificationError(
        `Runtime sent more LLM requests than expected for agent ` +
          `'${this.agentName}' at userMessageIndex ${this.userMessageIndex}. ` +
          `Expected ${this.agentLlmRecordings.length}, but got request at ` +
          `index ${this.replayIndex}`,
      );
    }

    const recording = this.agentLlmRecordings[this.replayIndex];
    verifyLlmRequestMatch(recording.llmRequest, llmRequest, {
      agentName: this.agentName,
      userMessageIndex: this.userMessageIndex,
      replayIndex: this.replayIndex,
    });

    for (const response of recordedResponses(recording)) {
      yield response;
    }
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ConformanceTestGemini.connect should not be called during replay tests.',
    );
  }
}
