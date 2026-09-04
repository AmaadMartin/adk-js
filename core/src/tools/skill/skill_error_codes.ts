/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error codes reported by the skill tools in their response objects.
 *
 * The string values are part of the model-facing contract: the system
 * instruction names `SCRIPT_NOT_FOUND` directly, and a model is expected to
 * branch on them. They are kept byte-identical to the codes adk-python's
 * `skill_toolset.py` returns, except for `CONFIRMATION_REJECTED`, which
 * belongs to a confirmation gate adk-python does not have.
 */
export enum SkillErrorCode {
  INVALID_ARGUMENTS = 'INVALID_ARGUMENTS',
  MISSING_SKILL_NAME = 'MISSING_SKILL_NAME',
  MISSING_RESOURCE_PATH = 'MISSING_RESOURCE_PATH',
  MISSING_SCRIPT_PATH = 'MISSING_SCRIPT_PATH',
  SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
  REGISTRY_ERROR = 'REGISTRY_ERROR',
  INVALID_RESOURCE_PATH = 'INVALID_RESOURCE_PATH',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_NOT_FOUND_FATAL = 'RESOURCE_NOT_FOUND_FATAL',
  SCRIPT_NOT_FOUND = 'SCRIPT_NOT_FOUND',
  SCRIPT_NOT_FOUND_FATAL = 'SCRIPT_NOT_FOUND_FATAL',
  UNSUPPORTED_SCRIPT_TYPE = 'UNSUPPORTED_SCRIPT_TYPE',
  NO_CODE_EXECUTOR = 'NO_CODE_EXECUTOR',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  CONFIRMATION_REJECTED = 'CONFIRMATION_REJECTED',
  SKILL_SCRIPT_EXECUTION_ERROR = 'SKILL_SCRIPT_EXECUTION_ERROR',
  TOOL_ERROR = 'TOOL_ERROR',
}
