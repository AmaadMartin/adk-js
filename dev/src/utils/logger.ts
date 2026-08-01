/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WinstonLogger, WinstonLoggerOptions} from '@google/adk';

/**
 * Options for the ADK CLI logger.
 */
export type AdkLoggerOptions = WinstonLoggerOptions;

/**
 * Logger implementation for the ADK CLI.
 *
 * The level gating and winston wiring live in the shared {@link WinstonLogger};
 * this subclass keeps a stable dev-package name for the call sites that
 * construct it.
 */
export class AdkLogger extends WinstonLogger {}
