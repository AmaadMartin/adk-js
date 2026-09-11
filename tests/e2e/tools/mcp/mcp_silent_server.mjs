/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A child process that stays alive and never speaks MCP. It stands in for a
 * misconfigured stdio server, so the timeout e2e test can prove that ADK bounds
 * the wait instead of parking the turn on the MCP SDK's own 60s default.
 */

process.stdin.resume();
