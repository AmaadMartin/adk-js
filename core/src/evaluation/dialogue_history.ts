/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Flattening a conversation into the plain-text transcript a multi-turn judge
 * prompt carries.
 */

import {Part} from '@google/genai';
import {Invocation, isInvocationEvents} from './eval_case.js';
import {getTextFromContent} from './evaluator.js';

/** The conversation context the multi-turn judge prompt carries. */
export interface DialogueHistory {
  /** The flattened transcript, one line per user turn, agent turn or tool step. */
  dialogue: string;

  /** The instructions of every agent named in the invocations, de-duplicated. */
  instructions: string;

  /** The tool declarations of every agent, de-duplicated. */
  tools: string;
}

/** The author a final response is attributed to when no event names one. */
const DEFAULT_AGENT_NAME = 'agent';

/**
 * Renders a value the way Python's `json.dumps` does by default: on one line,
 * with a space after each `:` and `,`. The reference builds the tool-call and
 * tool-output lines of the transcript this way, and the transcript is text a
 * judge model reads.
 */
function toPythonJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/,\n\s*/g, ', ')
    .replace(/\n\s*/g, '');
}

/** Returns the transcript lines one part contributes, if any. */
function toolLinesOf(part: Part, role: string, turn: number): string[] {
  const lines: string[] = [];
  const {functionCall, functionResponse} = part;
  if (functionCall) {
    const args = functionCall.args ? toPythonJson(functionCall.args) : '{}';
    lines.push(
      `${role} TURN ${turn} (tool call): ${functionCall.name}(${args})`,
    );
  }
  if (functionResponse) {
    const response = functionResponse.response
      ? toPythonJson(functionResponse.response)
      : '{}';
    lines.push(
      `${role} TURN ${turn} (tool output): ${functionResponse.name} -> ${response}`,
    );
  }
  return lines;
}

/** Returns the transcript lines one invocation's intermediate events add. */
function eventLines(invocation: Invocation, turn: number): string[] {
  const intermediateData = invocation.intermediateData;
  if (!isInvocationEvents(intermediateData)) {
    return [];
  }

  const lines: string[] = [];
  for (const event of intermediateData.invocationEvents) {
    const role =
      event.author?.toLowerCase() === 'user'
        ? 'USER'
        : `AGENT (${event.author})`;
    const text = getTextFromContent(event.content, ' ');
    if (text) {
      lines.push(`${role} TURN ${turn}: ${text}`);
    }
    for (const part of event.content?.parts ?? []) {
      lines.push(...toolLinesOf(part, role, turn));
    }
  }
  return lines;
}

/** Returns the author the invocation's final response is attributed to. */
function finalResponseAuthor(invocation: Invocation): string {
  const intermediateData = invocation.intermediateData;
  if (
    isInvocationEvents(intermediateData) &&
    intermediateData.invocationEvents.length > 0
  ) {
    return intermediateData.invocationEvents[0].author;
  }
  return DEFAULT_AGENT_NAME;
}

/** Returns the transcript lines one invocation contributes, in order. */
function invocationLines(invocation: Invocation, turn: number): string[] {
  const lines: string[] = [];

  // A single space, not a newline: the transcript is one line per turn, and
  // the two runtimes have to build byte-identical judge prompts.
  const userText = getTextFromContent(invocation.userContent, ' ');
  if (userText) {
    lines.push(`USER TURN ${turn}: ${userText}`);
  }

  lines.push(...eventLines(invocation, turn));

  const finalText = getTextFromContent(invocation.finalResponse, ' ');
  if (finalText) {
    const author = finalResponseAuthor(invocation);
    lines.push(`AGENT (${author}) TURN ${turn}: ${finalText}`);
  }

  return lines;
}

/** Returns the instruction blocks the invocations declare, in order. */
function instructionBlocks(invocations: Invocation[]): string[] {
  return invocations.flatMap((invocation) =>
    Object.entries(invocation.appDetails?.agentDetails ?? {}).map(
      // adk-python's model defaults `instructions` to an empty string; the
      // adk-js field is optional, so an agent that sets none renders blank.
      ([agentId, details]) =>
        `Agent ${agentId} Instructions:\n${details.instructions ?? ''}`,
    ),
  );
}

/** Returns the tool blocks the invocations declare, in order. */
function toolBlocks(invocations: Invocation[]): string[] {
  const blocks: string[] = [];
  for (const invocation of invocations) {
    for (const [agentId, details] of Object.entries(
      invocation.appDetails?.agentDetails ?? {},
    )) {
      blocks.push(`Agent: ${agentId}`);
      for (const tool of details.toolDeclarations ?? []) {
        // adk-python iterates `function_declarations` unguarded and raises on
        // a tool that declares none; a tool may legitimately declare none.
        for (const declaration of tool.functionDeclarations ?? []) {
          blocks.push(`- ${declaration.name}: ${declaration.description}`);
        }
      }
    }
  }
  return blocks;
}

/**
 * Flattens a conversation into the transcript, instructions and tool
 * declarations the multi-turn judge prompt carries.
 *
 * Turn numbers are 1-based, and every line of one invocation carries that
 * invocation's turn number. Instructions and tool declarations are collected
 * from every invocation's `appDetails` and de-duplicated, keeping first-seen
 * order.
 */
export function assembleDialogueHistory(
  invocations: Invocation[],
): DialogueHistory {
  const lines = invocations.flatMap((invocation, index) =>
    invocationLines(invocation, index + 1),
  );

  return {
    dialogue: lines.join('\n'),
    instructions: [...new Set(instructionBlocks(invocations))].join('\n\n'),
    tools: [...new Set(toolBlocks(invocations))].join('\n'),
  };
}
