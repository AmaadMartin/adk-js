/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioTranscriptionConfig,
  AvatarConfig,
  Content,
  ContextWindowCompressionConfig,
  HttpOptions,
  LiveConnectConfig,
  Modality,
  ProactivityConfig,
  RealtimeInputConfig,
  SessionResumptionConfig,
  SpeechConfig,
  TranslationConfig,
} from '@google/genai';

import {GetSessionConfig} from '../sessions/base_session_service.js';
import {TelemetryConfig} from '../telemetry/context.js';
import {getEnvVar} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

/** Default used when `ADK_MAX_LLM_CALLS` is unset or unusable. */
const DEFAULT_MAX_LLM_CALLS = 500;

/** Environment variable that overrides the `maxLlmCalls` default. */
const MAX_LLM_CALLS_ENV_VAR = 'ADK_MAX_LLM_CALLS';

/**
 * The streaming mode for the run config.
 */
export enum StreamingMode {
  NONE = 'none',
  SSE = 'sse',
  /**
   * Bidirectional streaming. The `runner.runAsync()` path does not read it;
   * call `runner.runLive()` for bidirectional streaming.
   */
  BIDI = 'bidi',
}

/**
 * Configures the exchange of history between the client and the server.
 *
 * Mirrors the `HistoryConfig` shape the Live API accepts. Declared here rather
 * than imported because `@google/genai` 2.9.0 — the pinned version — does not
 * export it; replace this with the SDK type when the dependency is raised.
 */
export interface HistoryConfig {
  /**
   * If true, after `setup_complete` the server first processes
   * `client_content` messages until `turnComplete` is true. That initial
   * history does not trigger a model call.
   */
  initialHistoryInClientContent?: boolean;
}

/**
 * A `LiveConnectConfig` that also carries {@link HistoryConfig}.
 *
 * `@google/genai` 2.9.0 does not model `historyConfig` on `LiveConnectConfig`;
 * the Live API accepts it. Delete this and use the SDK type once the
 * dependency is raised.
 */
export interface LiveConnectConfigWithHistory extends LiveConnectConfig {
  historyConfig?: HistoryConfig;
}

/**
 * Configuration for running tools in a thread pool for live mode.
 *
 * Accepted so that one configuration can drive several ADK SDKs, but inert in
 * adk-js: a tool callback is not structured-cloneable, so Node cannot move it
 * onto a worker thread. Tools always run on the main event loop, and nothing
 * here reads this field.
 */
export interface ToolThreadPoolConfig {
  /** Maximum number of worker threads in the pool. adk-python defaults it to 4. */
  maxWorkers?: number;
}

/**
 * Configs for runtime behavior of agents.
 */
export interface RunConfig {
  /**
   * Speech configuration for the live agent.
   */
  speechConfig?: SpeechConfig;

  /**
   * HTTP options for this invocation, for example custom headers or a
   * request timeout. Merged over the agent's own `generateContentConfig`
   * HTTP options, with these values winning.
   *
   * `baseUrl` and `apiVersion` are configuration-time settings, so they only
   * apply when the agent set no HTTP options of its own.
   *
   * `ManagedAgent` reads only the `headers`: it merges them with the ADK
   * tracking headers, so a caller header never displaces attribution. Mirrors
   * `RunConfig.http_options` in google/adk-python `agents/run_config.py`, where
   * `base_llm_flow` merges it into every request.
   */
  httpOptions?: HttpOptions;

  /**
   * User labels for this invocation, for example for billing or attribution.
   * Merged over the agent's own labels.
   */
  labels?: Record<string, string>;

  /**
   * The output modalities. If not set, it's default to AUDIO.
   */
  responseModalities?: Modality[];

  /**
   * Avatar configuration for the live agent.
   */
  avatarConfig?: AvatarConfig;

  /**
   * Whether or not to save the input blobs as artifacts.
   */
  saveInputBlobsAsArtifacts?: boolean;

  /**
   * Whether to support CFC (Compositional Function Calling). Only applicable
   * for StreamingMode.SSE. If it's true. the LIVE API will be invoked. Since
   * only LIVE API supports CFC
   *
   * WARNING: This feature is **experimental** and its API or behavior may
   * change in future releases.
   */
  supportCfc?: boolean;

  /**
   * Streaming mode: {@link StreamingMode.NONE}, {@link StreamingMode.SSE} or
   * {@link StreamingMode.BIDI}.
   */
  streamingMode?: StreamingMode;

  /**
   * Output audio transcription config.
   */
  outputAudioTranscription?: AudioTranscriptionConfig;

  /**
   * Input transcription for live agents with audio input from user.
   */
  inputAudioTranscription?: AudioTranscriptionConfig;

  /**
   * If enabled, the model will detect emotions and adapt its responses
   * accordingly.
   */
  enableAffectiveDialog?: boolean;

  /**
   * Configures the proactivity of the model. This allows the model to respond
   * proactively to the input and to ignore irrelevant input.
   */
  proactivity?: ProactivityConfig;

  /**
   * Realtime input config for live agents with audio input from user.
   */
  realtimeInputConfig?: RealtimeInputConfig;

  /**
   * Whether the model emits explicit voice activity detection (VAD) signals.
   */
  explicitVadSignal?: boolean;

  /**
   * Configures real-time speech-to-speech translation. Only supported by
   * translation models.
   */
  translationConfig?: TranslationConfig;

  /**
   * Configures the session resumption mechanism. Only transparent session
   * resumption is supported today.
   */
  sessionResumption?: SessionResumptionConfig;

  /**
   * Configures the exchange of history between the client and the server.
   */
  historyConfig?: HistoryConfig;

  /**
   * Context window compression config. When the running context exceeds
   * `triggerTokens`, the server compresses older history to `targetTokens`.
   */
  contextWindowCompression?: ContextWindowCompressionConfig;

  /**
   * Whether `Runner.runLive` saves the live video and audio a model sends to
   * the artifact service and keeps the event in the session. Off by default,
   * so those events are yielded to the caller and then dropped.
   */
  saveLiveBlob?: boolean;

  /**
   * @deprecated Use {@link RunConfig.saveLiveBlob} instead. Setting this to
   * true turns `saveLiveBlob` on and logs a warning.
   */
  saveLiveAudio?: boolean;

  /**
   * A limit on the total number of llm calls for a given run.
   *
   * The default is read from the `ADK_MAX_LLM_CALLS` environment variable, and
   * falls back to 500.
   *
   * Valid Values:
   *   - More than 0 and less than sys.maxsize: The bound on the number of llm
   *     calls is enforced, if the value is set in this range.
   *   - Less than or equal to 0: This allows for unbounded number of llm calls.
   */
  maxLlmCalls?: number;

  /**
   * Custom metadata for the current invocation. The runner merges it onto every
   * event of the run. A key the event already carries keeps the event's value.
   *
   * `InvocationContext` also copies it into `InvocationContext.customMetadata`
   * at construction, where tools and services read and extend it for the life
   * of the run.
   */
  customMetadata?: Record<string, unknown>;

  /**
   * Per-request OpenTelemetry configuration, which overrides the process-wide
   * telemetry environment variables for this invocation only. Lets a
   * multi-tenant host set the telemetry knobs per request without leaking one
   * request's configuration into a concurrent one.
   *
   * WARNING: This feature is **experimental** and its API or behavior may
   * change in future releases.
   */
  telemetry?: TelemetryConfig;

  /**
   * Controls which events the runner fetches when it loads the session. Use it
   * to avoid loading the full event history on every invocation, for example
   * with `{numRecentEvents: 50}`.
   */
  getSessionConfig?: GetSessionConfig;

  /**
   * Configuration for running tools in a thread pool for live mode. See
   * {@link ToolThreadPoolConfig}.
   */
  toolThreadPoolConfig?: ToolThreadPoolConfig;

  /**
   * If true, the agent loop will suspend on ANY tool call, allowing the client
   * to intercept and execute tools (Client-Side Tool Execution).
   */
  pauseOnToolCalls?: boolean;

  /**
   * Whether to relay thought parts from other agents as labelled context when
   * presenting their messages to the current agent. Off by default: a thought
   * is the other agent's reasoning, not its answer.
   */
  includeThoughtsFromOtherAgents?: boolean;

  /**
   * If true, a plain-text user reply (e.g. "yes"/"no") may resolve a pending
   * `requireConfirmation` tool gate. Off by default so an ordinary chat message
   * on a web/API surface is never silently reinterpreted as a security
   * decision; interactive front-ends (e.g. `adk run`) opt in explicitly.
   */
  plainTextToolConfirmation?: boolean;

  /**
   * Transient context to include in the model input for this invocation.
   *
   * The runner does not persist these contents to the session. They are added
   * only to the LLM request assembled for the current invocation, which lets a
   * caller supply per-turn context without changing the conversation history.
   */
  modelInputContext?: Content[];

  /**
   * Request-level metadata passed from an incoming A2A request or caller.
   */
  a2aMetadata?: Record<string, unknown>;

  /**
   * If true, a `requireConfirmation` gate may be answered by a message that
   * arrived over A2A.
   *
   * Off by default: a remote peer is not the human operator, and a peer that
   * can post to the task would otherwise be able to approve a dangerous tool
   * call on the operator's behalf — the thing the gate exists to prevent. Turn
   * it on only where the peer is a trusted relay for a real person: a front-end
   * that renders the prompt and sends back what they chose.
   *
   * A deliberate divergence from adk-python, which refuses a remote-delivered
   * confirmation outright and offers no way back. The default matches; the
   * option does not exist there.
   */
  allowRemoteToolConfirmation?: boolean;

  /**
   * Set by the A2A executor to record that this run's message came from a
   * remote peer. Not part of the configuration surface: an application setting
   * it by hand is asserting something about the message's provenance that only
   * the transport can know.
   *
   * Read by the tool-confirmation resume path only. The other two interrupts a
   * peer can answer — `adk_request_credential` and `adk_request_input` — are
   * answerable by a client by design: a credential is something a client holds,
   * and an input request asks for data, not for judgement. Confirmation is the
   * one that asks a specific human to take responsibility for an action, which
   * is why it is the one a peer cannot stand in for.
   *
   * @internal
   */
  remoteDelivered?: boolean;
}

/**
 * Creates a {@link RunConfig} with production-safe defaults.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `saveInputBlobsAsArtifacts` → `false`
 * - `supportCfc` → `false`
 * - `enableAffectiveDialog` → `false`
 * - `streamingMode` → {@link StreamingMode.NONE}
 * - `maxLlmCalls` → `ADK_MAX_LLM_CALLS`, else `500`
 * - `pauseOnToolCalls` → `false`
 * - `saveLiveBlob` → `false`
 * - `inputAudioTranscription` and `outputAudioTranscription` → a fresh `{}`
 *
 * A deprecated `saveLiveAudio` flag turns `saveLiveBlob` on and logs a warning.
 *
 * @param params - Optional partial {@link RunConfig} overriding defaults.
 * @returns A merged {@link RunConfig} object.
 * @throws {Error} When `params.maxLlmCalls` exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function createRunConfig(params: Partial<RunConfig> = {}) {
  const config = {
    saveInputBlobsAsArtifacts: false,
    supportCfc: false,
    enableAffectiveDialog: false,
    streamingMode: StreamingMode.NONE,
    pauseOnToolCalls: false,
    saveLiveBlob: false,
    // A fresh object per call: two configs must never share a transcription
    // config, or a mutation on one silently changes the other.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    ...params,
    maxLlmCalls: validateMaxLlmCalls(
      params.maxLlmCalls ?? resolveDefaultMaxLlmCalls(),
    ),
  };
  if (params.saveLiveAudio !== undefined) {
    logger.warn(
      'The `saveLiveAudio` config is deprecated and will be removed in a future release. Use `saveLiveBlob` instead.',
    );
    if (params.saveLiveAudio) {
      config.saveLiveBlob = true;
    }
  }
  return config;
}

/**
 * Resolves the `maxLlmCalls` default from `ADK_MAX_LLM_CALLS`.
 *
 * A value that is not a plain integer logs a warning and yields the default: an
 * operator's typo must not break every run.
 */
function resolveDefaultMaxLlmCalls(): number {
  const envValue = getEnvVar(MAX_LLM_CALLS_ENV_VAR);
  if (!envValue) {
    return DEFAULT_MAX_LLM_CALLS;
  }
  // Number('  ') is 0, so a blank value must not read as a limit of zero.
  const parsed = envValue.trim() ? Number(envValue) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    logger.warn(
      `Invalid value for ${MAX_LLM_CALLS_ENV_VAR} env var: ${envValue}. Using default ${DEFAULT_MAX_LLM_CALLS}.`,
    );
    return DEFAULT_MAX_LLM_CALLS;
  }
  return parsed;
}

function validateMaxLlmCalls(value: number): number {
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `maxLlmCalls should be less than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }

  if (value <= 0) {
    logger.warn(
      'maxLlmCalls is less than or equal to 0. This will result in no enforcement on total number of llm calls that will be made for a run. This may not be ideal, as this could result in a never ending communication between the model and the agent in certain cases.',
    );
  }
  return value;
}
