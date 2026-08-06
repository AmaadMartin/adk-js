/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a {@link LiveServerMessage} fixture.
 *
 * `text` and `data` are getters on the class, so a plain object literal is not
 * assignable to {@link LiveServerMessage}. Assigning onto a real instance keeps
 * them on the prototype.
 */
export function createLiveServerMessage(
  init: Omit<LiveServerMessage, 'text' | 'data'>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), init);
}
