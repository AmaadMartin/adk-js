/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LocalEnvironment,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Skill,
  SkillToolset,
  createEvent,
  createSession,
  getFunctionCalls,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';

const SKILL: Skill = {
  frontmatter: {name: 'word-count', description: 'Counts words'},
  instructions: 'Run the counter.',
  resources: {
    references: {'notes.md': 'alpha beta gamma'},
    scripts: {'count.js': {src: "console.log('counted');"}},
  },
};

// Run through the Node binary running the test: `LocalEnvironment` spawns
// through the platform shell, and `cmd.exe` on Windows has no `sh`.
const COMMAND = `"${process.execPath}" skills/word-count/scripts/count.js`;

const SCRIPT_CALL: FunctionCall = {
  id: 'orig-1',
  name: 'run_skill_script',
  args: {
    skill_name: 'word-count',
    script_path: 'count.js',
    command: COMMAND,
  },
};

/** A model that asks for the script once, then says it is finished. */
class ScriptCallingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  /** Whether the environment was up each time the model was called. */
  readonly environmentUp: boolean[] = [];
  private turn = 0;

  constructor(private readonly environment: LocalEnvironment) {
    super({model: 'script-calling-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    this.environmentUp.push(this.environment.isInitialized);
    if (this.turn++ === 0) {
      yield {
        content: {role: 'model', parts: [{functionCall: SCRIPT_CALL}]},
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('SkillToolset driven by a Runner', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill_runner_'));
  });

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true});
  });

  function createAgent(environment: LocalEnvironment): LlmAgent {
    return new LlmAgent({
      name: 'skill_agent',
      model: new ScriptCallingLlm(environment),
      tools: [new SkillToolset([SKILL], {environment})],
    });
  }

  it('brings the environment up and tells the model where the skills are', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    const agent = createAgent(environment);
    const model = agent.model as ScriptCallingLlm;
    const runner = new InMemoryRunner({agent, appName: 'app'});
    const session = await runner.sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {parts: [{text: 'count the words'}]},
    })) {
      events.push(event);
    }

    // The environment is up before the model is asked for anything. The
    // runner closes the toolset when the invocation ends, so reading the flag
    // after the loop would report the shutdown instead.
    expect(model.environmentUp).toEqual([true]);

    const instruction = model.requests[0].config?.systemInstruction;
    expect(instruction).toContain('run_skill_script');
    expect(instruction).toContain(path.posix.join(workspace, 'skills'));

    // The command is held: the run asks the client to approve it.
    const confirmationCalls = events
      .flatMap((event) => getFunctionCalls(event))
      .filter((call) => call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
    expect(confirmationCalls).toHaveLength(1);
  });

  it('runs the command when the client approves the pinned call', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    await environment.initialize();
    const agent = createAgent(environment);
    const events = [
      createEvent({
        invocationId: 'inv-1',
        author: 'skill_agent',
        content: {role: 'model', parts: [{functionCall: SCRIPT_CALL}]},
      }),
      createEvent({
        invocationId: 'inv-1',
        author: 'skill_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'confirm-1',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {originalFunctionCall: SCRIPT_CALL},
              },
            },
          ],
        },
        longRunningToolIds: ['confirm-1'],
      }),
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'confirm-1',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                response: {confirmed: true, hint: ''},
              },
            },
          ],
        },
      }),
    ];

    const out = await resume(agent, events);

    expect(out).toHaveLength(1);
    const response = out[0].content?.parts?.[0].functionResponse;
    expect(response?.id).toBe('orig-1');
    expect(response?.response).toMatchObject({exit_code: 0, timed_out: false});
    // Trimmed: Windows ends the line with a carriage return as well.
    expect(String(response?.response?.['stdout']).trim()).toBe('counted');
    expect(
      await fs.readFile(
        path.join(workspace, 'skills/word-count/scripts/count.js'),
        'utf8',
      ),
    ).toBe("console.log('counted');");
  });

  it('refuses the command when the client denies the pinned call', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    await environment.initialize();
    const agent = createAgent(environment);

    const out = await resume(agent, [
      createEvent({
        invocationId: 'inv-1',
        author: 'skill_agent',
        content: {role: 'model', parts: [{functionCall: SCRIPT_CALL}]},
      }),
      createEvent({
        invocationId: 'inv-1',
        author: 'skill_agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'confirm-1',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {originalFunctionCall: SCRIPT_CALL},
              },
            },
          ],
        },
        longRunningToolIds: ['confirm-1'],
      }),
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'confirm-1',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                response: {confirmed: false, hint: ''},
              },
            },
          ],
        },
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].content?.parts?.[0].functionResponse?.response).toEqual({
      error: 'Skill script command was not confirmed and was rejected.',
      error_code: 'CONFIRMATION_REJECTED',
      errorCode: 'CONFIRMATION_REJECTED',
    });
    // Nothing ran and nothing was written.
    await expect(
      fs.access(path.join(workspace, 'skills/word-count/scripts/count.js')),
    ).rejects.toThrow();
  });
});

/** Replays the approval the same way the framework does on the next turn. */
async function resume(agent: LlmAgent, events: Event[]): Promise<Event[]> {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session: createSession({id: 's1', appName: 'app', userId: 'u1', events}),
    pluginManager: new PluginManager([]),
  });

  const out: Event[] = [];
  for await (const event of REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR.runAsync(
    invocationContext,
  )) {
    out.push(event);
  }
  return out;
}
