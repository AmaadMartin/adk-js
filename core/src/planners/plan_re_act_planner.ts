/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';

import {BasePlanner} from './base_planner.js';

/** Marks the block where the model writes its plan. */
export const PLANNING_TAG = '/*PLANNING*/';
/** Marks the block where the model writes a revised plan. */
export const REPLANNING_TAG = '/*REPLANNING*/';
/** Marks the block where the model reasons between tool calls. */
export const REASONING_TAG = '/*REASONING*/';
/** Marks the block where the model writes the tool code. */
export const ACTION_TAG = '/*ACTION*/';
/** Marks the block where the model writes the answer for the user. */
export const FINAL_ANSWER_TAG = '/*FINAL_ANSWER*/';

/**
 * The tags that introduce an internal block. `FINAL_ANSWER_TAG` is absent on
 * purpose: the text after it is the answer for the user, not a thought.
 */
const PLANNING_TAGS = [
  PLANNING_TAG,
  REASONING_TAG,
  ACTION_TAG,
  REPLANNING_TAG,
] as const;

/**
 * The Plan-Re-Act planner, which makes the model write a plan before it acts.
 *
 * The planner asks the model to tag each block of its reply, then splits the
 * reply on those tags: the planning and reasoning blocks come back as thought
 * parts, and the block after `FINAL_ANSWER_TAG` comes back as the answer for
 * the user. The model needs no built-in thinking support, so this planner
 * works with any model.
 *
 * A model that ignores the tags returns one untagged text part, which the
 * planner passes through as ordinary output.
 */
export class PlanReActPlanner implements BasePlanner {
  buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return NL_PLANNER_INSTRUCTION;
  }

  processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    if (!responseParts.length) {
      return undefined;
    }

    const preservedParts: Part[] = [];
    let firstFunctionCallIndex = -1;
    for (const [index, responsePart] of responseParts.entries()) {
      if (responsePart.functionCall) {
        if (!responsePart.functionCall.name) {
          continue;
        }
        preservedParts.push(responsePart);
        firstFunctionCallIndex = index;
        break;
      }
      handleNonFunctionCallPart(responsePart, preservedParts);
    }

    // Keep the whole leading group of parallel calls, including a group that
    // starts at index 0.
    if (firstFunctionCallIndex >= 0) {
      for (
        let i = firstFunctionCallIndex + 1;
        i < responseParts.length && responseParts[i].functionCall;
        i++
      ) {
        preservedParts.push(responseParts[i]);
      }
    }

    return preservedParts;
  }
}

/** Removes every planning tag from the text. */
function stripPlanningTags(text: string): string {
  return PLANNING_TAGS.reduce(
    (stripped, tag) => stripped.replaceAll(tag, ''),
    text,
  );
}

/**
 * Marks the part as an internal thought.
 *
 * A part whose text is empty after tag stripping is still a thought, so the
 * guard tests for an absent text rather than for a falsy one.
 */
function markAsThought(responsePart: Part): void {
  if (responsePart.text !== undefined) {
    responsePart.thought = true;
  }
}

/**
 * Splits one text part into the thought blocks and the answer for the user,
 * and appends the result to `preservedParts`.
 */
function handleNonFunctionCallPart(
  responsePart: Part,
  preservedParts: Part[],
): void {
  if (responsePart.text?.includes(FINAL_ANSWER_TAG)) {
    // The last tag is the boundary, so a tag quoted inside the reasoning does
    // not truncate the answer.
    const boundary = responsePart.text.lastIndexOf(FINAL_ANSWER_TAG);
    const reasoningText = stripPlanningTags(
      responsePart.text.slice(0, boundary),
    );
    const finalAnswerText = responsePart.text.slice(
      boundary + FINAL_ANSWER_TAG.length,
    );
    if (reasoningText) {
      // A fresh part, so the signature of the raw text does not travel with
      // the rewritten reasoning.
      const reasoningPart: Part = {text: reasoningText};
      markAsThought(reasoningPart);
      preservedParts.push(reasoningPart);
    }
    if (finalAnswerText) {
      preservedParts.push({text: finalAnswerText});
    }
    return;
  }

  const responseText = responsePart.text ?? '';
  if (PLANNING_TAGS.some((tag) => responseText.startsWith(tag))) {
    responsePart.text = stripPlanningTags(responseText);
    markAsThought(responsePart);
  }
  preservedParts.push(responsePart);
}

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

const TOOL_CODE_PREAMBLE = `
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
 * The planning instruction, copied from adk-python so both SDKs prompt the
 * model with the same text.
 */
const NL_PLANNER_INSTRUCTION = [
  HIGH_LEVEL_PREAMBLE,
  PLANNING_PREAMBLE,
  REASONING_PREAMBLE,
  FINAL_ANSWER_PREAMBLE,
  TOOL_CODE_PREAMBLE,
  USER_INPUT_PREAMBLE,
].join('\n\n');
