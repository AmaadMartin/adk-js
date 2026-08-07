/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a real `LiveServerMessage`.
 *
 * `LiveServerMessage` is a class with `text` and `data` accessors, so a plain
 * object literal is never assignable to it. `text` and `data` are excluded from
 * the accepted payload because they are getter-only on the class.
 */
export function createLiveServerMessage(
  fields: Partial<Omit<LiveServerMessage, 'text' | 'data'>>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), fields);
}
