/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '../core/src/utils/logger.js';

// Must run inside the test worker: vitest `globalSetup` executes in the main
// process, and the log level is module-level state a worker never inherits.
//
// Import the logger module directly, not the `@google/adk` barrel. Only the
// per-project `alias` maps that specifier to `core/src`; from here it resolves
// through the workspace symlink to the built `core/dist` bundle, which is a
// second module instance with its own log level (and need not exist yet).
setLogLevel(LogLevel.ERROR);
