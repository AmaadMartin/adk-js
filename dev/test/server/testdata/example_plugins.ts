/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Plugins named by fully-qualified name in `extra_plugins_test.ts`. */

import {BasePlugin} from '@google/adk';

/** A plugin class, which the loader constructs from the qualified name. */
export class ExamplePlugin extends BasePlugin {}

/** A plugin instance, which the loader uses as it stands. */
export const examplePluginInstance = new ExamplePlugin('configured-name');

/** Neither a plugin nor a plugin class, so the loader skips it. */
export const notAPlugin = {name: 'not-a-plugin'};
