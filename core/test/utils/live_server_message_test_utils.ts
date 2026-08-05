/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/** The assignable fields of {@link LiveServerMessage}. */
export type LiveServerMessageFields = Omit<LiveServerMessage, 'text' | 'data'>;

/**
 * Builds a real {@link LiveServerMessage} from the given wire fields.
 *
 * `LiveServerMessage` is a class whose `text` and `data` accessors are
 * getter-only, so an object literal is not assignable to it; tests must
 * construct an instance.
 */
export function createLiveServerMessage(
  fields: Partial<LiveServerMessageFields>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), fields);
}
