/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {FunctionCall, FunctionResponse} from '@google/genai';
import {z} from 'zod';

/**
 * Accepts any non-null object and carries the SDK type statically.
 *
 * A hand-written Zod schema for an SDK payload would duplicate the SDK's own
 * type definitions, and would reject a valid recording every time the SDK adds
 * a field.
 */
const objectOfType = <T>() =>
  z.custom<T>((v) => typeof v === 'object' && v !== null, {
    message: 'Expected an object',
  });

/** Paired LLM request and response. */
export const LlmRecordingSchema = z.strictObject({
  llmRequest: objectOfType<LlmRequest>().optional(),
  /** adk-js records one response; adk-python records the streamed list. */
  llmResponse: objectOfType<LlmResponse>().optional(),
  llmResponses: z.array(objectOfType<LlmResponse>()).optional(),
});

/** Paired tool call and response. */
export const ToolRecordingSchema = z.strictObject({
  toolCall: objectOfType<FunctionCall>().optional(),
  toolResponse: objectOfType<FunctionResponse>().optional(),
});

/** Single interaction recording, ordered by request timestamp. */
export const RecordingSchema = z.strictObject({
  userMessageIndex: z.number().int(),
  agentName: z.string(),
  llmRecording: LlmRecordingSchema.optional(),
  toolRecording: ToolRecordingSchema.optional(),
});

/** All recordings in chronological order. */
export const RecordingsSchema = z.strictObject({
  /** Absent means no recordings, matching adk-python's `default_factory`. */
  recordings: z.array(RecordingSchema).default([]),
});

export type LlmRecording = z.infer<typeof LlmRecordingSchema>;
export type ToolRecording = z.infer<typeof ToolRecordingSchema>;
export type Recording = z.infer<typeof RecordingSchema>;
export type Recordings = z.infer<typeof RecordingsSchema>;
