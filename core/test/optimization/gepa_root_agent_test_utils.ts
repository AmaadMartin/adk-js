/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSkillToolset,
  LlmAgent,
  SkillToolset,
  type ReflectionLm,
  type Skill,
} from '@google/adk';
import * as os from 'node:os';
import * as path from 'node:path';
import {expect} from 'vitest';

/** The starting instruction of every agent these suites build. */
export const INITIAL_INSTRUCTION = 'Initial instruction';

/**
 * Builds a skill.
 *
 * @param name The skill's frontmatter name, which its component key carries.
 * @param instructions The skill's instructions.
 */
export function createSkill(name: string, instructions: string): Skill {
  return {
    frontmatter: {name, description: `The ${name} skill.`},
    instructions,
  };
}

/**
 * Builds an agent over the given tools.
 *
 * @param tools The agent's tools, if any.
 * @param instruction The agent's instruction. Defaults to
 *     {@link INITIAL_INSTRUCTION}.
 */
export function createAgent(
  tools: LlmAgent['tools'] = [],
  instruction: LlmAgent['instruction'] = INITIAL_INSTRUCTION,
): LlmAgent {
  return new LlmAgent({name: 'support_agent', instruction, tools});
}

/**
 * Returns the one skill toolset among an agent's tools.
 *
 * @param agent The agent to read the toolset from.
 */
export function onlySkillToolset(agent: LlmAgent): SkillToolset {
  const toolsets = agent.tools.filter(isSkillToolset);
  expect(toolsets).toHaveLength(1);
  return toolsets[0];
}

/** A reflection model that records every prompt and replies from a script. */
export class RecordingReflectionLm {
  /** Every prompt the adapter sent, in order. */
  readonly prompts: string[] = [];

  private index = 0;

  constructor(private readonly replies: string[]) {}

  /** The {@link ReflectionLm} to hand the adapter. */
  readonly respond: ReflectionLm = async (prompt: string) => {
    this.prompts.push(prompt);
    expect(this.index).toBeLessThan(this.replies.length);
    return this.replies[this.index++];
  };
}

/**
 * Returns an absolute script-output directory valid on every platform.
 *
 * `SkillToolset.getScriptOutputDir` resolves the configured directory, so a
 * POSIX literal such as `/tmp/output` comes back as `C:\tmp\output` on Windows.
 *
 * @param name The directory name under the OS temp directory.
 */
export function scriptOutputDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

/** Wraps `text` in a fenced block, the shape both templates ask for. */
export function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}
