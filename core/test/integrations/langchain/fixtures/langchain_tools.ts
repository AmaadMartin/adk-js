/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `LangchainTool.fromConfig` imports by path, standing in
 * for the user code an agent config file names.
 */

import {tool} from '@langchain/core/tools';
import {z} from 'zod';

/** A real LangChain tool, resolved by name in the tests. */
export const searchTool = tool(({query}: {query: string}) => `hit: ${query}`, {
  name: 'search',
  description: 'Searches the web',
  schema: z.object({query: z.string()}),
});

/** A tool-shaped object with no name, so a config must supply one. */
export const unnamedTool = {
  description: 'Has no name of its own',
  invoke: (input: unknown) => input,
};

/** A value that is not an object, so the type guard must reject it. */
export const notATool = 42;

/** `typeof null` is `'object'`, so the guard needs its own null check. */
export const nullTool = null;

/** An object with a `name` but no `invoke`, which is also not tool-shaped. */
export const toolWithoutInvoke = {name: 'impostor'};

/** An object whose `invoke` is not callable. */
export const nonCallableInvoke = {name: 'impostor', invoke: 'not a function'};

export default searchTool;
