/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a real `LiveServerMessage`. The SDK type is a class with `text` and
 * `data` accessors, so an object literal is not assignable to it.
 *
 * `text` and `data` are omitted from the accepted payload because they are
 * getter-only on the class; assigning them would throw at runtime.
 */
export function createLiveServerMessage(
  fields: Partial<Omit<LiveServerMessage, 'text' | 'data'>>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), fields);
}
