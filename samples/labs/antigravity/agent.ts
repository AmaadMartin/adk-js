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
 * takes no dependency on an Antigravity SDK: you pass an `agentFactory`
 * returning any object shaped like `SdkAgent`.
 *
 * No Antigravity SDK is published for JavaScript, so this sample supplies a
 * small in-file stand-in and therefore runs offline. A real `agentFactory`
 * would return the client's own agent for the config it is handed, for example
 * `(config) => new AntigravityClient(config)`.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/labs/antigravity/agent.ts
 */

import {
  AntigravityAgent,
  AntigravityAgentConfig,
  AntigravityStep,
  SdkAgent,
  SdkConversation,
} from '@google/adk';

/** A conversation that answers any prompt with a fixed two-step trajectory. */
class StandInConversation implements SdkConversation {
  readonly history: AntigravityStep[] = [];
  private prompt = '';

  async send(prompt: string): Promise<void> {
    this.prompt = prompt;
  }

  async *receiveSteps(): AsyncGenerator<AntigravityStep> {
    const steps: AntigravityStep[] = [
      {
        stepIndex: 0,
        source: 'MODEL',
        type: 'TOOL_CALL',
        status: 'DONE',
        content: 'index.html\nstyles.css',
        toolCalls: [{name: 'list_dir', args: {path: '.'}, id: 'call_1'}],
      },
      {
        stepIndex: 1,
        source: 'MODEL',
        type: 'TEXT_RESPONSE',
        status: 'DONE',
        isCompleteResponse: true,
        content: `Two files in the workspace. You asked: ${this.prompt}`,
      },
    ];
    for (const step of steps) {
      this.history.push(step);
      yield step;
    }
  }
}

/** A stand-in for the Antigravity agent one ADK turn runs on. */
class StandInAgent implements SdkAgent {
  readonly conversation = new StandInConversation();
  readonly conversationId: string;

  constructor(config: AntigravityAgentConfig) {
    // A real client mints an id, or reuses `config.conversationId` on a resume.
    this.conversationId = config.conversationId ?? 'sample-conversation-000000';
  }

  async connect(): Promise<SdkAgent> {
    return this;
  }

  async close(): Promise<void> {}
}

export const rootAgent = new AntigravityAgent({
  name: 'antigravity_assistant',
  description: 'Runs an Antigravity agent inside ADK.',
  antigravityConfig: {
    connection: 'local',
    // A stable path: without one the harness mints a fresh temporary directory
    // per connection, and the next turn cannot resume this conversation.
    saveDir: './trajectories',
  },
  agentFactory: (config) => new StandInAgent(config),
});
