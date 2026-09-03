/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every filesystem call the CLI telemetry path makes, and the one rule they
 * share: none of them throws. Telemetry must never change what the CLI does,
 * so a read-only home directory or a corrupt file becomes a debug log.
 */

import * as fs from 'node:fs';
import {AdkLogger} from '../../utils/logger.js';

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
    logger.debug(`Failed to read ${file}: ${String(error)}`);
    return undefined;
  }
}

/** Removes a path, ignoring any failure. */
export function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, {force: true});
  } catch (error: unknown) {
    logger.debug(`Failed to remove ${target}: ${String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
