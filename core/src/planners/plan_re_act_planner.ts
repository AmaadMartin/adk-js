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

const PLANNING_TAG = '/*PLANNING*/';
const REPLANNING_TAG = '/*REPLANNING*/';
const REASONING_TAG = '/*REASONING*/';
const ACTION_TAG = '/*ACTION*/';
const FINAL_ANSWER_TAG = '/*FINAL_ANSWER*/';

/**
 * The tags that mark a text part as the model's own reasoning.
 *
 * {@link FINAL_ANSWER_TAG} is deliberately absent: a final answer is content
 * for the user, not a thought.
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
 * The plan-then-act system instruction. Assembled once, because it is a fixed
 * string sent on every request the planner takes part in.
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
 * This is presentation cleanup, not sanitisation: the tags are a formatting
 * convention the model may ignore.
 */
function stripPlanningTags(text: string): string {
  let stripped = text;
  for (const tag of PLANNING_TAGS) {
    stripped = stripped.replaceAll(tag, '');
  }
  return stripped;
}

/**
 * Processes one non-function-call part and appends the result to
 * `preservedParts`.
 *
 * A part carrying a final answer is split on the last tag into a new reasoning
 * part and a new answer part. Any other tagged part is stripped and marked in
 * place, so sibling metadata such as `thoughtSignature` survives. A part whose
 * text strips down to the empty string is still a thought.
 */
function handleNonFunctionCallPart(
  responsePart: Part,
  preservedParts: Part[],
): void {
  const responseText = responsePart.text ?? '';
  const finalAnswerIndex = responseText.lastIndexOf(FINAL_ANSWER_TAG);
  if (finalAnswerIndex !== -1) {
    const reasoningText = stripPlanningTags(
      responseText.slice(0, finalAnswerIndex),
    );
    const finalAnswerText = responseText.slice(
      finalAnswerIndex + FINAL_ANSWER_TAG.length,
    );
    if (reasoningText) {
      preservedParts.push({text: reasoningText, thought: true});
    }
    if (finalAnswerText) {
      preservedParts.push({text: finalAnswerText});
    }
    return;
  }

  if (
    responseText &&
    PLANNING_TAGS.some((tag) => responseText.startsWith(tag))
  ) {
    responsePart.text = stripPlanningTags(responseText);
    responsePart.thought = true;
  }
  preservedParts.push(responsePart);
}

/**
 * Plan-Re-Act planner that constrains the LLM response to generate a plan
 * before any action or observation.
 *
 * The planner does not require the model to support built-in thinking
 * features, so it works with a model that has no thinking config.
 */
export class PlanReActPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return NL_PLANNER_INSTRUCTION;
  }

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    if (!responseParts.length) {
      return undefined;
    }

    const preservedParts: Part[] = [];
    let firstFcPartIndex = -1;
    for (let i = 0; i < responseParts.length; i++) {
      const responsePart = responseParts[i];
      const functionCall = responsePart.functionCall;
      // Stop at the first group of function calls.
      if (functionCall) {
        if (!functionCall.name) {
          continue;
        }
        preservedParts.push(responsePart);
        firstFcPartIndex = i;
        break;
      }
      handleNonFunctionCallPart(responsePart, preservedParts);
    }

    if (firstFcPartIndex >= 0) {
      for (let j = firstFcPartIndex + 1; j < responseParts.length; j++) {
        if (!responseParts[j].functionCall) {
          break;
        }
        preservedParts.push(responseParts[j]);
      }
    }

    return preservedParts;
  }
}
