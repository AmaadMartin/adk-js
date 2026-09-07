/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '@google/adk';
import {z} from 'zod';
import {loadFileData} from '../utils/file_utils.js';

/** The JSON document a scripted `adk run` reads its turns from. */
export interface RunInputFile {
  /** Initial session state. */
  state: Record<string, unknown>;
  /** The user turns to send, in order. */
  queries: string[];
}

/** The parts of a `--resume` document that `adk run` replays. */
export interface SavedSession {
  /** State the session carried when it was saved. */
  state: Record<string, unknown>;
  /** The transcript to replay, oldest first. */
  events: Event[];
}

/**
 * Both fields are required, matching adk-python's `InputFile` model, where
 * neither has a default.
 */
const RUN_INPUT_FILE_SCHEMA = z.object({
  state: z.record(z.string(), z.unknown()),
  queries: z.array(z.string()),
});

function isEventObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only the two fields the `--resume` path reads are checked, and event
 * contents are left alone. `--save_session` writes whatever the running ADK
 * version produced, so a full schema would reject a document an older version
 * wrote. Both fields default the way adk-python's `Session` model defaults
 * them.
 */
const SAVED_SESSION_SCHEMA = z.object({
  state: z.record(z.string(), z.unknown()).default({}),
  events: z
    .array(z.custom<Event>(isEventObject, 'expected an event object'))
    .default([]),
});

/** Names the field an issue is about. An empty path means the document itself. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(describeIssue).join('; ');
}

/**
 * Reads a run input file and validates it against {@link RunInputFile}.
 *
 * @param filePath Absolute path of the file to read.
 * @throws Error naming the file and every field that failed, so a typo such as
 *     `query` for `queries` stops the run before the first model call.
 */
export async function loadRunInputFile(
  filePath: string,
): Promise<RunInputFile> {
  const contents = await loadFileData<unknown>(filePath);
  const result = RUN_INPUT_FILE_SCHEMA.safeParse(contents);
  if (!result.success) {
    throw new Error(
      `Invalid run input file ${filePath}: ${describeIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

/**
 * Reads a session saved by `--save_session` and checks the parts `adk run
 * --resume` replays.
 *
 * @param filePath Path of the file to read.
 * @throws Error naming the file and every field that failed, so a document
 *     that is not a session stops the run instead of failing later on
 *     `events is not iterable`.
 */
export async function loadSavedSession(
  filePath: string,
): Promise<SavedSession> {
  const contents = await loadFileData<unknown>(filePath);
  const result = SAVED_SESSION_SCHEMA.safeParse(contents);
  if (!result.success) {
    throw new Error(
      `Invalid saved session file ${filePath}: ${describeIssues(result.error.issues)}`,
    );
  }
  return result.data;
}
