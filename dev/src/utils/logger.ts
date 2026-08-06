/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ADK CLI logger. Level gating and winston wiring live in the shared
 * implementation in `core`; this alias keeps the dev-package name its call
 * sites already use.
 */
export {WinstonLogger as AdkLogger} from '@google/adk';
