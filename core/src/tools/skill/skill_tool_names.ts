/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Base name of the tool that lists the locally configured skills. */
export const LIST_SKILLS_TOOL_NAME = 'list_skills';
/** Base name of the tool that searches a skill registry. */
export const SEARCH_SKILLS_TOOL_NAME = 'search_skills';
/** Base name of the tool that loads a skill's instructions. */
export const LOAD_SKILL_TOOL_NAME = 'load_skill';
/** Base name of the tool that reads a file bundled with a skill. */
export const LOAD_SKILL_RESOURCE_TOOL_NAME = 'load_skill_resource';
/** Base name of the tool that runs a script bundled with a skill. */
export const RUN_SKILL_SCRIPT_TOOL_NAME = 'run_skill_script';
/** Base name of the adk-js-only tool that runs a model-provided script. */
export const RUN_SKILL_INLINE_SCRIPT_TOOL_NAME = 'run_skill_inline_script';

/** Renders a base tool name with `prefix`, as the toolset names its tools. */
export function prefixedToolName(
  prefix: string | undefined,
  baseName: string,
): string {
  return prefix ? `${prefix}_${baseName}` : baseName;
}
