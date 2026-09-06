/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {asRecord} from '../../utils/error_utils.js';
import {SkillErrorCode} from './skill_error_codes.js';

/**
 * Reports the error type a skill tool's response carries, or `undefined` when
 * it carries none.
 *
 * The skill tools report a failure as a response object rather than by
 * throwing, so nothing else can tell a failed call from a successful one.
 * `run_skill_script_tool.ts` writes `errorCode` while its siblings write
 * `error_code`; both are read here so the contract does not depend on which.
 */
export function detectSkillToolError(response: unknown): string | undefined {
  const record = asRecord(response);
  if (!record?.['error']) {
    return undefined;
  }
  const errorCode = record['error_code'] ?? record['errorCode'];
  return typeof errorCode === 'string' && errorCode
    ? errorCode
    : SkillErrorCode.TOOL_ERROR;
}
