/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * The data fields of a {@link LiveServerMessage}.
 */
type LiveServerMessageInit = Omit<LiveServerMessage, 'text' | 'data'>;

/**
 * Builds a {@link LiveServerMessage} fixture.
 *
 * `text` and `data` are getters on the class, so a plain object literal is not
 * assignable to {@link LiveServerMessage}. Assigning onto a real instance keeps
 * them on the prototype.
 */
export function createLiveServerMessage(
  init: LiveServerMessageInit,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), init);
}
