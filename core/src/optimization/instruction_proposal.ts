/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The GEPA component vocabulary, the instruction-updater prompts and the
 * reader of the reflection model's reply.
 *
 * adk-python delegates the rendering and the extraction to the `gepa`
 * package's `InstructionProposalSignature`. npm has no equivalent, so this
 * module implements the contract the two prompt templates state. The templates
 * themselves are verbatim from adk-python: their wording steers the reflection
 * model, so it is behaviour rather than style.
 */

/** The GEPA component key holding the root agent's instruction. */
export const AGENT_PROMPT_NAME = 'agent_prompt';

/** The GEPA component key prefix for a skill's instructions. */
export const SKILL_KEY_PREFIX = 'skill_instructions:';

/**
 * Returns the GEPA component key holding a skill's instructions.
 *
 * @param skillName The skill's frontmatter name.
 */
export function skillComponentKey(skillName: string): string {
  return `${SKILL_KEY_PREFIX}${skillName}`;
}

/** Where the current text of a component is substituted into a template. */
const CURRENT_TEXT_PLACEHOLDER = '<curr_param>';

/** Where the component's reflective dataset is substituted into a template. */
const SIDE_INFO_PLACEHOLDER = '<side_info>';

/** Where the skill's name is substituted into the skill template. */
const SKILL_NAME_PLACEHOLDER = '{skill_name}';

/** Indentation of the reflective dataset rendered into a proposal prompt. */
const SIDE_INFO_INDENT = 2;

/** Matches a fenced block, capturing its body. */
const FENCED_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;

const AGENT_PROMPT_UPDATER_TEMPLATE = `I provided an AI agent with the following core instructions:
\`\`\`
${CURRENT_TEXT_PLACEHOLDER}
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
${SIDE_INFO_PLACEHOLDER}
\`\`\`

Your task is to write a new version of the agent core instructions.
During evaluation, the agent may have loaded skills containing additional instructions.
Do NOT include or attempt to fix instructions loaded through skills (instructions for deciding which skills to load are acceptable in the core instructions).
Focus only on the agent's general behavior, reasoning processes, and tool/skill selection.

Read the evaluation data carefully to identify the format of the user input, agent response, and feedback.
Identify any factual information about the task which belongs in the core instructions.
If such information is omitted or incorrect, update the core instructions accordingly.
Unless there are clear contradictions, avoid removing existing information from the core instructions as it may be relevant to other tasks.

Provide the new instructions within \`\`\` blocks.`;

const SKILL_INSTRUCTION_UPDATER_TEMPLATE = `I provided an AI agent with access to a skill named \`${SKILL_NAME_PLACEHOLDER}\` which provides the following skill instructions:
\`\`\`
${CURRENT_TEXT_PLACEHOLDER}
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
${SIDE_INFO_PLACEHOLDER}
\`\`\`

Your task is to write a new version of the skill instructions.
Do NOT include or attempt to fix the agent's core instructions.
If NONE of the evaluation tasks exercised this skill, do not update the skill instructions.
If at least some of the evaluation tasks exercised this skill, then update the skill instructions based on the evaluation data for those tasks.
During evaluation, the agent may have loaded other skills besides this one.
Do NOT include or attempt to fix instructions related to other skills.

Read the evaluation data carefully to identify the format of the user input, agent response, and feedback.
Identify any factual information about the task which belongs in the skill instructions.
If such information is omitted or incorrect, update the skill instructions accordingly.
Unless there are clear contradictions, avoid removing existing information from the skill instructions as it may be relevant to other tasks.
Also note that the eval data may contain multiple copies and different versions of the skill instructions; disregard them and focus on updating the skill instructions provided at the start.

Provide the new instructions within \`\`\` blocks.`;

/** Returns the instruction-updater template a component is rewritten with. */
function templateFor(component: string): string {
  if (component === AGENT_PROMPT_NAME) {
    return AGENT_PROMPT_UPDATER_TEMPLATE;
  }
  if (component.startsWith(SKILL_KEY_PREFIX)) {
    const skillName = component.slice(SKILL_KEY_PREFIX.length);
    return SKILL_INSTRUCTION_UPDATER_TEMPLATE.replace(
      SKILL_NAME_PLACEHOLDER,
      () => skillName,
    );
  }
  throw new Error(`Unknown component type for update: ${component}`);
}

/**
 * Renders the prompt that asks the reflection model to rewrite one component.
 *
 * @param component The component key being rewritten.
 * @param currentText That component's current text.
 * @param dataset The reflective-dataset records for that component.
 * @throws If the component is neither the agent prompt nor a skill.
 */
export function renderProposalPrompt(
  component: string,
  currentText: string,
  dataset: Array<Record<string, unknown>>,
): string {
  return templateFor(component)
    .replace(CURRENT_TEXT_PLACEHOLDER, () => currentText)
    .replace(SIDE_INFO_PLACEHOLDER, () =>
      JSON.stringify(dataset, null, SIDE_INFO_INDENT),
    );
}

/**
 * Returns the last fenced block of a reflection reply, trimmed.
 *
 * Both templates ask for the new instructions within ``` blocks, and the last
 * block is what survives a model that restates the current text first.
 *
 * @param lmOutput The reflection model's reply.
 * @param component The component the reply rewrites, for the error message.
 * @throws If the reply carries no fenced block.
 */
export function extractNewInstruction(
  lmOutput: string,
  component: string,
): string {
  const blocks = [...lmOutput.matchAll(FENCED_BLOCK_PATTERN)];
  const lastBlock = blocks.at(-1);
  if (!lastBlock) {
    throw new Error(
      `The reflection model returned no fenced block for component ` +
        `${component}, so there is no new text to apply.`,
    );
  }
  return lastBlock[1].trim();
}
