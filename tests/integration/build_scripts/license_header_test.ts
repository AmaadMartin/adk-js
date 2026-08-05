/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const dirname = process.cwd();

/**
 * The canonical Apache-2.0 header, anchored to the whole string and exact about
 * whitespace. This mirrors the perl pattern in `scripts/check_license.sh`,
 * which is the source of truth for the header shape. A bash CI script cannot
 * read a TypeScript constant, so the pattern is duplicated rather than shared.
 */
const CANONICAL_HEADER =
  /^\/\*\*\n \* @license\n \* Copyright \d{4} Google LLC\n \* SPDX-License-Identifier: Apache-2\.0\n \*\/\n$/;

const LICENSE_HEADER_TEXT = /const licenseHeaderText = `([\s\S]*?)`;/;

const BUILD_SCRIPTS = [
  'core/build.js',
  'dev/build.js',
  'integrations/build.js',
];

describe('Build script license banner', () => {
  it.each(BUILD_SCRIPTS)(
    '%s defines the canonical Apache-2.0 header',
    async (buildScript: string) => {
      const source = await readFile(path.join(dirname, buildScript), 'utf8');
      // Git checks the build scripts out with CRLF on Windows. The assertion
      // is about the indentation, not the line terminator.
      const match = LICENSE_HEADER_TEXT.exec(source.replaceAll('\r\n', '\n'));

      if (match === null) {
        expect.fail(`${buildScript} does not define licenseHeaderText`);
      }

      expect(match[1]).toMatch(CANONICAL_HEADER);
    },
  );
});
