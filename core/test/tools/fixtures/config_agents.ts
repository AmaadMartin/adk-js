/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '@google/adk';

/** The agent a configuration file references by its fully-qualified name. */
export const weatherAgent = new LlmAgent({
  name: 'weather_agent',
  description: 'Answers questions about the weather.',
});

/** A value that resolves but is not an agent. */
export const notAnAgent = {name: 'weather_agent'};

export default weatherAgent;
