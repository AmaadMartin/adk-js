#! /usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {createProgram} from './cli/cli.js';
import {installCommandMetrics} from './cli/cli_telemetry.js';

try {
  const program = createProgram();
  installCommandMetrics(program, process.argv.slice(2));
  program.parse(process.argv);
} catch (e) {
  console.error(e);
}
