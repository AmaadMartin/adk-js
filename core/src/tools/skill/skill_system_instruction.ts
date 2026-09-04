/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LIST_SKILLS_TOOL_NAME,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
  prefixedToolName,
  RUN_SKILL_SCRIPT_TOOL_NAME,
} from './skill_tool_names.js';

/** Options for {@link buildSkillSystemInstruction}. */
export interface SkillSystemInstructionOptions {
  /** Tool name prefix, matching the toolset's. */
  prefix?: string;
  /**
   * Base tool names that survive the toolset's filter. Omit to document every
   * skill tool and forbid none.
   */
  allowedTools?: ReadonlySet<string>;
  /**
   * POSIX path the skill resources are materialized under, when the toolset
   * runs scripts in an environment.
   */
  skillsFolder?: string;
  /**
   * Whether scripts can actually be run. Defaults to `true`. When `false`,
   * `run_skill_script` is not offered to the model either, so advertising it
   * here would promise a capability that always fails.
   */
  scriptExecutionEnabled?: boolean;
}

/**
 * Builds the skill guidance appended to the model's system instruction.
 *
 * The text names the tools the toolset actually exposes: filtered-out tools
 * are listed as forbidden, and the script steps disappear when no backend can
 * run a script.
 */
export function buildSkillSystemInstruction(
  options: SkillSystemInstructionOptions = {},
): string {
  const {prefix, allowedTools, skillsFolder} = options;
  const scriptExecutionEnabled = options.scriptExecutionEnabled ?? true;

  const loadSkill = prefixedToolName(prefix, LOAD_SKILL_TOOL_NAME);
  const loadResource = prefixedToolName(prefix, LOAD_SKILL_RESOURCE_TOOL_NAME);
  const runScript = prefixedToolName(prefix, RUN_SKILL_SCRIPT_TOOL_NAME);

  const scriptsBullet = scriptExecutionEnabled
    ? '- **scripts/** (Optional): Executable scripts that can be run via bash.\n\n'
    : `- **scripts/** (Optional): Scripts bundled with the skill. You cannot run them; use \`${loadResource}\` to read one and follow it yourself.\n\n`;

  const steps: string[] = [
    // adk-python names the argument `skill_name`; the adk-js `load_skill` tool
    // declares it as `name`, and an instruction naming an undeclared parameter
    // is worse than a wording difference from the reference.
    `If a skill seems relevant to the current user query, you MUST use the \`${loadSkill}\` tool with \`name="<SKILL_NAME>"\` to read its full instructions before proceeding.`,
    'Once you have read the instructions, follow them exactly as documented before replying to the user. For example, If the instruction lists multiple steps, please make sure you complete all of them in order.',
    `The \`${loadResource}\` tool is for viewing files within a skill's directory (e.g., \`references/*\`, \`assets/*\`, \`scripts/*\`). It is ONLY for skill-bundled files — do NOT use it to access documents or files provided by the user at runtime. Do NOT use other tools to access skill files.`,
  ];
  if (scriptExecutionEnabled) {
    steps.push(
      `Use \`${runScript}\` to run scripts from a skill's \`scripts/\` directory. Use \`${loadResource}\` to view script content first if needed.`,
    );
  }
  steps.push(
    `If \`${loadResource}\` returns any error, do not retry any path. Report the error to the user and stop.`,
  );
  if (scriptExecutionEnabled) {
    steps.push(
      `If \`${runScript}\` returns an error (for example \`SCRIPT_NOT_FOUND\`), do not retry the same script or guess a different script path. Report the error to the user and stop.`,
    );
  }
  steps.push(
    `Loading a skill only retrieves its instructions; it does NOT complete your turn. After a \`${loadSkill}\` call returns, continue in the SAME turn: call whatever tools the skill's steps require (search, data retrieval, render), then write your reply. Never end your turn with an empty response right after loading a skill.`,
  );
  if (scriptExecutionEnabled && skillsFolder !== undefined) {
    steps.push(
      `NOTE ON ENVIRONMENT EXECUTION: When using \`${runScript}\` with the \`command\` parameter, all skill resources (including scripts and assets) are materialized in the execution environment under \`${skillsFolder}/<skill_name>/\`. Always specify file and script paths relative to or starting with \`${skillsFolder}/<skill_name>/\` (e.g., \`${skillsFolder}/<skill_name>/scripts/<script_name>\`).`,
    );
  }

  let instruction =
    "You can use specialized 'skills' to help you with complex tasks. You MUST use the skill tools to interact with these skills.\n\n" +
    'Skills are folders of instructions and resources that extend your capabilities for specialized tasks. Each skill folder contains:\n' +
    '- **SKILL.md** (required): The main instruction file with skill metadata and detailed markdown instructions.\n' +
    '- **references/** (Optional): Additional documentation or examples for skill usage.\n' +
    '- **assets/** (Optional): Templates, scripts or other resources used by the skill.\n' +
    scriptsBullet +
    'This is very important:\n\n' +
    steps.map((step, i) => `${i + 1}. ${step}\n`).join('');

  if (allowedTools !== undefined) {
    const banned = [
      RUN_SKILL_SCRIPT_TOOL_NAME,
      LOAD_SKILL_RESOURCE_TOOL_NAME,
      LOAD_SKILL_TOOL_NAME,
      LIST_SKILLS_TOOL_NAME,
    ]
      .filter((baseName) => !allowedTools.has(baseName))
      .map((baseName) => `\`${prefixedToolName(prefix, baseName)}\``);
    if (banned.length > 0) {
      instruction +=
        `\n\nNote: The following tools are NOT available: ${banned.join(', ')}.` +
        ' Do NOT call them. After loading a skill (if available), apply' +
        ' its instructions in context and write your final reply as' +
        ' normal model text. Never wrap the user-facing answer inside a' +
        ' tool call.\n';
    }
  }

  return instruction;
}

/** The skill guidance for an unfiltered toolset that can run scripts. */
export const DEFAULT_SKILL_SYSTEM_INSTRUCTION = buildSkillSystemInstruction();
