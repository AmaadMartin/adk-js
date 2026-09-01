/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {
  BasePlanner,
  BuildPlanningInstructionParams,
  ProcessPlanningResponseParams,
} from './base_planner.js';

/** Marks the block that holds the initial plan. */
export const PLANNING_TAG = '/*PLANNING*/';

/** Marks the block that holds a revised plan. */
export const REPLANNING_TAG = '/*REPLANNING*/';

/** Marks the block that holds reasoning between tool calls. */
export const REASONING_TAG = '/*REASONING*/';

/** Marks the block that holds tool code. */
export const ACTION_TAG = '/*ACTION*/';

/** Marks the block that holds the final answer. */
export const FINAL_ANSWER_TAG = '/*FINAL_ANSWER*/';

/**
 * The tags that introduce a thought block. `FINAL_ANSWER_TAG` is absent on
 * purpose: it separates thought from answer instead of introducing a thought.
 */
const PLANNING_TAGS = [PLANNING_TAG, REASONING_TAG, ACTION_TAG, REPLANNING_TAG];

const HIGH_LEVEL_PREAMBLE = `
When answering the question, try to leverage the available tools to gather the information instead of your memorized knowledge.

Follow this process when answering the question: (1) first come up with a plan in natural language text format; (2) Then use tools to execute the plan and provide reasoning between tool code snippets to make a summary of current state and next step. Tool code snippets and reasoning should be interleaved with each other. (3) In the end, return one final answer.

Follow this format when answering the question: (1) The planning part should be under ${PLANNING_TAG}. (2) The tool code snippets should be under ${ACTION_TAG}, and the reasoning parts should be under ${REASONING_TAG}. (3) The final answer part should be under ${FINAL_ANSWER_TAG}.
`;

const PLANNING_PREAMBLE = `
Below are the requirements for the planning:
The plan is made to answer the user query if following the plan. The plan is coherent and covers all aspects of information from user query, and only involves the tools that are accessible by the agent. The plan contains the decomposed steps as a numbered list where each step should use one or multiple available tools. By reading the plan, you can intuitively know which tools to trigger or what actions to take.
If the initial plan cannot be successfully executed, you should learn from previous execution results and revise your plan. The revised plan should be under ${REPLANNING_TAG}. Then use tools to follow the new plan.
`;

const REASONING_PREAMBLE = `
Below are the requirements for the reasoning:
The reasoning makes a summary of the current trajectory based on the user query and tool outputs. Based on the tool outputs and plan, the reasoning also comes up with instructions to the next steps, making the trajectory closer to the final answer.
`;

const FINAL_ANSWER_PREAMBLE = `
Below are the requirements for the final answer:
The final answer should be precise and follow query formatting requirements. Some queries may not be answerable with the available tools and information. In those cases, inform the user why you cannot process their query and ask for more information.
`;

/** Only contains the requirements for custom tools/libraries. */
const TOOL_CODE_WITHOUT_PYTHON_LIBRARIES_PREAMBLE = `
Below are the requirements for the tool code:

**Custom Tools:** The available tools are described in the context and can be directly used.
- Code must be valid self-contained Python snippets with no imports and no references to tools or Python libraries that are not in the context.
- You cannot use any parameters or fields that are not explicitly defined in the APIs in the context.
- The code snippets should be readable, efficient, and directly relevant to the user query and reasoning steps.
- When using the tools, you should use the library name together with the function name, e.g., vertex_search.search().
- If Python libraries are not provided in the context, NEVER write your own code other than the function calls using the provided tools.
`;

const USER_INPUT_PREAMBLE = `
VERY IMPORTANT instruction that you MUST follow in addition to the above instructions:

You should ask for clarification if you need more information to answer the question.
You should prefer using the information available in the context instead of repeated tool use.
`;

/**
 * The natural-language planner instruction. Constant, so it is built once.
 * The block layout matches adk-python byte for byte: the instruction is part
 * of the cross-language contract.
 */
const NL_PLANNER_INSTRUCTION = [
  HIGH_LEVEL_PREAMBLE,
  PLANNING_PREAMBLE,
  REASONING_PREAMBLE,
  FINAL_ANSWER_PREAMBLE,
  TOOL_CODE_WITHOUT_PYTHON_LIBRARIES_PREAMBLE,
  USER_INPUT_PREAMBLE,
].join('\n\n');

/**
 * Removes every planning tag from the text.
 *
 * @param text The text to strip.
 * @returns The text with all planning tags removed.
 */
export function stripPlanningTags(text: string): string {
  let stripped = text;
  for (const tag of PLANNING_TAGS) {
    stripped = stripped.replaceAll(tag, '');
  }
  return stripped;
}

/**
 * Handles a part that carries no function call.
 *
 * A part that holds a final-answer tag is split into a thought part and an
 * answer part. A part whose text starts with a planning tag is stripped and
 * marked as a thought in place. Any other part is preserved untouched.
 *
 * @param responsePart The response part to handle.
 * @param preservedParts The mutable list of parts to store the result in.
 */
function handleNonFunctionCallPart(
  responsePart: Part,
  preservedParts: Part[],
): void {
  const text = responsePart.text ?? '';

  if (text && text.includes(FINAL_ANSWER_TAG)) {
    // The answer is whatever follows the last tag; everything before it is
    // reasoning.
    const index = text.lastIndexOf(FINAL_ANSWER_TAG);
    const reasoningText = stripPlanningTags(text.slice(0, index));
    const finalAnswerText = text.slice(index + FINAL_ANSWER_TAG.length);
    if (reasoningText) {
      preservedParts.push({text: reasoningText, thought: true});
    }
    if (finalAnswerText) {
      preservedParts.push({text: finalAnswerText});
    }
    return;
  }

  if (text && PLANNING_TAGS.some((tag) => text.startsWith(tag))) {
    responsePart.text = stripPlanningTags(text);
    responsePart.thought = true;
  }
  preservedParts.push(responsePart);
}

/**
 * Plan-Re-Act planner that constrains the LLM response to generate a plan
 * before any action or observation.
 *
 * This planner does not require the model to support built-in thinking
 * features or a thinking config.
 */
export class PlanReActPlanner extends BasePlanner {
  /**
   * Returns the planning instruction, which is the same on every call and
   * ignores both the context and the request.
   */
  override buildPlanningInstruction(
    _params: BuildPlanningInstructionParams,
  ): string {
    return NL_PLANNER_INSTRUCTION;
  }

  /**
   * Splits the response into thought parts and answer parts, and truncates it
   * at the first group of function calls.
   *
   * Parts that keep their identity are mutated in place: the planner rewrites
   * `text` and sets `thought` on the caller's objects, which is how a part
   * keeps its other metadata such as `thoughtSignature`.
   *
   * @param params The callback context (unused) and the response parts.
   * @returns The processed parts, or undefined when there are no input parts.
   */
  override processPlanningResponse({
    responseParts,
  }: ProcessPlanningResponseParams): Part[] | undefined {
    if (responseParts.length === 0) {
      return undefined;
    }

    const preservedParts: Part[] = [];
    let firstFunctionCallIndex = -1;

    for (let i = 0; i < responseParts.length; i++) {
      const responsePart = responseParts[i];
      const functionCall = responsePart.functionCall;
      if (!functionCall) {
        handleNonFunctionCallPart(responsePart, preservedParts);
        continue;
      }
      // Filter out function calls with empty names, then stop at the first
      // real one.
      if (!functionCall.name) {
        continue;
      }
      preservedParts.push(responsePart);
      firstFunctionCallIndex = i;
      break;
    }

    // Keep the rest of the parallel call group. Unlike the scan above, this
    // loop only tests for a function call, so an empty-named call inside the
    // group survives. adk-python behaves the same way.
    if (firstFunctionCallIndex >= 0) {
      for (let j = firstFunctionCallIndex + 1; j < responseParts.length; j++) {
        if (!responseParts[j].functionCall) {
          break;
        }
        preservedParts.push(responseParts[j]);
      }
    }

    return preservedParts;
  }
}
