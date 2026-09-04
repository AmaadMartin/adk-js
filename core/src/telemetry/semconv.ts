/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span identity that ADK both writes and reads back.
 *
 * `tracing.ts` stamps these onto spans and `telemetry/db/span_mapper.ts`
 * resolves a session from them, so the two must agree. They live here rather
 * than in `tracing.ts` because importing that module runs its `getTracer` call
 * as a side effect, which a reader has no reason to trigger.
 */

/** Instrumentation scope of every span ADK opens. */
export const ADK_SCOPE_NAME = 'gcp.vertex.agent';

/** Primary session key, set on the model call span. */
export const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';

/** Invocation the span belongs to. */
export const INVOCATION_ID_ATTRIBUTE = 'gcp.vertex.agent.invocation_id';

/**
 * Fallback session key, set on agent and workflow invocation spans.
 *
 * This is the GenAI semantic convention's name for the same thing.
 */
export const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';
