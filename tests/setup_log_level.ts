/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '../core/src/utils/logger.js';

// Must run inside the test worker: vitest `globalSetup` executes in the main
// process, and the log level is module-level state a forked worker never
// inherits.
//
// Import the logger module, not the `@google/adk` barrel. A setup file is
// evaluated before the test module, so importing the barrel here caches the
// whole real core graph before a test file's `vi.mock` can replace any of it,
// which breaks mocking in over a hundred suites.
setLogLevel(LogLevel.ERROR);
