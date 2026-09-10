/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent behind `tests/basic.json`. Replaying that fixture answers every
 * model call from the recording, so this agent never reaches the network.
 */

import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const rollDice = new FunctionTool({
  name: 'roll_dice',
  description: 'Rolls a die with the given number of sides.',
  parameters: z.object({sides: z.number()}),
  execute: ({sides}) => ({rolled: sides}),
});

export const rootAgent = new LlmAgent({
  name: 'dice_agent',
  model: 'gemini-2.5-flash',
  description: 'Rolls a die and reports the result.',
  instruction: 'Roll the die the user asks for, then report what you rolled.',
  tools: [rollDice],
});
