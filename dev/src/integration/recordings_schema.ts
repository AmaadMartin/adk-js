/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Runtime validation for the recordings file that adk-python's conformance
 * recorder writes, ported from
 * `src/google/adk/cli/plugins/recordings_schema.py`.
 *
 * This is deliberately not `test_types.ts`'s `Recordings`. That interface holds
 * a single `llmResponse` where the file carries a list of `llm_responses`, so
 * the two shapes are not interchangeable and nothing casts between them.
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
