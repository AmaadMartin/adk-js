/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A plain-text reply resolving a HITL pause is recorded in the session as the
 * `functionResponse` an interactive client would have sent, so every consumer
 * that reads the call/response pairing sees the pause as answered.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {getPendingUserInputRequests} from '../../src/agents/user_input_request.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {Event, getFunctionResponses} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';

const APP_NAME = 'marker_app';
const USER_ID = 'u1';

/** Drives a workflow over one session, sending each text as its own turn. */
async function typedTurns(
  workflow: Workflow,
  texts: string[],
): Promise<{turns: Event[][]; events: Event[]}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const runner = new Runner({
    appName: APP_NAME,
    agent: workflow,
    sessionService,
  });

  const turns: Event[][] = [];
  for (const text of texts) {
    const turn: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text}]},
    })) {
      turn.push(event);
    }
    turns.push(turn);
  }

  const stored = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
  });
  if (!stored) {
    expect.fail('the session under test disappeared from the session service');
  }
  return {turns, events: stored.events};
}

/** The last non-undefined `output` across a turn's events. */
function finalOutput(events: Event[]): unknown {
  let output: unknown;
  for (const event of events) {
    if (event.output !== undefined) {
      output = event.output;
    }
  }
  return output;
}

/** Every function response in the session, in order. */
function responses(events: Event[]) {
  return events.flatMap((e) => getFunctionResponses(e));
}

/** A gate that pauses once on `interruptId`, then reports the reply it got. */
function gate(name: string, interruptId: string, responseSchema?: z.ZodType) {
  return node(
    (ctx: NodeContext, input: unknown) => {
      const reply = ctx.resumeInputs[interruptId];
      if (reply === undefined) {
        return new RequestInput({
          interruptId,
          message: `${interruptId}?`,
          responseSchema,
        });
      }
      return `${input}|${interruptId}=${JSON.stringify(reply)}`;
    },
    {name, rerunOnResume: true},
  );
}

describe('plain-text HITL resume — session record', () => {
  it('records the resolved interrupt as a client-shaped user reply', async () => {
    const wf = new Workflow({
      name: 'one_pause',
      edges: [['START', gate('gate_a', 'A')]],
    });

    const {turns, events} = await typedTurns(wf, ['start', 'approve']);

    expect(finalOutput(turns[1])).toBe('start|A="approve"');
    expect(responses(events)).toEqual([
      {
        id: 'A',
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: {result: 'approve'},
      },
    ]);
    const marker = events.find((e) => getFunctionResponses(e).length > 0);
    expect(marker?.author).toBe('user');
    expect(marker?.content?.role).toBe('user');
  });

  it('reports no pending request once the pause is answered by typing', async () => {
    const wf = new Workflow({
      name: 'one_pause_pending',
      edges: [['START', gate('gate_a', 'A')]],
    });

    const {events} = await typedTurns(wf, ['start', 'approve']);

    expect(getPendingUserInputRequests(events)).toEqual([]);
  });

  it('resumes a second sequential pause from a second typed reply', async () => {
    const wf = new Workflow({
      name: 'two_pauses',
      edges: [['START', gate('gate_a', 'A'), gate('gate_b', 'B')]],
    });

    const {turns, events} = await typedTurns(wf, [
      'start',
      'first answer',
      'second answer',
    ]);

    expect(finalOutput(turns[2])).toBe(
      'start|A="first answer"|B="second answer"',
    );
    expect(responses(events).map((fr) => fr.id)).toEqual(['A', 'B']);
    expect(getPendingUserInputRequests(events)).toEqual([]);
  });

  it('names an auth-gate resume adk_request_credential', async () => {
    const credentialKey = 'weather_api_key';
    const authConfig: AuthConfig = {
      credentialKey,
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
    };
    const fetchWeather = node(
      (ctx: NodeContext) =>
        `key=${ctx.state.get<AuthCredential>(`temp:${credentialKey}`)?.apiKey}`,
      {name: 'fetch_weather', authConfig, rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'auth_gate',
      edges: [['START', fetchWeather]],
    });

    const {turns, events} = await typedTurns(wf, ['go', 'test-api-key']);

    expect(finalOutput(turns[1])).toBe('key=test-api-key');
    expect(responses(events)).toEqual([
      {
        id: credentialKey,
        name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
        response: {result: 'test-api-key'},
      },
    ]);
  });

  it('still accepts free text at a prompt that declared a responseSchema', async () => {
    const wf = new Workflow({
      name: 'schema_free_text',
      edges: [
        ['START', gate('gate_a', 'A', z.object({approved: z.boolean()}))],
      ],
    });

    const {turns, events} = await typedTurns(wf, ['start', 'approve']);

    expect(finalOutput(turns[1])).toBe('start|A="approve"');
    expect(getPendingUserInputRequests(events)).toEqual([]);
  });

  it('reports a typed reply that parses to a schema-violating object', async () => {
    const wf = new Workflow({
      name: 'schema_bad_object',
      edges: [
        ['START', gate('gate_a', 'A', z.object({approved: z.boolean()}))],
      ],
    });

    await expect(
      typedTurns(wf, ['start', '{"approved":"yes"}']),
    ).rejects.toThrow(/reply to interrupt 'A' does not match/i);
  });
});
