/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A tool call that reached the API and got an answer. */
export interface DataAgentToolSuccess {
  status: 'SUCCESS';
  response: unknown;
}

/** A tool call that failed. `operation_name` names a mutation still running. */
export interface DataAgentToolError {
  status: 'ERROR';
  error_details: string;
  operation_name?: string;
}

/** What every data agent tool resolves to. No tool throws. */
export type DataAgentToolResult = DataAgentToolSuccess | DataAgentToolError;
