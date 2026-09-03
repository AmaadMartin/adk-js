#! /usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {createProgram} from './cli/cli.js';
import {instrumentCommandMetrics} from './cli/telemetry/command_metrics.js';

try {
  const program = createProgram();
  instrumentCommandMetrics(program, process.argv.slice(2));
  program.parse(process.argv);
} catch (e) {
  console.error(e);
}
