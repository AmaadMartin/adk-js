/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {FunctionCall, FunctionResponse} from '@google/genai';
import {z} from 'zod';

/**
 * Runtime validation for a conformance recordings file, in the two shapes this
 * package reads one.
 *
 * `RecordingsSchema` validates a recordings object whose keys are already
 * camelCase, which is what `toCamelKeys` hands the conformance test loader.
 * `parseRecordings` validates the snake_case file itself, and converts the
 * structural keys as it goes.
 */

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
  /**
   * Every response the model produced for `llmRequest`, in arrival order. SSE
   * delivers a turn as a run of partial responses followed by the complete
   * one, so a streaming recording needs a list. adk-python's
   * `LlmRecording.llm_responses` is the same field, and its schema forbids any
   * other name for it.
   */
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

/**
 * Runtime validation for the recordings file that adk-python's conformance
 * recorder writes, ported from
 * `src/google/adk/cli/plugins/recordings_schema.py`.
 *
 * This is deliberately not `RecordingsSchema` above. That schema reads keys
 * that are already camelCase, where this one reads the snake_case file, so the
 * two entry points are not interchangeable and nothing casts between them.
 */

/**
 * The recorded call and response stay loose. `@google/genai` puts fields on a
 * function call and on a function response that a strict schema would reject.
 *
 * `args` and `response` are passed through verbatim: their keys are compared
 * against live tool arguments and handed back to the model, so converting a
 * recorded `user_name` to `userName` would change what replay verifies.
 */
const functionCallSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const functionResponseSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  response: z.record(z.string(), z.unknown()).optional(),
});

const toolRecordingSchema = z
  .strictObject({
    tool_call: functionCallSchema.optional(),
    tool_response: functionResponseSchema.optional(),
  })
  .transform((recording) => ({
    toolCall: recording.tool_call,
    toolResponse: recording.tool_response,
  }));

const llmRecordingSchema = z
  .strictObject({
    llm_request: z.unknown().optional(),
    llm_responses: z.array(z.unknown()).optional(),
  })
  .transform((recording) => ({
    llmRequest: recording.llm_request,
    llmResponses: recording.llm_responses,
  }));

const recordingSchema = z
  .strictObject({
    user_message_index: z.number(),
    agent_name: z.string(),
    llm_recording: llmRecordingSchema.optional(),
    tool_recording: toolRecordingSchema.optional(),
  })
  .transform((recording) => ({
    userMessageIndex: recording.user_message_index,
    agentName: recording.agent_name,
    llmRecording: recording.llm_recording,
    toolRecording: recording.tool_recording,
  }));

const recordingsFileSchema = z.strictObject({
  recordings: z.array(recordingSchema).default([]),
});

/** One recorded tool call paired with the response it produced. */
export type RecordedToolRecording = z.output<typeof toolRecordingSchema>;

/** The validated contents of a recordings file. */
export type RecordingsFile = z.output<typeof recordingsFileSchema>;

/**
 * Validates the parsed YAML of a recordings file and converts its structural
 * keys to camelCase.
 *
 * @param data The value `js-yaml` produced for the file.
 * @return The validated recordings.
 * @throws When the data does not match the schema. The recording levels are
 *     strict, matching adk-python's `extra='forbid'`, so a misspelled key such
 *     as `tool_recordings` is rejected rather than ignored.
 */
export function parseRecordings(data: unknown): RecordingsFile {
  return recordingsFileSchema.parse(data);
}
