/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-request OpenTelemetry configuration types.
 *
 * {@link TelemetryConfig} (attached to `RunConfig.telemetry`) is the single
 * source of truth for how each telemetry knob resolves. The resolver functions
 * in this module own the precedence ladder (admin lock > per-request field >
 * environment variable > default); the decision points in `tracing.ts` are
 * thin wrappers over them.
 *
 * Setting `ADK_TELEMETRY_IGNORE_RUN_CONFIG` to `'1'` or `'true'` makes the
 * resolvers ignore the per-request fields and fall back to the environment
 * variables.
 */

/** Admin lock: when truthy, `RunConfig.telemetry` fields are ignored. */
export const ADK_TELEMETRY_IGNORE_RUN_CONFIG =
  'ADK_TELEMETRY_IGNORE_RUN_CONFIG';

/** OTel GenAI content-capture mode; defaults off. */
export const OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';

/** Legacy ADK span-content knob; unlike the OTel variable above, defaults on. */
export const ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS =
  'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

/** Environment values (lowercased) treated as "on" for boolean variables. */
const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

/**
 * The canonical states for
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export enum ContentCapturingMode {
  /** No content captured (matches the environment value `''`). */
  NO_CONTENT = 'NO_CONTENT',
  /** Content on the emitted LogRecord only. */
  EVENT_ONLY = 'EVENT_ONLY',
  /** Content on the active span only. */
  SPAN_ONLY = 'SPAN_ONLY',
  /** Content on both the LogRecord and the active span. */
  SPAN_AND_EVENT = 'SPAN_AND_EVENT',
}

const CONTENT_CAPTURING_MODE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ContentCapturingMode),
);

/**
 * Per-request OpenTelemetry configuration.
 *
 * Attached to an invocation via `RunConfig.telemetry`. Any field left unset
 * falls back to its corresponding environment variable. The fields are
 * `readonly` and the resolvers read the environment lazily, so one config is
 * safe to share across concurrent invocations.
 *
 * Limitation: when a GenAI instrumentation library owns span creation, it
 * reads its own OTel environment variables, so these overrides apply to
 * ADK-owned spans only.
 */
export interface TelemetryConfig {
  /**
   * Override for `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. The
   * environment path accepts the matching uppercase string.
   */
  readonly captureMessageContent?: ContentCapturingMode;
}

function isContentCapturingMode(value: string): value is ContentCapturingMode {
  return CONTENT_CAPTURING_MODE_VALUES.has(value);
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
 * it. Every resolver applies the lock through this function.
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
 * Resolves the effective GenAI content-capturing mode.
 *
 * Precedence: admin lock > `captureMessageContent` >
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` > `NO_CONTENT`. An
 * environment value outside the four-state set resolves to `NO_CONTENT`, so an
 * unparseable value never widens capture.
 */
export function resolveContentCapturingMode(
  config?: TelemetryConfig,
): ContentCapturingMode {
  const field = effectiveCaptureMessageContent(config);
  if (field !== undefined) {
    return field;
  }
  const stripped = (
    process.env[OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT] ?? ''
  ).trim();
  // Back-compat: the old environment path was boolean, so a truthy value keeps
  // its historical meaning of EVENT_ONLY.
  if (TRUTHY_ENV_VALUES.has(stripped.toLowerCase())) {
    return ContentCapturingMode.EVENT_ONLY;
  }
  const upper = stripped.toUpperCase();
  return isContentCapturingMode(upper)
    ? upper
    : ContentCapturingMode.NO_CONTENT;
}

/**
 * The resolved mode as its canonical string, with `''` for `NO_CONTENT` to
 * match the historical environment-variable contract.
 */
export function contentCapturingModeValue(config?: TelemetryConfig): string {
  const mode = resolveContentCapturingMode(config);
  return mode === ContentCapturingMode.NO_CONTENT ? '' : mode;
}

/** Whether content goes on emitted LogRecords. */
export function shouldAddContentToLogs(config?: TelemetryConfig): boolean {
  const mode = resolveContentCapturingMode(config);
  return (
    mode === ContentCapturingMode.EVENT_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

/**
 * Whether content goes on the experimental inference span, following the OTel
 * span routing.
 */
export function shouldAddContentToExperimentalSpans(
  config?: TelemetryConfig,
): boolean {
  return isSpanBearing(resolveContentCapturingMode(config));
}

/**
 * Whether content goes on ADK-owned (legacy) spans.
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
