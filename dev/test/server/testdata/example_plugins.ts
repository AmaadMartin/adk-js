/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin} from '@google/adk';
import {Content} from '@google/genai';

/**
 * Plugin fixture loaded by `loadExtraPlugins` in the extra-plugin tests.
 *
 * `beforeRunCallback` short-circuits the run with the plugin's own name, which
 * makes both the loading and the naming observable in a `/run` response body.
 */
export class NamePlugin extends BasePlugin {
  override async beforeRunCallback(): Promise<Content> {
    return {parts: [{text: `handled by ${this.name}`}], role: 'model'};
  }
}

/** Pre-built plugin, exported to prove an instance is used as it is. */
export const namedInstance = new NamePlugin('preBuiltInstance');

/** Default export, to prove a bare specifier reads `default`. */
export default new NamePlugin('defaultExport');

/**
 * Plugin fixture that reports how many runs this instance has handled, which
 * tells a shared instance apart from one built per app.
 */
export class CountingPlugin extends BasePlugin {
  private runs = 0;

  override async beforeRunCallback(): Promise<Content> {
    this.runs += 1;

    return {parts: [{text: `run ${this.runs}`}], role: 'model'};
  }
}

/** Export that is neither a plugin class nor a plugin instance. */
export const notAPlugin = {name: 'looksLikeAPluginButIsNot'};
