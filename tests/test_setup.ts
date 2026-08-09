/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '../core/src/utils/logger.js';

// Runs inside each Vitest worker. The level lives in module state, so a
// `globalSetup` file — which runs in the main process, against a different copy
// of the module — cannot reach the code under test.
//
// Import the logger module directly, never the `@google/adk` barrel: a setup
// file that pulls in the whole core graph evaluates those modules before a test
// file's `vi.mock` factories are registered, and the mocks stop applying.
setLogLevel(LogLevel.ERROR);
