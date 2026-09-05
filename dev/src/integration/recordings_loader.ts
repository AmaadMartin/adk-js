/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';
import {ReplayConfigError} from './replay_errors.js';
import {LlmRecording, Recordings} from './test_types.js';

/** Fixture file names, keyed by the `streaming_mode` a client configures. */
const RECORDINGS_FILE_NAMES: ReadonlyMap<string, string> = new Map([
  [StreamingMode.NONE, 'generated-recordings.yaml'],
  [StreamingMode.SSE, 'generated-recordings-sse.yaml'],
]);

/**
 * Paths, in the fixture's own snake_case, whose value is a payload the recorded
 * agent chose rather than part of the recordings schema. Their inner keys must
 * survive verbatim, so an argument adk-python recorded as `user_name` is read
 * back as `user_name`. A path names no array index; `camelcase-keys` skips
 * those when it matches.
 */
const OPAQUE_PAYLOAD_PATHS: readonly string[] = [
  'recordings.tool_recording.tool_call.args',
  'recordings.tool_recording.tool_response.response',
  'recordings.llm_recording.llm_request.contents.parts.function_call.args',
  'recordings.llm_recording.llm_request.contents.parts.function_response.response',
  'recordings.llm_recording.llm_response.content.parts.function_call.args',
  'recordings.llm_recording.llm_response.content.parts.function_response.response',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT'
  );
}

const toolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const toolResponseSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  response: z.record(z.string(), z.unknown()).optional(),
});

const toolRecordingSchema = z.strictObject({
  toolCall: toolCallSchema.optional(),
  toolResponse: toolResponseSchema.optional(),
});

/**
 * The LLM pair is checked only for being a mapping. adk-python records
 * `llm_responses` as a list while adk-js models a single `llmResponse`, so a
 * strict shape here would reject fixtures the Python recorder writes.
 */
const llmRecordingSchema = z.custom<LlmRecording>(isRecord);

const recordingSchema = z.strictObject({
  userMessageIndex: z.number(),
  agentName: z.string(),
  llmRecording: llmRecordingSchema.optional(),
  toolRecording: toolRecordingSchema.optional(),
});

const recordingsSchema = z.strictObject({
  recordings: z.array(recordingSchema).default([]),
});

/**
 * Returns the recordings file the given streaming mode replays from.
 *
 * @throws Error when `streamingMode` is neither `none` nor `sse`.
 */
export function recordingsFilePath(
  caseDir: string,
  streamingMode: string,
): string {
  const fileName = RECORDINGS_FILE_NAMES.get(streamingMode);
  if (fileName === undefined) {
    throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }
  return path.join(caseDir, fileName);
}

/**
 * Reads and validates one recordings fixture.
 *
 * @throws ReplayConfigError when the file is missing, unreadable or invalid.
 */
export async function loadRecordings(file: string): Promise<Recordings> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (e: unknown) {
    if (isFileNotFound(e)) {
      throw new ReplayConfigError(`Recordings file not found: ${file}`);
    }
    throw new ReplayConfigError(
      `Failed to load recordings from ${file}: ${String(e)}`,
    );
  }
  const document = yaml.load(content);
  if (!isRecord(document)) {
    throw new ReplayConfigError(
      `Failed to load recordings from ${file}: the file is not a YAML mapping`,
    );
  }
  try {
    const parsed = camelcaseKeys(document, {
      deep: true,
      stopPaths: OPAQUE_PAYLOAD_PATHS,
    });
    return recordingsSchema.parse(parsed);
  } catch (e: unknown) {
    throw new ReplayConfigError(
      `Failed to load recordings from ${file}: ${String(e)}`,
    );
  }
}
