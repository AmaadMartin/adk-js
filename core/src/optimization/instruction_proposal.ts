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
 * module reimplements that class's `prompt_renderer` and `output_extractor`
 * algorithms. The two prompt
 * templates are verbatim from adk-python: their wording steers the reflection
 * model, so it is behaviour rather than style.
 *
 * Two parts of `InstructionProposalSignature` are left out. It also collects
 * image values and returns an OpenAI-shaped message list; adk-python never
 * reaches that path, because it casts the prompt to a string and sends one
 * text part. Its `validate_prompt_template` and its two `TypeError` guards
 * are unreachable here: this module picks the template itself, from two
 * constants that both carry every placeholder.
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

/** The markdown fence both templates ask the reflection model to answer in. */
const FENCE = '```';

/** The markdown header depth a rendered sample's own keys sit at. */
const SAMPLE_KEY_HEADER_LEVEL = 3;

/** The deepest markdown header level, past which nesting stops indenting. */
const MAX_HEADER_LEVEL = 6;

/** Matches an opening fence and its optional language tag. */
const OPENING_FENCE_PATTERN = /^```\S*\n?/;

/** Matches the language tag on the first line of a fenced block's body. */
const LANGUAGE_TAG_PATTERN = /^\S*\n/;

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
    return SKILL_INSTRUCTION_UPDATER_TEMPLATE.replaceAll(
      SKILL_NAME_PLACEHOLDER,
      () => skillName,
    );
  }
  throw new Error(`Unknown component type for update: ${component}`);
}

/**
 * Renders one reflective-dataset value as markdown.
 *
 * @param value The value to render.
 * @param level The markdown header depth its keys or items sit at.
 */
function renderValue(value: unknown, level: number): string {
  const childLevel = Math.min(level + 1, MAX_HEADER_LEVEL);
  const header = '#'.repeat(level);

  if (Array.isArray(value)) {
    const items = value.map(
      (item, index) =>
        `${header} Item ${index + 1}\n${renderValue(item, childLevel)}`,
    );
    return items.length > 0 ? items.join('') : '\n';
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(
      ([key, child]) => `${header} ${key}\n${renderValue(child, childLevel)}`,
    );
    return entries.length > 0 ? entries.join('') : '\n';
  }
  return `${String(value).trim()}\n\n`;
}

/**
 * Renders the reflective dataset the reflection model reads as markdown.
 *
 * @param dataset The records for one component, in evaluation order.
 */
function renderDataset(dataset: Array<Record<string, unknown>>): string {
  return dataset
    .map((sample, index) => {
      const keys = Object.entries(sample).map(
        ([key, value]) =>
          `## ${key}\n${renderValue(value, SAMPLE_KEY_HEADER_LEVEL)}`,
      );
      return `# Example ${index + 1}\n${keys.join('')}`;
    })
    .join('\n\n');
}

/**
 * Renders the prompt that asks the reflection model to rewrite one component.
 *
 * @param component The component key being rewritten.
 * @param currentText That component's current text.
 * @param dataset The reflective-dataset records for that component.
 * @throws If the component is neither the agent prompt nor a skill, or if the
 *     selected template lacks a placeholder.
 */
export function renderProposalPrompt(
  component: string,
  currentText: string,
  dataset: Array<Record<string, unknown>>,
): string {
  const template = templateFor(component);
  const sideInfo = renderDataset(dataset);
  // The current text is substituted first, so a placeholder the model wrote
  // into the previous instruction is not itself substituted into.
  return template
    .replaceAll(CURRENT_TEXT_PLACEHOLDER, () => currentText)
    .replaceAll(SIDE_INFO_PLACEHOLDER, () => sideInfo);
}

/**
 * Returns the new instruction a reflection reply carries.
 *
 * Both templates ask for the new instructions within ``` blocks, so the reply
 * is read as the span between its first and last fence. A reply that carries
 * no fence, or only one, is returned trimmed rather than rejected: the `gepa`
 * package hands the model's whole answer back in that case.
 *
 * @param lmOutput The reflection model's reply.
 */
export function extractNewInstruction(lmOutput: string): string {
  const start = lmOutput.indexOf(FENCE) + FENCE.length;
  const end = lmOutput.lastIndexOf(FENCE);
  if (start >= end) {
    return extractUnfenced(lmOutput);
  }
  const content = lmOutput.slice(start, end);
  const languageTag = LANGUAGE_TAG_PATTERN.exec(content);
  return (languageTag ? content.slice(languageTag[0].length) : content).trim();
}

/** Reads a reply that carries fewer than two fences. */
function extractUnfenced(lmOutput: string): string {
  const stripped = lmOutput.trim();
  if (stripped.startsWith(FENCE)) {
    // Matched against the raw reply, so a fence behind leading whitespace
    // misses and the reply is returned with its fence. `gepa` does the same.
    const opener = OPENING_FENCE_PATTERN.exec(lmOutput);
    if (opener) {
      return lmOutput.slice(opener[0].length).trim();
    }
  } else if (stripped.endsWith(FENCE)) {
    return stripped.slice(0, -FENCE.length).trim();
  }
  return stripped;
}
