/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Running a Google Antigravity agent as an ADK agent.
 *
 * `AntigravityAgent` delegates each ADK turn to an Antigravity harness and
 * streams the harness's trajectory steps back as ADK events. `@google/adk`
 * takes no dependency on an Antigravity SDK: you pass an `agentFactory` that
 * returns any object shaped like `SdkAgent`.
 *
 * No Antigravity SDK is published for JavaScript, so this sample supplies a
 * small in-file stand-in and runs offline. A real `agentFactory` returns the
 * client's own agent for the config it is handed, for example
 * `(config) => new AntigravityClient(config)`.
 *
 * The tree shows both roles. The root agent has no `mode`, so it owns the
 * conversation. Its ADK child sets `mode: 'single_turn'`, which is what lets an
 * `AntigravityAgent` have a parent at all, and reaches the harness as a
 * client-side tool named after the child.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/labs/antigravity/agent.ts
 */

import {
  AntigravityAgent,
  AntigravityAgentConfig,
  AntigravityStep,
  AntigravityTool,
  PostToolCallHook,
  SdkAgent,
  SdkConversation,
} from '@google/adk';

const CLIENT_CALL_ID = 'call_1';

/**
 * The trajectories this stand-in has kept, keyed by conversation id.
 *
 * A real local harness keeps them under `saveDir`, and that is what lets a
 * later turn resume an earlier conversation. Modelling it matters: the wrapper
 * reads an empty history after a resume as the harness having silently dropped
 * the conversation, and fails the turn. A config with no `saveDir` gets nothing
 * back here, which is the forgetful setup the wrapper warns about.
 */
const savedTrajectories = new Map<string, AntigravityStep[]>();

/** The steps this conversation already holds, from the turns before it. */
function loadTrajectory(
  config: AntigravityAgentConfig,
  conversationId: string,
): AntigravityStep[] {
  if (!config.saveDir) {
    return [];
  }
  let steps = savedTrajectories.get(conversationId);
  if (!steps) {
    steps = [];
    savedTrajectories.set(conversationId, steps);
  }
  return steps;
}

/** The client tools the harness was given, i.e. the bridged ADK children. */
function clientTools(config: AntigravityAgentConfig): AntigravityTool[] {
  return (config.tools ?? []).filter(
    (tool): tool is AntigravityTool => typeof tool !== 'string',
  );
}

/** The hooks the wrapper registered to collect client-tool outcomes. */
function postToolCallHooks(config: AntigravityAgentConfig): PostToolCallHook[] {
  return (config.hooks ?? []).filter(
    (hook): hook is PostToolCallHook => hook.kind === 'post_tool_call',
  );
}

/**
 * A conversation that calls the first bridged child, then answers.
 *
 * A real harness decides for itself whether to call a tool; this one always
 * does, so the sample shows the whole round trip.
 */
class StandInConversation implements SdkConversation {
  private prompt = '';

  constructor(
    private readonly config: AntigravityAgentConfig,
    readonly history: AntigravityStep[],
  ) {}

  async send(prompt: string): Promise<void> {
    this.prompt = prompt;
  }

  async *receiveSteps(): AsyncGenerator<AntigravityStep> {
    const tool = clientTools(this.config)[0];
    if (tool) {
      yield this.record({
        stepIndex: 0,
        source: 'MODEL',
        type: 'TOOL_CALL',
        status: 'ACTIVE',
        toolCalls: [
          {name: tool.name, args: {request: this.prompt}, id: CLIENT_CALL_ID},
        ],
      });
      // A client tool's outcome never reaches the trajectory: the harness
      // reports it on the post-tool-call hook, and the wrapper pairs it with
      // the call to emit the ADK function response.
      const answer = await tool.run(this.prompt);
      for (const hook of postToolCallHooks(this.config)) {
        await hook.run({name: tool.name, id: CLIENT_CALL_ID, result: answer});
      }
      // The terminal step for a client tool carries no `toolCalls`.
      yield this.record({
        stepIndex: 0,
        source: 'MODEL',
        type: 'TOOL_CALL',
        status: 'DONE',
        content: `Calling custom tool "${tool.name}"`,
        toolCalls: [],
      });
    }

    yield this.record({
      stepIndex: 1,
      source: 'MODEL',
      type: 'TEXT_RESPONSE',
      status: 'DONE',
      isCompleteResponse: true,
      content: `Reviewed the workspace. You asked: ${this.prompt}`,
    });
  }

  private record(step: AntigravityStep): AntigravityStep {
    this.history.push(step);
    return step;
  }
}

/** A stand-in for the Antigravity agent one ADK turn runs on. */
class StandInAgent implements SdkAgent {
  readonly conversation: StandInConversation;
  readonly conversationId: string;

  constructor(config: AntigravityAgentConfig) {
    // A real client mints an id, or reuses `config.conversationId` on a resume.
    this.conversationId = config.conversationId ?? 'sample-conversation-000000';
    this.conversation = new StandInConversation(
      config,
      loadTrajectory(config, this.conversationId),
    );
  }

  async connect(): Promise<SdkAgent> {
    return this;
  }

  async close(): Promise<void> {}
}

/**
 * An ADK child, reached by the harness as a client-side tool.
 *
 * `mode: 'single_turn'` is what allows an `AntigravityAgent` to have a parent.
 * Each call is an independent conversation: no session history is forwarded and
 * no conversation id is stored, so the `saveDir` warning does not apply.
 *
 * The `description` is not optional in practice — it is the only thing the
 * Antigravity model reads when deciding whether to call the tool, and the
 * wrapper rejects a child without one.
 */
const reviewer = new AntigravityAgent({
  name: 'antigravity_reviewer',
  description: 'Reviews the workspace and reports what it found.',
  mode: 'single_turn',
  antigravityConfig: {connection: 'local'},
  agentFactory: (config) => new StandInAgent(config),
});

/**
 * The root agent: the harness owns the loop and the conversation.
 *
 * `saveDir` is a stable path. Without one the harness mints a fresh temporary
 * directory per connection, so the next turn cannot resume this conversation,
 * and the wrapper warns at construction.
 */
export const rootAgent = new AntigravityAgent({
  name: 'antigravity_assistant',
  description: 'Runs an Antigravity agent inside ADK.',
  antigravityConfig: {connection: 'local', saveDir: './trajectories'},
  agentFactory: (config) => new StandInAgent(config),
  subAgents: [reviewer],
});
