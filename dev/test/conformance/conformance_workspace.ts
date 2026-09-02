/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LLMRegistry,
  LlmResponse,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Model name the conformance test agents use. It never leaves the process. */
export const STUB_MODEL = 'conformance-stub-model';

/** Responses the stub model yields, in order, one per model call. */
export const scriptedResponses: LlmResponse[] = [];

/** Builds a plain text model response. */
export function textResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

class ScriptedLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    STUB_MODEL,
  ];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const response = scriptedResponses.shift();
    if (!response) {
      throw new Error('ScriptedLlm ran out of scripted responses');
    }
    yield response;
  }

  connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not open live connections');
  }
}

LLMRegistry.register(ScriptedLlm);

/** An agent definition driven by the stub model, with no tools. */
export const AGENT_YAML = `name: my_agent
model: ${STUB_MODEL}
description: Stub agent for the conformance tests
instruction: Answer the user.
`;

/** An agent definition with a long running tool. */
export const TOOL_AGENT_YAML = `name: my_agent
model: ${STUB_MODEL}
description: Stub agent with a long running tool
instruction: Answer the user.
tools:
  - name: LongRunningFunctionTool
    args:
      func: tools_agent_009.tools.ask_for_approval
`;

/** A spec that sends one message and expects one model call. */
export const SINGLE_TURN_SPEC = `description: One turn against the stub model
agent: my_agent
user_messages:
  - text: hello
`;

/**
 * A temporary directory holding agent definitions and test cases, laid out the
 * way the conformance commands expect.
 */
export class ConformanceWorkspace {
  private constructor(
    readonly root: string,
    readonly agentsDir: string,
    readonly testsDir: string,
  ) {}

  static async create(): Promise<ConformanceWorkspace> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-conformance-'));
    return new ConformanceWorkspace(
      root,
      path.join(root, 'agents'),
      path.join(root, 'tests'),
    );
  }

  /** Writes an agent definition that `spec.agent` can name. */
  async writeAgent(agentYaml = AGENT_YAML): Promise<void> {
    const agentDir = path.join(this.agentsDir, 'my_agent');
    await fs.mkdir(agentDir, {recursive: true});
    await fs.writeFile(path.join(agentDir, 'root_agent.yaml'), agentYaml);
  }

  /**
   * Writes a test case spec.
   *
   * @param name Path of the case below the tests directory, `core/case_001`.
   * @returns The absolute directory of the case.
   */
  async writeTestCase(name: string, spec: string): Promise<string> {
    const caseDir = path.join(this.testsDir, ...name.split('/'));
    await fs.mkdir(caseDir, {recursive: true});
    await fs.writeFile(path.join(caseDir, 'spec.yaml'), spec);
    return caseDir;
  }

  async remove(): Promise<void> {
    await fs.rm(this.root, {recursive: true, force: true});
  }
}
