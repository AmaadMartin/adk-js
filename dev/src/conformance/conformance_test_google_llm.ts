/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Gemini model that serves recorded responses back to a conformance run.
 *
 * The point is the verification, not the replay: before it serves a recorded
 * response it checks that the runtime asked for what the recording says it
 * asked for. A conformance run that only replays passes even when the request
 * the runtime builds has silently changed, which is the one thing conformance
 * exists to catch.
 *
 * Nothing swaps this model in yet. adk-python does it from `base_llm_flow.py`,
 * which reads a replay config out of session state; adk-js has no equivalent
 * hook, and adding one is a change to `core` with its own blast radius.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/cli/conformance/_conformance_test_google_llm.py`.
 */

import {isDeepStrictEqual} from 'node:util';

import {
  BaseLlmConnection,
  Gemini,
  getLogger,
  LlmRequest,
  LlmResponse,
} from '@google/adk';

import {LlmRecording, Recordings} from '../integration/test_types.js';
import {
  isRecord,
  normalizeRelayedAgentContent,
  normalizeToolConfig,
} from './replay_normalizers.js';

const logger = getLogger();

/**
 * `Gemini` refuses to construct without credentials, and which credentials it
 * demands depends on the ambient environment: an API key normally, but a
 * project and a location once `GOOGLE_GENAI_USE_VERTEXAI` or
 * `GOOGLE_GENAI_USE_ENTERPRISE` is set. Passing `vertexai: false` does not
 * settle it, because `geminiInitParams` re-reads enterprise mode whenever the
 * explicit flag is falsy. A replay model has to construct the same way in
 * every environment, so all three are supplied here.
 *
 * None of them is ever used: `connect` throws and `generateContentAsync`
 * serves a recording, so the model has no network path. They do shadow real
 * credentials, which is deliberate -- a conformance run must not behave
 * differently on a machine that happens to have them configured.
 */
const REPLAY_PLACEHOLDER_CREDENTIALS = {
  apiKey: 'conformance-replay-no-network',
  project: 'conformance-replay-no-network',
  location: 'conformance-replay-no-network',
};

/**
 * Request fields that carry no behavior and would otherwise fail every
 * comparison. `httpOptions` and `labels` mirror adk-python's nested exclude.
 * `abortSignal` is adk-js only: the runtime writes a live `AbortSignal` handle
 * there, which is a handle rather than request data.
 */
const EXCLUDED_CONFIG_FIELDS: readonly string[] = [
  'httpOptions',
  'labels',
  'abortSignal',
];

/** Everything the replay model needs to serve one model call. */
export interface ConformanceReplayModelConfig {
  recordings: Recordings;
  agentName: string;
  userMessageIndex: number;
  /** Which of this agent's recorded calls in this turn is being served. */
  replayIndex: number;
  /** Overrides the model name; defaults to `Gemini`'s own default. */
  model?: string;
}

/** Identifies the call a verification failure belongs to. */
export interface ReplayRequestContext {
  agentName: string;
  userMessageIndex: number;
  replayIndex: number;
}

/** Raised when a replayed run does not match its recording. */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}

/**
 * Type guard for {@link ReplayVerificationError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct
 * when errors cross a package boundary (two copies of adk-js in one runtime
 * would fail an `instanceof` check between them).
 */
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
 * Drops the properties adk-python's `model_dump` drops.
 *
 * `exclude_none` maps directly: a property that is `null` or `undefined` goes.
 * Both spellings occur, because a live request writes `undefined` and a
 * recording loaded from YAML writes `null`.
 *
 * `exclude_defaults` has no TypeScript equivalent -- the compiler does not know
 * a field's declared default -- so emptiness stands in for it: an empty object
 * or empty array is dropped. That is looser than adk-python wherever a default
 * is a non-empty value, and stricter wherever a default is `0` or `false`. A
 * field explicitly set to `0`, `false` or `''` survives and can still cause a
 * genuine mismatch. Array elements are pruned but never removed, so a
 * difference in length always survives.
 */
function pruneRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pruneRequestValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) {
      continue;
    }
    const pruned = pruneRequestValue(item);
    if (isEmptyContainer(pruned)) {
      continue;
    }
    result[key] = pruned;
  }
  return result;
}

/**
 * Reduces a request to the fields worth comparing.
 *
 * `liveConnectConfig` mirrors adk-python's top-level exclude. `toolsDict` is
 * excluded there too, and holds live tool instances that cannot be compared.
 */
function dumpRequest(request: LlmRequest): unknown {
  const {
    liveConnectConfig: _liveConnectConfig,
    toolsDict: _toolsDict,
    config,
    ...rest
  } = request;

  const dumped: Record<string, unknown> = {...rest};
  if (config !== undefined && config !== null) {
    const trimmedConfig: Record<string, unknown> = {...config};
    for (const field of EXCLUDED_CONFIG_FIELDS) {
      delete trimmedConfig[field];
    }
    dumped['config'] = trimmedConfig;
  }
  return pruneRequestValue(dumped);
}

function normalizeRequest(request: LlmRequest): unknown {
  return normalizeRelayedAgentContent(
    normalizeToolConfig(dumpRequest(request)),
  );
}

/**
 * Throws when the current request differs from the recorded one.
 *
 * Returns early when there is no recorded request. adk-python cannot reach
 * that case because pydantic types the field as required; adk-js can, because
 * `LlmRecording.llmRequest` is optional, and a recording made before request
 * capture has nothing to verify.
 */
export function verifyLlmRequestMatch(
  recordedRequest: LlmRequest | undefined,
  currentRequest: LlmRequest,
  context: ReplayRequestContext,
): void {
  if (!recordedRequest) {
    return;
  }

  const recorded = normalizeRequest(recordedRequest);
  const current = normalizeRequest(currentRequest);
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

/**
 * A Gemini model that replays one recorded call and verifies the request.
 *
 * The caller owns the replay cursor: it constructs the model once per call
 * with the `replayIndex` that call is expected to serve. The model itself
 * holds no mutable state.
 */
export class ConformanceTestGemini extends Gemini {
  private readonly agentName: string;
  private readonly userMessageIndex: number;
  private readonly replayIndex: number;
  private readonly agentLlmRecordings: readonly LlmRecording[];

  constructor(config: ConformanceReplayModelConfig) {
    super({model: config.model, ...REPLAY_PLACEHOLDER_CREDENTIALS});

    this.agentName = config.agentName;
    this.userMessageIndex = config.userMessageIndex;
    this.replayIndex = config.replayIndex;
    this.agentLlmRecordings = config.recordings.recordings
      .filter(
        (recording) =>
          recording.agentName === config.agentName &&
          recording.userMessageIndex === config.userMessageIndex,
      )
      .flatMap((recording) =>
        recording.llmRecording ? [recording.llmRecording] : [],
      );
  }

  /**
   * Serves the recorded call at this model's replay index.
   *
   * `stream` and `abortSignal` are ignored: a recording is served whole,
   * whether the live call would have streamed or not.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    logger.debug(
      `Replaying LLM response for agent ${this.agentName} (index ${this.replayIndex})`,
    );

    if (this.replayIndex >= this.agentLlmRecordings.length) {
      throw new ReplayVerificationError(
        'Runtime sent more LLM requests than expected for agent ' +
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

    const responses =
      recording.llmResponses ??
      (recording.llmResponse ? [recording.llmResponse] : []);
    for (const response of responses) {
      yield response;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ConformanceTestGemini replays recorded responses and cannot open a live connection.',
    );
  }
}
