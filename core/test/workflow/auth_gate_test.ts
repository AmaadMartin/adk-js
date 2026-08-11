/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {hasAuthRequestFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';
import {createIc, driveWorkflow} from './test_helpers.js';

const CREDENTIAL_KEY = 'my_api';

function apiKeyAuthConfig(): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'} as AuthScheme,
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
    credentialKey: CREDENTIAL_KEY,
  };
}

async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of gen) {
    out.push(e);
  }
  return out;
}

const FROZEN_TOKEN_URL = 'https://legit.example/token';

function oauth2AuthConfig(): AuthConfig {
  return {
    authScheme: {
      type: 'oauth2',
      flows: {clientCredentials: {tokenUrl: FROZEN_TOKEN_URL, scopes: {}}},
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'id', clientSecret: 'secret'},
    },
    credentialKey: CREDENTIAL_KEY,
  };
}

describe('Phase 5b-cont — FunctionNode auth gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests credentials, then runs after they are supplied on resume', async () => {
    let runs = 0;
    let sawApiKey: string | undefined;

    // An auth-gated node must RE-RUN on resume so it can store the supplied
    // credential and then run its body (this is why Python's auth samples set
    // rerun_on_resume=True). Without it, the default two-node resume semantics
    // would complete the node with the raw credential response as its output.
    const secured = new FunctionNode(
      'secured',
      (ctx: NodeContext) => {
        runs++;
        const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
        sawApiKey = cred?.apiKey;
        return `data(${cred?.apiKey})`;
      },
      {authConfig: apiKeyAuthConfig(), rerunOnResume: true},
    );

    const wf = new Workflow({name: 'auth_wf', edges: [['START', secured]]});
    const agent = new WorkflowAgent(wf);
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    // Turn 1: no credential -> auth request interrupt, handler NOT run.
    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      }),
    );
    expect(runs).toBe(0);
    expect(turn1.some(hasAuthRequestFunctionCall)).toBe(true);

    // Turn 2: supply the credential (as a filled AuthConfig) and resume.
    const credentialResponse: AuthConfig = {
      authScheme: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      } as AuthScheme,
      credentialKey: CREDENTIAL_KEY,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-123',
      },
    };
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: CREDENTIAL_KEY,
                name: 'adk_request_credential',
                response: credentialResponse as unknown as Record<
                  string,
                  unknown
                >,
              },
            },
          ],
        },
      }),
    );

    // The node ran once, saw the supplied API key, and produced output.
    expect(runs).toBe(1);
    expect(sawApiKey).toBe('secret-123');
    expect(turn2.some((e) => e.output === 'data(secret-123)')).toBe(true);
  });

  it('runs immediately when the credential already exists in state', async () => {
    let runs = 0;
    const secured = new FunctionNode(
      'secured',
      () => {
        runs++;
        return 'ok';
      },
      {authConfig: apiKeyAuthConfig()},
    );
    const wf = new Workflow({name: 'auth_wf2', edges: [['START', secured]]});

    // Pre-seed the credential directly in the session state.
    const {events, output} = await driveWorkflow(wf, 'go', {
      ic: createIc({
        ['temp:' + CREDENTIAL_KEY]: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'pre-existing',
        },
      }),
    });

    expect(runs).toBe(1);
    expect(output).toBe('ok');
    expect(events.some(hasAuthRequestFunctionCall)).toBe(false);
  });

  it('exchanges at the frozen token endpoint when the resume names another one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({access_token: 'issued'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    let seenToken: string | undefined;
    const secured = new FunctionNode(
      'secured',
      (ctx: NodeContext) => {
        const cred = ctx.state.get<AuthCredential>('temp:' + CREDENTIAL_KEY);
        seenToken = cred?.oauth2?.accessToken;
        return 'data';
      },
      {authConfig: oauth2AuthConfig(), rerunOnResume: true},
    );

    const wf = new Workflow({name: 'auth_wf3', edges: [['START', secured]]});
    const agent = new WorkflowAgent(wf);
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent, sessionService});

    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      }),
    );
    expect(turn1.some(hasAuthRequestFunctionCall)).toBe(true);

    // Turn 2: answer with a scheme the node never requested, pointing the
    // token exchange at an attacker-controlled host.
    const credentialResponse = {
      authScheme: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://attacker.invalid/token',
            scopes: {},
          },
        },
      },
      credentialKey: CREDENTIAL_KEY,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      },
    } satisfies AuthConfig;
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: CREDENTIAL_KEY,
                name: 'adk_request_credential',
                response: credentialResponse,
              },
            },
          ],
        },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(FROZEN_TOKEN_URL);
    expect(seenToken).toBe('issued');
    expect(turn2.some(hasAuthRequestFunctionCall)).toBe(false);
  });
});
