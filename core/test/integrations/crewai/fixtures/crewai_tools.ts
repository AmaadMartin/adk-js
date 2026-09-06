/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `CrewaiTool.fromConfig` imports by path, standing in for
 * the user code an agent config file names.
 */

import {z} from 'zod';

/** A CrewAI-shaped tool, resolved by name in the tests. */
export const searchTool = {
  name: 'search',
  description: 'Searches the web',
  argsSchema: z.object({query: z.string()}),
  run: ({query}: {query: string}) => `hit: ${query}`,
};

/** A tool-shaped object with no name, so a config must supply one. */
export const unnamedTool = {
  description: 'Has no name of its own',
  run: (args: unknown) => args,
};

/** A tool whose own name has spaces, which a declaration cannot carry. */
export const spacedTool = {
  name: 'Serper Dev Tool',
  description: 'Search the internet with Serper',
  run: (args: unknown) => args,
};

/** A value that is not an object, so the type guard must reject it. */
export const notATool = 42;

/** `typeof null` is `'object'`, so the guard needs its own null check. */
export const nullTool = null;

/** An object with a `name` but no `run`, which is also not tool-shaped. */
export const toolWithoutRun = {name: 'impostor'};

/** An object whose `run` is not callable. */
export const nonCallableRun = {name: 'impostor', run: 'not a function'};

export default searchTool;
