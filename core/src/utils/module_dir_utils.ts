/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Resolves the directory of the module that supplied these two locators.
 *
 * A build output defines at most one of them: esbuild rewrites `import.meta`
 * to an empty object in the CommonJS and browser outputs, and leaves
 * `__dirname` undefined in the ECMAScript module output. `moduleUrl` wins
 * because a host can leave a global `__dirname` behind — `node -e` sets it to
 * `.` — which would otherwise resolve against the working directory.
 */
export function resolveModuleDir(
  moduleUrl: string | undefined,
  dirname: string | undefined,
): string {
  if (moduleUrl !== undefined) {
    return path.dirname(fileURLToPath(moduleUrl));
  }
  if (dirname !== undefined) {
    return dirname;
  }
  throw new Error(
    'Cannot resolve the module directory: this build defines neither ' +
      'import.meta.url nor __dirname.',
  );
}
