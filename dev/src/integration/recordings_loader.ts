/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';
import {isFileExists} from '../utils/file_utils.js';
import {ReplayConfigError} from './replay_errors.js';
import {LlmRecording, Recordings} from './test_types.js';

/** Fixture file names, keyed by the `streaming_mode` a client configures. */
const RECORDINGS_FILE_NAMES: ReadonlyMap<string, string> = new Map([
  [StreamingMode.NONE, 'generated-recordings.yaml'],
  [StreamingMode.SSE, 'generated-recordings-sse.yaml'],
]);

/**
 * Keys whose value is a payload the recorded agent chose, not part of the
 * recordings schema. Their inner keys must survive verbatim: a tool recorded
 * by adk-python with an argument named `user_name` is still `user_name` here.
 */
const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set(['args', 'response']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Converts the snake_case keys of the recordings schema to camelCase, leaving
 * the payloads under {@link OPAQUE_VALUE_KEYS} untouched.
 */
function camelCaseSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelCaseSchemaKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  const converted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const camelKey = toCamelCase(key);
    converted[camelKey] = OPAQUE_VALUE_KEYS.has(camelKey)
      ? nested
      : camelCaseSchemaKeys(nested);
  }
  return converted;
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

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Reads and validates one recordings fixture.
 *
 * @throws ReplayConfigError when the file is missing, unreadable or invalid.
 */
export async function loadRecordings(file: string): Promise<Recordings> {
  if (!(await isFileExists(file))) {
    throw new ReplayConfigError(`Recordings file not found: ${file}`);
  }
  try {
    const content = await fs.readFile(file, 'utf-8');
    const parsed = camelCaseSchemaKeys(yaml.load(content));
    return recordingsSchema.parse(parsed);
  } catch (e: unknown) {
    throw new ReplayConfigError(
      `Failed to load recordings from ${file}: ${describeCause(e)}`,
    );
  }
}
