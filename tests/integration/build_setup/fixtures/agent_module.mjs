/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** An ES module agent, loaded by path from the built package. */

import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'built_dist_agent',
  model: 'gemini-2.5-flash',
});
