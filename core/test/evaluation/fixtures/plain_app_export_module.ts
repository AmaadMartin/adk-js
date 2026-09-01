/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An agent module whose `app` export is not an `App`. */

import {LlmAgent} from '@google/adk';

export const app = {name: 'not an adk app'};

export const rootAgent = new LlmAgent({
  name: 'dice_agent',
  model: 'gemini-2.5-flash',
});
