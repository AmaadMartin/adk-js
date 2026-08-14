/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';

/**
 * Reads an asset that sits next to this module, not next to the agent file.
 * The agent is bundled into a temp directory, so this only resolves when the
 * bundler keeps this module's own `import.meta.url`.
 */
export async function readModelResponse(): Promise<string> {
  const assetUrl = new URL('../model_response.json', import.meta.url);
  const params = JSON.parse(await fs.readFile(assetUrl, 'utf8'));
  return params.message;
}
