/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synchronous filesystem reads that never throw.
 *
 * For a caller that runs alongside another job and must not disturb it: a
 * missing, unreadable or corrupt file is an ordinary outcome here, reported as
 * `undefined` and a debug line rather than as an error.
 */

import * as fs from 'node:fs';
import {AdkLogger} from './logger.js';
import {isRecord, toMessage} from './value_utils.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

/**
 * Reads a JSON object from disk. Returns `undefined` when the file is missing,
 * unreadable, not valid JSON, or holds anything other than a JSON object.
 */
export function readJsonObject(
  file: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error: unknown) {
    logger.debug(`Failed to read ${file}: ${toMessage(error)}`);
    return undefined;
  }
}

/** Removes a path, ignoring any failure. */
export function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, {force: true});
  } catch (error: unknown) {
    logger.debug(`Failed to remove ${target}: ${toMessage(error)}`);
  }
}
