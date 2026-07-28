/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a real {@link LiveServerMessage} instance from a partial payload.
 *
 * `LiveServerMessage` is a class whose `text`/`data` accessors make a plain
 * object literal unassignable to it, so tests construct an actual instance and
 * copy the payload fields onto it.
 */
export function liveServerMessage(
  data: Partial<LiveServerMessage>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), data);
}
