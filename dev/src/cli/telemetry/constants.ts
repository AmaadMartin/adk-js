/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';

const ADK_HOME = path.join(os.homedir(), '.adk');

/** Local file holding the user's CLI preferences, including telemetry consent. */
export const CONFIG_FILE = path.join(ADK_HOME, 'config.json');

/** Local JSONL file where command metric records are queued. */
export const QUEUE_FILE = path.join(ADK_HOME, 'telemetry_queue.jsonl');

/** Local directory mapping terminal parent PIDs to their active sessions. */
export const TELEMETRY_SESSIONS_DIR = path.join(ADK_HOME, 'telemetry_sessions');
