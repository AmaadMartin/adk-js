/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseAgent,
  Context,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  SingleTurnAgentTool,
  TaskAgentTool,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';

import {replyAgent, ScriptedLlm} from '../workflow/test_helpers.js';

const DELEGATION_WARNING =
  '\nIMPORTANT: This tool delegates execution to a specialized agent.' +
  ' Do NOT call this tool in parallel with any other tools.';

/** An agent that records the branch it ran on and emits one output event. */
class EchoAgent extends BaseAgent {
  runCount = 0;
  branches: Array<string | undefined> = [];

  protected async *runAsyncImpl(
    ic: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runCount++;
    this.branches.push(ic.branch);
    yield createEvent({
      author: this.name,
      invocationId: ic.invocationId,
      content: {role: 'model', parts: [{text: 'echo'}]},
      output: 'echoed',
    });
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture never runs live.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/** An agent whose run always fails. */
class FailingAgent extends BaseAgent {
  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture only throws.
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('sub-agent exploded');
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture never runs live.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

interface ToolCallSetup {
  toolContext: Context;
  queue: AsyncQueue<Event>;
  session: Session;
}

function createToolCall(
  agent: BaseAgent,
  options: {
    /** Run without a caller branch, as a root agent's tool call does. */
    rootBranch?: boolean;
    withQueue?: boolean;
    withFunctionCallId?: boolean;
    nodeToolDepth?: number;
  } = {},
): ToolCallSetup {
  const {
    rootBranch = false,
    withQueue = true,
    withFunctionCallId = true,
    nodeToolDepth = 0,
  } = options;
  const queue = new AsyncQueue<Event>();
  const session = createSession({
    id: 'parent-session',
    appName: 'parent-app',
    userId: 'parent-user',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent,
    session,
    pluginManager: new PluginManager([]),
    branch: rootBranch ? undefined : 'parent',
    nodeToolDepth,
  });
  if (withQueue) {
    invocationContext.eventQueue = queue;
  }
  return {
    toolContext: new Context({
      invocationContext,
      functionCallId: withFunctionCallId ? 'fc-1' : undefined,
    }),
    queue,
    session,
  };
}

/** Everything the child pushed onto the invocation's event queue. */
async function drain(queue: AsyncQueue<Event>): Promise<Event[]> {
  queue.close();
  const events: Event[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

/** The text of the user turn the node run recorded in the session. */
function userTurnText(session: Session): string | undefined {
  const userEvent = session.events.find((event) => event.author === 'user');
  return userEvent?.content?.parts?.[0]?.text;
}

describe('SingleTurnAgentTool', () => {
  it('runs the wrapped agent as a child node and returns its output', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext, queue} = createToolCall(agent);

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('echoed');
    expect(agent.runCount).toBe(1);
    expect(agent.branches).toEqual(['parent.echo@fc-1']);

    const events = await drain(queue);
    expect(events).toHaveLength(1);
    expect(events[0].branch).toBe('parent.echo@fc-1');
  });

  it('scopes the branch to the agent name when the caller has no branch', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext} = createToolCall(agent, {rootBranch: true});

    await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(agent.branches).toEqual(['echo@fc-1']);
  });

  it('passes the request argument when the agent declares no input schema', async () => {
    const agent = replyAgent('plain', 'answered', {description: 'plain'});
    const {toolContext, session} = createToolCall(agent);

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'summarize this'},
      toolContext,
    });

    expect(result).toBe('answered');
    expect(userTurnText(session)).toBe('summarize this');
  });

  it('returns a validation failure as text and does not run the agent', async () => {
    const agent = new LlmAgent({
      name: 'typed',
      description: 'needs a query',
      inputSchema: z.object({query: z.string()}),
    });
    const runAsync = vi.spyOn(agent, 'runAsync');
    const {toolContext} = createToolCall(agent);

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {query: 42},
      toolContext,
    });

    expect(result).toEqual(expect.stringContaining('Error validating input:'));
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('passes the parsed value, not the raw args, when a schema validates', async () => {
    const agent = replyAgent('typed', 'answered', {
      description: 'needs a query',
      inputSchema: z.object({query: z.string()}),
    });
    const {toolContext, session} = createToolCall(agent);

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {query: 'hello', unexpected: 'dropped'},
      toolContext,
    });

    expect(result).toBe('answered');
    expect(userTurnText(session)).toBe('{"query":"hello"}');
  });

  it('returns the sub-agent failure as text', async () => {
    const agent = new FailingAgent({name: 'boom', description: 'always fails'});
    const {toolContext} = createToolCall(agent);

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('Error running sub-agent: sub-agent exploded');
  });

  it('returns the missing event queue as text', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext} = createToolCall(agent, {withQueue: false});

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe(
      "Error running sub-agent: Tool 'echo' requires an invocation event " +
        'queue; it must be invoked from an LlmAgent tool-call step.',
    );
    expect(agent.runCount).toBe(0);
  });

  it('returns the missing function-call id as text', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext} = createToolCall(agent, {withFunctionCallId: false});

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe(
      "Error running sub-agent: Tool 'echo' requires a function-call id; " +
        'it must be invoked from an LlmAgent tool-call step.',
    );
    expect(agent.runCount).toBe(0);
  });

  it('returns the depth limit as text at the maximum nesting depth', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext} = createToolCall(agent, {nodeToolDepth: 8});

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe(
      "Error running sub-agent: Tool 'echo': node-tool nesting exceeded 8 " +
        '(possible node -> tool -> node recursion).',
    );
    expect(agent.runCount).toBe(0);
  });

  it('runs one level below the depth limit', async () => {
    const agent = new EchoAgent({name: 'echo', description: 'echoes'});
    const {toolContext} = createToolCall(agent, {nodeToolDepth: 7});

    const result = await new SingleTurnAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('echoed');
  });
});

describe('TaskAgentTool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('declares the default task input when the agent has no input schema', () => {
    const agent = new LlmAgent({name: 'task', description: 'a task agent'});

    expect(new TaskAgentTool({agent})._getDeclaration()).toEqual({
      name: 'task',
      description: `a task agent${DELEGATION_WARNING}`,
      parametersJsonSchema: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description:
              'Detailed instructions or context for the task sub-agent.',
          },
        },
        required: ['request'],
      },
    });
  });

  it("declares the agent's own input schema when it has one", () => {
    const agent = new LlmAgent({
      name: 'task',
      description: 'a task agent',
      inputSchema: z.object({topic: z.string()}),
    });

    const declaration = new TaskAgentTool({agent})._getDeclaration();

    expect(declaration.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {topic: {type: 'string'}},
      required: ['topic'],
    });
    expect(declaration.parameters).toBeUndefined();
  });

  it('trims the description to the warning when the agent has none', () => {
    const agent = new LlmAgent({name: 'task', description: ''});

    expect(new TaskAgentTool({agent})._getDeclaration().description).toBe(
      DELEGATION_WARNING.trim(),
    );
  });

  it('declares a string response json schema off GEMINI_API', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const agent = new LlmAgent({name: 'task', description: 'a task agent'});

    expect(
      new TaskAgentTool({agent})._getDeclaration().responseJsonSchema,
    ).toEqual({type: 'string'});
  });

  it('declares an object response json schema off GEMINI_API with an output schema', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    const agent = new LlmAgent({
      name: 'task',
      description: 'a task agent',
      outputSchema: z.object({answer: z.string()}),
    });

    expect(
      new TaskAgentTool({agent})._getDeclaration().responseJsonSchema,
    ).toEqual({type: 'object'});
  });

  it('declares no response json schema on GEMINI_API', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'false');
    const agent = new LlmAgent({
      name: 'task',
      description: 'a task agent',
      outputSchema: z.object({answer: z.string()}),
    });

    expect(
      new TaskAgentTool({agent})._getDeclaration().responseJsonSchema,
    ).toBeUndefined();
  });

  it('runs the task agent inline and returns its finish_task output', async () => {
    const agent = new LlmAgent({
      name: 'specialist',
      description: 'finishes a task',
      mode: 'task',
      model: new ScriptedLlm([
        {functionCall: {name: 'finish_task', args: {answer: '42'}}},
      ]),
      outputSchema: z.object({answer: z.string()}),
    });
    const {toolContext} = createToolCall(agent);

    const result = await new TaskAgentTool({agent}).runAsync({
      args: {request: 'what is the answer'},
      toolContext,
    });

    expect(result).toEqual({answer: '42'});
  });

  it('returns the task agent failure as text', async () => {
    const agent = new FailingAgent({name: 'boom', description: 'always fails'});
    const {toolContext} = createToolCall(agent);

    const result = await new TaskAgentTool({agent}).runAsync({
      args: {request: 'hello'},
      toolContext,
    });

    expect(result).toBe('Error running sub-agent: sub-agent exploded');
  });
});
