/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-request OpenTelemetry configuration types.
 *
 * {@link TelemetryConfig} (attached to `RunConfig.telemetry`) is the single
 * source of truth for how the content-capture knob resolves. Precedence: admin
 * lock > per-request field > environment variable > default.
 *
 * Setting `ADK_TELEMETRY_IGNORE_RUN_CONFIG` to `'1'` or `'true'` makes the
 * resolver ignore the per-request field and fall back to the environment
 * variable.
 */

/** Admin lock: when truthy, `RunConfig.telemetry` fields are ignored. */
export const ADK_TELEMETRY_IGNORE_RUN_CONFIG =
  'ADK_TELEMETRY_IGNORE_RUN_CONFIG';

/** ADK span-content knob; defaults on. */
export const ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS =
  'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

/** Environment values (lowercased) treated as "on" for boolean variables. */
const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

/**
 * The canonical states for
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export enum ContentCapturingMode {
  /** No content captured. */
  NO_CONTENT = 'NO_CONTENT',
  /** Content on the emitted LogRecord only. */
  EVENT_ONLY = 'EVENT_ONLY',
  /** Content on the active span only. */
  SPAN_ONLY = 'SPAN_ONLY',
  /** Content on both the LogRecord and the active span. */
  SPAN_AND_EVENT = 'SPAN_AND_EVENT',
}

/**
 * Per-request OpenTelemetry configuration.
 *
 * Attached to an invocation via `RunConfig.telemetry`. Any field left unset
 * falls back to its corresponding environment variable. The fields are
 * `readonly` and the resolver reads the environment lazily, so one config is
 * safe to share across concurrent invocations.
 *
 * Limitation: when a GenAI instrumentation library owns span creation, it
 * reads its own OTel environment variables, so these overrides apply to
 * ADK-owned spans only.
 */
export interface TelemetryConfig {
  /**
   * Whether this invocation records prompt and response content. Overrides
   * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` for ADK-owned spans, which capture
   * content for the span-bearing modes (`SPAN_ONLY` and `SPAN_AND_EVENT`).
   */
  readonly captureMessageContent?: ContentCapturingMode;
}

/** Whether the admin lock is set. */
function isAdminLockSet(): boolean {
  const lock = (process.env[ADK_TELEMETRY_IGNORE_RUN_CONFIG] ?? '')
    .trim()
    .toLowerCase();
  return TRUTHY_ENV_VALUES.has(lock);
}

/**
 * The per-request capture mode, or `undefined` when the admin lock discards
 * it. This is the single place the lock is applied.
 */
function effectiveCaptureMessageContent(
  config?: TelemetryConfig,
): ContentCapturingMode | undefined {
  return isAdminLockSet() ? undefined : config?.captureMessageContent;
}

/** Whether `mode` routes content onto the span. */
function isSpanBearing(mode: ContentCapturingMode): boolean {
  return (
    mode === ContentCapturingMode.SPAN_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

/**
 * Whether content goes on ADK-owned spans.
 *
 * A per-request `captureMessageContent` uses the OTel span routing; otherwise
 * this falls back to `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`, which defaults on.
 */
export function shouldAddContentToLegacySpans(
  config?: TelemetryConfig,
): boolean {
  const field = effectiveCaptureMessageContent(config);
  if (field !== undefined) {
    return isSpanBearing(field);
  }
  const envValue = process.env[ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS] || 'true';
  return envValue === 'true' || envValue === '1';
}
