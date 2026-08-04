/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a `LiveServerMessage` carrying only the fields a test cares about.
 *
 * `LiveServerMessage` is a class whose `text` and `data` accessors are declared
 * non-optional, so no object literal can satisfy the type. Assigning onto a
 * real instance keeps those accessors intact instead of casting them away.
 */
export function createLiveServerMessage(
  fields: Omit<Partial<LiveServerMessage>, 'text' | 'data'>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), fields);
}
