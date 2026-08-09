/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InMemoryRunner,
  LlmAgent,
  LlmResponse,
  LoadSkillResourceErrorCode,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TEST_USER_ID = 'test-user';

const skill: Skill = {
  frontmatter: {name: 'test-skill', description: 'A test skill'},
  instructions: 'Test instructions',
  resources: {references: {'doc.md': 'Doc content'}},
};

/** A model that replays a fixed script, one response per request. */
class ScriptedLlm extends BaseLlm {
  calls = 0;

  constructor(private readonly script: LlmResponse[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    const response = this.script[this.calls++];
    yield response ?? {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

function requestResource(path: string): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'load_skill_resource',
            args: {skill_name: 'test-skill', path},
          },
        },
      ],
    },
  };
}

/** Error codes of every load_skill_resource response in an agent run. */
async function runAndCollectErrorCodes(
  runner: InMemoryRunner,
  sessionId: string,
  prompt: string,
): Promise<string[]> {
  const codes: string[] = [];
  for await (const event of runner.runAsync({
    userId: TEST_USER_ID,
    sessionId,
    newMessage: {role: 'user', parts: [{text: prompt}]},
  })) {
    for (const part of event.content?.parts ?? []) {
      const response = part.functionResponse?.response;
      if (part.functionResponse?.name === 'load_skill_resource' && response) {
        codes.push(String(response['error_code']));
      }
    }
  }
  return codes;
}

describe('load_skill_resource not-found guard in an agent run', () => {
  it('escalates within one invocation, resets on the next, and persists no counter', async () => {
    const model = new ScriptedLlm([
      requestResource('references/missing-a.md'),
      requestResource('references/missing-b.md'),
      {content: {role: 'model', parts: [{text: 'I cannot find it.'}]}},
      requestResource('references/missing-c.md'),
      {content: {role: 'model', parts: [{text: 'Still missing.'}]}},
    ]);
    const agent = new LlmAgent({
      name: 'skill_agent',
      model,
      tools: [new SkillToolset([skill])],
    });
    const runner = new InMemoryRunner({agent});
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: TEST_USER_ID,
    });

    const first = await runAndCollectErrorCodes(runner, session.id, 'Read it.');
    const second = await runAndCollectErrorCodes(
      runner,
      session.id,
      'Try again.',
    );

    expect(first).toEqual([
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND,
      LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND_FATAL,
    ]);
    expect(second).toEqual([LoadSkillResourceErrorCode.RESOURCE_NOT_FOUND]);
    expect(model.calls).toBe(5);

    const stored = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: TEST_USER_ID,
      sessionId: session.id,
    });
    expect(stored).toBeDefined();
    expect(
      Object.keys(stored?.state ?? {}).filter((key) =>
        key.includes('_adk_skill_resource_not_found_count_'),
      ),
    ).toEqual([]);
  });
});
