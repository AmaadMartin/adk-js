/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createChoiceOption} from './choice_options.js';

/** How `adk create` expresses the generated root agent. */
export enum AgentType {
  /** A TypeScript or JavaScript module exporting `rootAgent`. */
  CODE = 'CODE',
  /** A declarative agent config. Not supported yet; falls back to `CODE`. */
  CONFIG = 'CONFIG',
}

export const AGENT_TYPE_OPTION = createChoiceOption(
  '--type <string>',
  "EXPERIMENTAL Optional. How to express the new agent. 'CONFIG' is not " +
    "ready for use, so it falls back to 'CODE'.",
  [AgentType.CODE, AgentType.CONFIG],
).default(AgentType.CODE);

/** Narrows an already-validated `--type` value, defaulting to `CODE`. */
export function toAgentType(value: string | undefined): AgentType {
  return value === AgentType.CONFIG ? AgentType.CONFIG : AgentType.CODE;
}
