/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar, getEnvVar} from '../utils/env_aware_utils.js';

const ADK_TELEMETRY_IGNORE_RUN_CONFIG = 'ADK_TELEMETRY_IGNORE_RUN_CONFIG';
const OTEL_SEMCONV_STABILITY_OPT_IN = 'OTEL_SEMCONV_STABILITY_OPT_IN';
const OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
/** Legacy ADK span-content knob; unlike the OTel var above, it defaults on. */
const ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS =
  'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';
const ADK_EXPERIMENTAL_TELEMETRY = 'ADK_EXPERIMENTAL_TELEMETRY';

/**
 * Token in `OTEL_SEMCONV_STABILITY_OPT_IN` that selects the experimental GenAI
 * semantic conventions.
 */
const GENAI_EXPERIMENTAL_OPT_IN = 'gen_ai_latest_experimental';

/**
 * Env values (lowercased) that the legacy boolean form of
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` treats as "on".
 */
const TRUTHY_ENV_VALUES = ['1', 'true'];

/** Env values (lowercased) treated as "off" for boolean env vars. */
const FALSY_ENV_VALUES = ['0', 'false'];

/**
 * Mirror of `opentelemetry.util.genai.types.ContentCapturingMode`.
 *
 * Declared here rather than imported because `opentelemetry-util-genai` is an
 * optional, in-development dependency. The members are the canonical states of
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export enum ContentCapturingMode {
  /** No content is captured. Matches the empty env value. */
  NO_CONTENT = 'NO_CONTENT',
  /** Content goes on the emitted log record only. */
  EVENT_ONLY = 'EVENT_ONLY',
  /** Content goes on the active span only. */
  SPAN_ONLY = 'SPAN_ONLY',
  /** Content goes on both the log record and the active span. */
  SPAN_AND_EVENT = 'SPAN_AND_EVENT',
}

const CONTENT_CAPTURING_MODES = Object.values(ContentCapturingMode);

/** Options accepted by {@link createTelemetryConfig}. */
export interface TelemetryConfigParams {
  /**
   * Override for `OTEL_SEMCONV_STABILITY_OPT_IN`. `'experimental'` opts in to
   * the experimental GenAI semantic conventions; `'stable'` keeps the legacy
   * path. `'stable'` has no env var equivalent, because the env path infers
   * stable from the absence of `gen_ai_latest_experimental` in the list.
   */
  genaiSemconvStabilityOptIn?: 'stable' | 'experimental';

  /**
   * Override for `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. The env
   * var path accepts the matching uppercase string.
   */
  captureMessageContent?: ContentCapturingMode;

  /** Override for `ADK_EXPERIMENTAL_TELEMETRY`. */
  adkExperimentalTelemetryOptIn?: boolean;
}

/** Whether `mode` routes content onto the span. */
function isSpanBearing(mode: ContentCapturingMode): boolean {
  return (
    mode === ContentCapturingMode.SPAN_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

function readExperimentalGenaiSemconv(): boolean {
  return getEnvVar(OTEL_SEMCONV_STABILITY_OPT_IN)
    .split(',')
    .some((optIn) => optIn.trim() === GENAI_EXPERIMENTAL_OPT_IN);
}

function readContentCapturingMode(): ContentCapturingMode {
  const value = getEnvVar(
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
  ).trim();
  // Back-compat: the old env path was boolean, and a truthy value meant
  // EVENT_ONLY.
  if (TRUTHY_ENV_VALUES.includes(value.toLowerCase())) {
    return ContentCapturingMode.EVENT_ONLY;
  }
  return (
    CONTENT_CAPTURING_MODES.find((mode) => mode === value.toUpperCase()) ??
    ContentCapturingMode.NO_CONTENT
  );
}

function readAddContentToLegacySpans(): boolean {
  const value = getEnvVar(ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS).trim();
  return !FALSY_ENV_VALUES.includes(value.toLowerCase());
}

function readEmitExperimentalTelemetry(): boolean {
  return getBooleanEnvVar(ADK_EXPERIMENTAL_TELEMETRY);
}

function readIgnorePerRequest(): boolean {
  return getBooleanEnvVar(ADK_TELEMETRY_IGNORE_RUN_CONFIG);
}

/**
 * Per-request OpenTelemetry configuration.
 *
 * Attached to an invocation through `RunConfig.telemetry`. Each field left
 * unset falls back to its env var: an `OTEL_*` var, plus the default-on
 * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` for legacy spans and the default-off
 * `ADK_EXPERIMENTAL_TELEMETRY` for experimental telemetry. The `should*` and
 * `resolved*` getters own the precedence ladder: admin lock, then the
 * per-request field, then the env var, then the default.
 *
 * Every env fallback is read once, in the constructor. A config is therefore a
 * decision and not a live view of the environment, so no later change to
 * `process.env` can gate half of one run's telemetry. Construct a new config to
 * pick up a new environment.
 *
 * Set `ADK_TELEMETRY_IGNORE_RUN_CONFIG` to `1` or `true` to make the getters
 * ignore the per-request fields and use the env vars instead.
 */
export class TelemetryConfig {
  readonly genaiSemconvStabilityOptIn?: 'stable' | 'experimental';
  readonly captureMessageContent?: ContentCapturingMode;
  readonly adkExperimentalTelemetryOptIn?: boolean;

  private readonly envExperimentalGenaiSemconv: boolean;
  private readonly envContentCapturingMode: ContentCapturingMode;
  private readonly envAddContentToLegacySpans: boolean;
  private readonly envEmitExperimentalTelemetry: boolean;
  private readonly envIgnorePerRequest: boolean;

  constructor(params: TelemetryConfigParams = {}) {
    this.genaiSemconvStabilityOptIn = params.genaiSemconvStabilityOptIn;
    this.captureMessageContent = params.captureMessageContent;
    this.adkExperimentalTelemetryOptIn = params.adkExperimentalTelemetryOptIn;

    this.envExperimentalGenaiSemconv = readExperimentalGenaiSemconv();
    this.envContentCapturingMode = readContentCapturingMode();
    this.envAddContentToLegacySpans = readAddContentToLegacySpans();
    this.envEmitExperimentalTelemetry = readEmitExperimentalTelemetry();
    this.envIgnorePerRequest = readIgnorePerRequest();
  }

  /** Whether to emit the experimental GenAI semantic convention attributes. */
  get shouldUseExperimentalGenaiSemconv(): boolean {
    const optIn = this.perRequest(this.genaiSemconvStabilityOptIn);
    return optIn === undefined
      ? this.envExperimentalGenaiSemconv
      : optIn === 'experimental';
  }

  /** The effective GenAI content-capturing mode. */
  get resolvedContentCapturingMode(): ContentCapturingMode {
    return (
      this.perRequest(this.captureMessageContent) ??
      this.envContentCapturingMode
    );
  }

  /**
   * {@link resolvedContentCapturingMode} as the canonical string. Returns `''`
   * for `NO_CONTENT`, which matches the historical env var contract.
   */
  get contentCapturingModeValue(): string {
    const mode = this.resolvedContentCapturingMode;
    return mode === ContentCapturingMode.NO_CONTENT ? '' : mode;
  }

  /** Whether content goes on the emitted log records. */
  get shouldAddContentToLogs(): boolean {
    const mode = this.resolvedContentCapturingMode;
    return (
      mode === ContentCapturingMode.EVENT_ONLY ||
      mode === ContentCapturingMode.SPAN_AND_EVENT
    );
  }

  /**
   * Whether content goes on the experimental inference span. This follows the
   * OpenTelemetry routing, unlike {@link shouldAddContentToLegacySpans}.
   */
  get shouldAddContentToExperimentalSpans(): boolean {
    return isSpanBearing(this.resolvedContentCapturingMode);
  }

  /**
   * Whether content goes on the ADK-owned (legacy) spans.
   *
   * A per-request `captureMessageContent` uses the OpenTelemetry span routing.
   * Otherwise this falls back to `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`, which
   * defaults on.
   */
  get shouldAddContentToLegacySpans(): boolean {
    const mode = this.perRequest(this.captureMessageContent);
    return mode === undefined
      ? this.envAddContentToLegacySpans
      : isSpanBearing(mode);
  }

  /**
   * Whether to emit experimental telemetry: the spans, logs, metrics and
   * attributes whose meaning or format can still change.
   */
  get shouldEmitExperimentalTelemetry(): boolean {
    return (
      this.perRequest(this.adkExperimentalTelemetryOptIn) ??
      this.envEmitExperimentalTelemetry
    );
  }

  /** The per-request value, or `undefined` when the admin lock is set. */
  private perRequest<T>(value: T | undefined): T | undefined {
    return this.envIgnorePerRequest ? undefined : value;
  }
}

/**
 * Creates a {@link TelemetryConfig}, snapshotting the telemetry env vars now.
 *
 * @param params - Optional per-request overrides for the env vars.
 * @returns A config whose getters resolve the precedence ladder.
 */
export function createTelemetryConfig(
  params: TelemetryConfigParams = {},
): TelemetryConfig {
  return new TelemetryConfig(params);
}
