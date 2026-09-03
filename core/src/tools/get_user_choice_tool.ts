/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import type {Context} from '../agents/context.js';
import {LongRunningFunctionTool} from './long_running_tool.js';

/**
 * Presents a list of options to the user and asks them to choose one.
 *
 * Sets `skipSummarization` on the tool context's actions and returns `null`,
 * leaving the function call pending. The long-running mechanism later resumes
 * the call with the user's selected option supplied as the function response.
 *
 * @param input The tool arguments containing the `options` to present.
 * @param toolContext The current tool context, supplied by the framework at
 *     runtime.
 * @returns `null`, leaving the long-running call pending.
 */
export function getUserChoice(
  input: {options: string[]},
  toolContext?: Context,
): null {
  if (toolContext) {
    toolContext.actions.skipSummarization = true;
  }
  return null;
}

/**
 * Built-in long-running tool that presents choices to the user and pauses for
 * their selection.
 */
export const getUserChoiceTool = new LongRunningFunctionTool({
  name: 'get_user_choice',
  description: 'Provides the options to the user and asks them to choose one.',
  parameters: z.object({
    options: z
      .array(z.string())
      .describe('List of options to present to the user.'),
  }),
  execute: getUserChoice,
});
