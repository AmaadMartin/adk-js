/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python tests/unittests/cli/test_trigger_routes.py (main).

import {
  createEvent,
  Event,
  getLogger,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Logger,
  LogLevel,
} from '@google/adk';
import express from 'express';
import {LoginTicket, OAuth2Client, TokenPayload} from 'google-auth-library';
import {Buffer} from 'node:buffer';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  HttpError,
  isTransientError,
  TriggerRouter,
  TriggerServerContext,
  TriggerVerifier,
} from '../../src/server/trigger_routes.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const PUBSUB_PATH = '/apps/test_app/trigger/pubsub';
const EVENTARC_PATH = '/apps/test_app/trigger/eventarc';
const OIDC_AUDIENCE = 'https://my-service.example.run.app';
const ALLOWED_EMAILS = ['allowed@project.iam', 'another-allowed@project.iam'];

function base64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

const PUBSUB_PAYLOAD = {
  message: {data: base64('hi'), messageId: 'msg-oidc'},
  subscription: 'projects/p/subscriptions/s',
};
const EVENTARC_PAYLOAD = {data: {key: 'value'}};

/** The two endpoints the reference parametrizes its auth tests over. */
const TRIGGER_ENDPOINTS = [
  {id: 'pubsub', path: PUBSUB_PATH, payload: PUBSUB_PAYLOAD as object},
  {id: 'eventarc', path: EVENTARC_PATH, payload: EVENTARC_PAYLOAD as object},
];

/** What the test agent does before it yields its one event. */
type AgentBehavior = (context: InvocationContext) => Promise<void> | void;

/**
 * Stands in for a real agent. Each test installs the behaviour it needs, the
 * same way the reference monkeypatches `Runner.run_async`.
 */
class TriggerTestAgent extends LlmAgent {
  behavior: AgentBehavior = () => {};

  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    await this.behavior(context);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: 'Processed'}]},
    });
  }
}

/** Captures every line the server logs, so a test can assert on it. */
class RecordingLogger implements Logger {
  readonly lines: string[] = [];

  log(_level: LogLevel, ...args: unknown[]): void {
    this.lines.push(args.join(' '));
  }
  debug(...args: unknown[]): void {
    this.lines.push(args.join(' '));
  }
  info(...args: unknown[]): void {
    this.lines.push(args.join(' '));
  }
  warn(...args: unknown[]): void {
    this.lines.push(args.join(' '));
  }
  error(...args: unknown[]): void {
    this.lines.push(args.join(' '));
  }
  setLogLevel(_level: LogLevel): void {}
}

interface TriggerHarness {
  url: string;
  agent: TriggerTestAgent;
  sessionService: InMemorySessionService;
}

interface StartOptions {
  triggerSources?: string[];
  triggerOidcAudience?: string;
  triggerOidcServiceAccounts?: string[];
  triggerAuthVerifier?: TriggerVerifier;
  /** Apps the loader can resolve. Anything else fails to load. */
  knownApps?: string[];
  logger?: Logger;
}

const servers: AdkApiServer[] = [];

async function startTriggerServer(
  options: StartOptions = {},
): Promise<TriggerHarness> {
  const knownApps = options.knownApps ?? ['test_app'];
  const agent = new TriggerTestAgent({
    name: 'trigger_test_agent',
    description: 'test agent for triggers',
  });
  const sessionService = new InMemorySessionService();
  const agentLoader = {
    listAgents: () => Promise.resolve(knownApps),
    getAgentFile: (appName: string) =>
      knownApps.includes(appName)
        ? Promise.resolve({
            load: () => Promise.resolve(agent),
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          })
        : Promise.reject(new Error(`App not found: ${appName}`)),
    // AgentLoader is a class with private state whose constructor registers
    // five process listeners, so a stub is cast rather than subclassed. This
    // is the same technique dev/test/server/adk_api_server_test.ts uses.
  } as unknown as AgentLoader;

  const server = new AdkApiServer({
    agentLoader,
    sessionService,
    triggerSources: options.triggerSources,
    triggerOidcAudience: options.triggerOidcAudience,
    triggerOidcServiceAccounts: options.triggerOidcServiceAccounts,
    triggerAuthVerifier: options.triggerAuthVerifier,
    logger: options.logger,
  });
  await server.start();
  servers.push(server);

  return {url: server.url, agent, sessionService};
}

/** Starts a server with both trigger sources and no verifier. */
function startBothSources(): Promise<TriggerHarness> {
  return startTriggerServer({triggerSources: ['pubsub', 'eventarc']});
}

interface TriggerResponse {
  status: number;
  body: {status?: string; error?: string};
}

async function post(
  url: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<TriggerResponse> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: {status?: string; error?: string} = {};
  try {
    body = JSON.parse(text) as {status?: string; error?: string};
  } catch {
    // A 404 from Express is HTML, and the tests only assert its status.
  }
  return {status: response.status, body};
}

/** Records the message text the agent received, parsed back from JSON. */
function captureMessages(agent: TriggerTestAgent): Array<{
  data: unknown;
  attributes: Record<string, string | null>;
}> {
  const captured: Array<{
    data: unknown;
    attributes: Record<string, string | null>;
  }> = [];
  agent.behavior = (context) => {
    const text = context.userContent?.parts?.[0]?.text ?? '';
    captured.push(
      JSON.parse(text) as {
        data: unknown;
        attributes: Record<string, string | null>;
      },
    );
  };
  return captured;
}

/** Records the user id each invocation ran under. */
function captureUserIds(agent: TriggerTestAgent): string[] {
  const captured: string[] = [];
  agent.behavior = (context) => {
    captured.push(context.userId);
  };
  return captured;
}

/** Makes OAuth2Client.verifyIdToken resolve to a ticket carrying `payload`. */
function mockVerifyIdToken(payload: TokenPayload): void {
  vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(() =>
    Promise.resolve(new LoginTicket(undefined, payload)),
  );
}

function makePayload(overrides: Partial<TokenPayload> = {}): TokenPayload {
  return {
    iss: 'https://accounts.google.com',
    sub: '1234567890',
    aud: OIDC_AUDIENCE,
    iat: 0,
    exp: 0,
    email: 'svc@project.iam',
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe('TestTriggerOidcVerification', () => {
  let harness: TriggerHarness;

  async function startOidcServer(
    serviceAccounts?: string[],
  ): Promise<TriggerHarness> {
    harness = await startTriggerServer({
      triggerSources: ['pubsub', 'eventarc'],
      triggerOidcAudience: OIDC_AUDIENCE,
      triggerOidcServiceAccounts: serviceAccounts,
    });
    return harness;
  }

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_missing_token [$id]',
    async ({path, payload}) => {
      const {url} = await startOidcServer();
      const response = await post(url, path, payload);
      expect(response.status).toBe(401);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_non_bearer_scheme [$id]',
    async ({path, payload}) => {
      const {url} = await startOidcServer();
      const response = await post(url, path, payload, {
        Authorization: 'Basic abc',
      });
      expect(response.status).toBe(401);
    },
  );

  it.each([
    {id: 'no space after the scheme', header: 'Bearer'},
    {id: 'whitespace-only token', header: 'Bearer    '},
    {id: 'tab instead of a space', header: 'Bearer\tabc.def.ghi'},
    {id: 'scheme only, lowercase', header: 'bearer'},
  ])('rejects a malformed Authorization header [$id]', async ({header}) => {
    // The reference splits on a literal space, so a tab is not a separator and
    // a token that is empty once trimmed is not a token.
    const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    const {url} = await startOidcServer();

    const response = await post(url, PUBSUB_PATH, PUBSUB_PAYLOAD, {
      Authorization: header,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe(
      'Missing or malformed Authorization bearer token.',
    );
    // Rejected before any network call to Google.
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('accepts a lowercase scheme, and trims the token it extracts', async () => {
    const tokens: string[] = [];
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(
      (options) => {
        tokens.push(String(options.idToken));
        return Promise.resolve(new LoginTicket(undefined, makePayload()));
      },
    );
    const {url} = await startOidcServer();

    const response = await post(url, PUBSUB_PATH, PUBSUB_PAYLOAD, {
      // The tab is inside the token the regex captures, so only trimming
      // removes it. The reference's `token.strip()` does the same.
      Authorization: 'bearer  \tabc.def.ghi',
    });

    expect(response.status).toBe(200);
    expect(tokens).toEqual(['abc.def.ghi']);
  });

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_invalid_token [$id]',
    async ({path, payload}) => {
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockRejectedValue(
        new Error('bad token'),
      );
      const {url} = await startOidcServer();
      const response = await post(url, path, payload, {
        Authorization: 'Bearer forged.jwt.value',
      });
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('OIDC token verification failed.');
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_accepts_valid_token [$id]',
    async ({path, payload}) => {
      const audiences: unknown[] = [];
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(
        (options) => {
          audiences.push(options.audience);
          return Promise.resolve(new LoginTicket(undefined, makePayload()));
        },
      );
      const {url} = await startOidcServer();

      const response = await post(url, path, payload, {
        Authorization: 'Bearer good.jwt.value',
      });

      expect(response.status).toBe(200);
      expect(audiences).toEqual([OIDC_AUDIENCE]);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_unauthenticated_junk_body_with_401 [$id]',
    async ({path}) => {
      // An unverified request never reaches body validation, so the answer is
      // 401 rather than 422.
      const {url} = await startOidcServer();
      const response = await post(url, path, {
        junk: 'data',
        not_a_valid_schema: true,
      });
      expect(response.status).toBe(401);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_reuses_http_request [$id]',
    async ({path, payload}) => {
      const clients: unknown[] = [];
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(
        function (this: OAuth2Client) {
          clients.push(this);
          return Promise.resolve(new LoginTicket(undefined, makePayload()));
        },
      );
      const {url} = await startOidcServer();
      const headers = {Authorization: 'Bearer good.jwt.value'};

      await post(url, path, payload, headers);
      await post(url, path, payload, headers);

      expect(clients).toHaveLength(2);
      expect(clients[0]).toBe(clients[1]);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_unauthenticated_by_default [$id]',
    async ({path, payload}) => {
      // With no audience configured, no token is required.
      const {url} = await startBothSources();
      const response = await post(url, path, payload);
      expect(response.status).toBe(200);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_untrusted_email [$id]',
    async ({path, payload}) => {
      mockVerifyIdToken(
        makePayload({email: 'attacker@project.iam', email_verified: true}),
      );
      const {url} = await startOidcServer(ALLOWED_EMAILS);

      const response = await post(url, path, payload, {
        Authorization: 'Bearer some.jwt.value',
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Untrusted token principal');
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_rejects_unverified_email [$id]',
    async ({path, payload}) => {
      mockVerifyIdToken(
        makePayload({email: 'allowed@project.iam', email_verified: false}),
      );
      const {url} = await startOidcServer(ALLOWED_EMAILS);

      const response = await post(url, path, payload, {
        Authorization: 'Bearer some.jwt.value',
      });

      expect(response.status).toBe(403);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_accepts_allowed_email [$id]',
    async ({path, payload}) => {
      mockVerifyIdToken(
        makePayload({email: 'allowed@project.iam', email_verified: true}),
      );
      const {url} = await startOidcServer(ALLOWED_EMAILS);

      const response = await post(url, path, payload, {
        Authorization: 'Bearer good.jwt.value',
      });

      expect(response.status).toBe(200);
    },
  );

  it('never logs the bearer token or the OIDC claims', async () => {
    // google-auth-library builds the raw token into "Wrong number of segments
    // in token: <jwt>" and the decoded claims into "Token used too late, ...
    // <payload>". Logging the message would write the caller's credential and
    // principal to disk.
    const token = 'synthetic-credential-value';
    const claims = '{"email":"pusher@project.iam","sub":"1234567890"}';
    vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockRejectedValue(
      new Error(
        `Wrong number of segments in token: ${token}. Token used too late, ` +
          claims,
      ),
    );
    const serverLog = new RecordingLogger();
    const verifierWarnings: string[] = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation((...args: unknown[]) => {
      verifierWarnings.push(args.join(' '));
    });

    const {url} = await startTriggerServer({
      triggerSources: ['pubsub'],
      triggerOidcAudience: OIDC_AUDIENCE,
      logger: serverLog,
    });
    const response = await post(url, PUBSUB_PATH, PUBSUB_PAYLOAD, {
      Authorization: `Bearer ${token}`,
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('OIDC token verification failed.');
    const logged = [...verifierWarnings, ...serverLog.lines].join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('pusher@project.iam');
    expect(logged).not.toContain('1234567890');
    // The failure is still reported, by class name.
    expect(verifierWarnings).toEqual([
      'OIDC token verification failed (Error).',
    ]);
  });

  it('test_service_accounts_without_audience_raises_value_error', () => {
    expect(
      () =>
        new AdkApiServer({
          triggerSources: ['pubsub'],
          triggerOidcServiceAccounts: ['allowed@project.iam'],
        }),
    ).toThrow(/triggerOidcServiceAccounts requires triggerOidcAudience/);
  });

  it('warns that a custom verifier makes the allowlist do nothing', async () => {
    const serverLog = new RecordingLogger();

    await startTriggerServer({
      triggerSources: ['pubsub'],
      triggerOidcAudience: OIDC_AUDIENCE,
      triggerOidcServiceAccounts: ALLOWED_EMAILS,
      triggerAuthVerifier: () => {},
      logger: serverLog,
    });

    expect(
      serverLog.lines.filter((line) =>
        line.includes('triggerOidcServiceAccounts is ignored'),
      ),
    ).toHaveLength(1);
  });

  it('does not warn about the allowlist when it is actually enforced', async () => {
    const serverLog = new RecordingLogger();

    await startTriggerServer({
      triggerSources: ['pubsub'],
      triggerOidcAudience: OIDC_AUDIENCE,
      triggerOidcServiceAccounts: ALLOWED_EMAILS,
      logger: serverLog,
    });

    expect(
      serverLog.lines.filter((line) =>
        line.includes('triggerOidcServiceAccounts is ignored'),
      ),
    ).toEqual([]);
  });

  it('accepts service accounts alongside a custom verifier', () => {
    expect(
      () =>
        new AdkApiServer({
          triggerSources: ['pubsub'],
          triggerOidcServiceAccounts: ['allowed@project.iam'],
          triggerAuthVerifier: () => {},
        }),
    ).not.toThrow();
  });
});

describe('TestTriggerCustomVerification', () => {
  const rejectingVerifier: TriggerVerifier = (req) => {
    if (req.get('authorization') !== 'Bearer secret-token') {
      throw new HttpError(403, 'Forbidden');
    }
  };

  const rejectingAsyncVerifier: TriggerVerifier = async (req) => {
    await Promise.resolve();
    if (req.get('authorization') !== 'Bearer async-secret-token') {
      throw new HttpError(403, 'Forbidden');
    }
  };

  it.each(TRIGGER_ENDPOINTS)(
    'test_custom_verifier_rejects [$id]',
    async ({path, payload}) => {
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: rejectingVerifier,
      });
      const response = await post(url, path, payload, {
        Authorization: 'Bearer bad-token',
      });
      expect(response.status).toBe(403);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_custom_verifier_accepts [$id]',
    async ({path, payload}) => {
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: rejectingVerifier,
      });
      const response = await post(url, path, payload, {
        Authorization: 'Bearer secret-token',
      });
      expect(response.status).toBe(200);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_custom_async_verifier_rejects [$id]',
    async ({path, payload}) => {
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: rejectingAsyncVerifier,
      });
      const response = await post(url, path, payload, {
        Authorization: 'Bearer bad-token',
      });
      expect(response.status).toBe(403);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_custom_async_verifier_accepts [$id]',
    async ({path, payload}) => {
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: rejectingAsyncVerifier,
      });
      const response = await post(url, path, payload, {
        Authorization: 'Bearer async-secret-token',
      });
      expect(response.status).toBe(200);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'test_custom_verifier_rejects_junk_body_with_403 [$id]',
    async ({path}) => {
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: rejectingVerifier,
      });
      const response = await post(
        url,
        path,
        {junk: 'data'},
        {Authorization: 'Bearer bad-token'},
      );
      expect(response.status).toBe(403);
    },
  );

  it.each(TRIGGER_ENDPOINTS)(
    'answers 500 when a verifier fails for its own reasons [$id]',
    async ({path, payload}) => {
      // A verifier that throws something other than an HttpError is a server
      // fault, not an authentication decision.
      const {url} = await startTriggerServer({
        triggerSources: ['pubsub', 'eventarc'],
        triggerAuthVerifier: () => {
          throw new Error('verifier misconfigured');
        },
      });
      const response = await post(url, path, payload);
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('verifier misconfigured');
    },
  );
});

describe('TestTriggerPubSub', () => {
  let harness: TriggerHarness;

  beforeEach(async () => {
    harness = await startBothSources();
  });

  it('test_success', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('Hello from Pub/Sub'), messageId: 'msg-001'},
      subscription: 'projects/my-project/subscriptions/my-sub',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(captured).toEqual([{data: 'Hello from Pub/Sub', attributes: {}}]);
  });

  it('test_message_with_attributes', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {
        attributes: {key: 'value', action: 'process'},
        messageId: 'msg-002',
      },
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {data: null, attributes: {key: 'value', action: 'process'}},
    ]);
  });

  it('test_json_payload_in_data', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {
        data: base64(JSON.stringify({order_id: 42, amount: 99.99})),
        messageId: 'msg-003',
      },
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {data: {order_id: 42, amount: 99.99}, attributes: {}},
    ]);
  });

  it('test_invalid_base64_returns_400', async () => {
    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: '!!!not-valid-base64!!!', messageId: 'msg-bad'},
    });

    expect(response.status).toBe(400);
    expect(response.body.error?.toLowerCase()).toContain('base64');
  });

  it('test_agent_error_returns_500', async () => {
    harness.agent.behavior = () => {
      throw new Error('Agent crashed');
    };

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('trigger error')},
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Agent processing failed');
  });

  it('reports a thrown non-Error value in the 500 body', async () => {
    harness.agent.behavior = () => {
      // Exercises the non-Error branch of errorMessage().
      throw 'agent rejected the delivery';
    };

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('trigger error')},
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe(
      'Agent processing failed: agent rejected the delivery',
    );
  });

  it('test_with_subscription_metadata', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('test')},
      subscription: 'projects/p/subscriptions/orders-sub',
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual(['projects--p--subscriptions--orders-sub']);
  });

  it('test_default_user_id_when_no_subscription', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('test')},
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual(['pubsub-caller']);
  });

  it('falls back to the default user id for a slash-only subscription', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('test')},
      subscription: ' / ',
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual(['pubsub-caller']);
  });

  it('test_subscription_user_id_is_path_safe', async () => {
    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('test')},
      subscription: 'projects/p/subscriptions/orders-sub',
    });

    expect(response.status).toBe(200);
    const listed = await harness.sessionService.listSessions({
      appName: 'test_app',
      userId: 'projects--p--subscriptions--orders-sub',
    });
    expect(listed.sessions).toHaveLength(1);
  });

  it('test_unknown_app_fails_early', async () => {
    const response = await post(
      harness.url,
      '/apps/unknown_app/trigger/pubsub',
      {message: {data: base64('test')}},
    );

    expect(response.status).toBe(500);
    // The runner is resolved before the session is created, so a failed load
    // leaves no orphan session behind.
    const listed = await harness.sessionService.listSessions({
      appName: 'unknown_app',
    });
    expect(listed.sessions).toEqual([]);
  });
});

describe('TestTriggerEventarc', () => {
  let harness: TriggerHarness;

  beforeEach(async () => {
    harness = await startBothSources();
  });

  it('test_success', async () => {
    const captured = captureMessages(harness.agent);
    const data = {
      bucket: 'my-bucket',
      name: 'path/to/file.pdf',
      contentType: 'application/pdf',
    };

    const response = await post(harness.url, EVENTARC_PATH, {
      data,
      source: 'storage.googleapis.com',
      type: 'google.cloud.storage.object.v1.finalized',
      id: 'evt-001',
      specversion: '1.0',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(captured[0].data).toEqual(data);
    expect(captured[0].attributes['ce-id']).toBe('evt-001');
    expect(captured[0].attributes['ce-type']).toBe(
      'google.cloud.storage.object.v1.finalized',
    );
  });

  it('test_source_derived_from_body_sanitized', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {key: 'value'},
      source: '//pubsub.googleapis.com/projects/p/topics/t',
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual(['pubsub.googleapis.com--projects--p--topics--t']);
  });

  it('test_source_from_ce_header_sanitized', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {data: {key: 'value'}},
      {'ce-source': '//storage.googleapis.com/projects/_/buckets/my-bucket'},
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      'storage.googleapis.com--projects--_--buckets--my-bucket',
    ]);
  });

  it('test_default_user_id_when_no_source', async () => {
    const captured = captureUserIds(harness.agent);

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {key: 'value'},
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual(['eventarc-caller']);
  });

  it('test_eventarc_source_user_id_is_path_safe', async () => {
    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {data: {key: 'value'}},
      {'ce-source': '//pubsub.googleapis.com/projects/p/topics/t'},
    );

    expect(response.status).toBe(200);
    const listed = await harness.sessionService.listSessions({
      appName: 'test_app',
      userId: 'pubsub.googleapis.com--projects--p--topics--t',
    });
    expect(listed.sessions).toHaveLength(1);
  });

  it('test_complex_event_data', async () => {
    const captured = captureMessages(harness.agent);
    const data = {
      resource: {name: 'projects/p/topics/t', labels: {env: 'prod'}},
      insertId: 'abc123',
      timestamp: '2026-01-01T00:00:00Z',
    };

    const response = await post(harness.url, EVENTARC_PATH, {data});

    expect(response.status).toBe(200);
    expect(captured[0].data).toEqual(data);
  });

  it('test_agent_error_returns_500', async () => {
    harness.agent.behavior = () => {
      throw new Error('Agent crashed');
    };

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {trigger: 'error'},
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Agent processing failed');
  });

  it('test_minimal_payload', async () => {
    const captured = captureMessages(harness.agent);

    // `{}` is not null, so this takes the structured-data branch.
    const response = await post(harness.url, EVENTARC_PATH, {data: {}});

    expect(response.status).toBe(200);
    expect(captured[0].data).toEqual({});
  });

  it('test_structured_mode_pubsub_wrapper', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {message: {data: base64('Hello from structured Eventarc')}},
      source: 'my-source',
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {data: 'Hello from structured Eventarc', attributes: {}},
    ]);
  });

  it('forwards an undecodable structured payload unchanged', async () => {
    const captured = captureMessages(harness.agent);

    // Unlike the Pub/Sub endpoint, Eventarc never answers 400 on a decode
    // failure: the raw value is forwarded instead.
    const response = await post(harness.url, EVENTARC_PATH, {
      data: {message: {data: '!!!not-valid-base64!!!'}},
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {data: '!!!not-valid-base64!!!', attributes: {}},
    ]);
  });

  it('forwards a null structured payload as null', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {message: {data: null, attributes: {k: 'v'}}},
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([{data: null, attributes: {k: 'v'}}]);
  });

  it('test_binary_content_mode_pubsub_wrapper', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {
        message: {
          data: base64('hello from eventarc'),
          messageId: 'evt-msg-001',
        },
        subscription: 'projects/p/subscriptions/eventarc-sub',
      },
      {
        'ce-source': '//pubsub.googleapis.com/projects/p/topics/t',
        'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
        'ce-id': 'binary-test-1',
        'ce-specversion': '1.0',
      },
    );

    expect(response.status).toBe(200);
    // The ce-* headers are not merged into a Pub/Sub wrapper's attributes.
    expect(captured).toEqual([{data: 'hello from eventarc', attributes: {}}]);
  });

  it('test_binary_content_mode_attributes_only', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {message: {attributes: {key: 'value'}, messageId: 'evt-msg-002'}},
      {'ce-source': '//pubsub.googleapis.com/test'},
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual([{data: null, attributes: {key: 'value'}}]);
  });

  it('test_binary_content_mode_arbitrary_payload', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {
        bucket: 'my-bucket',
        name: 'file.txt',
        contentType: 'application/json',
      },
      {
        'ce-source': '//storage.googleapis.com/projects/_/buckets/my-bucket',
        'ce-type': 'google.cloud.storage.object.v1.finalized',
        'ce-id': '12345',
        'ce-specversion': '1.0',
      },
    );

    expect(response.status).toBe(200);
    expect(captured[0].data).toEqual({
      bucket: 'my-bucket',
      name: 'file.txt',
      contentType: 'application/json',
    });
    expect(captured[0].attributes['ce-id']).toBe('12345');
  });
});

describe('TestTriggersDisabled (trigger sources not configured)', () => {
  // The reference declares this class twice and pytest collects only the
  // second, so this pair covers `triggerSources: undefined` while the pair
  // below covers `[]`.
  it('test_pubsub_returns_404', async () => {
    const {url} = await startTriggerServer();
    const response = await post(url, PUBSUB_PATH, {
      message: {data: base64('x')},
    });
    expect(response.status).toBe(404);
  });

  it('test_eventarc_returns_404', async () => {
    const {url} = await startTriggerServer();
    const response = await post(url, EVENTARC_PATH, {data: {}});
    expect(response.status).toBe(404);
  });
});

describe('TestTransientErrorDetection', () => {
  it('test_429_in_message', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(
      true,
    );
  });

  it('test_resource_exhausted', () => {
    expect(isTransientError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
  });

  it('test_rate_limit', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('test_quota', () => {
    expect(isTransientError(new Error('quota exceeded for project'))).toBe(
      true,
    );
  });

  it('test_non_transient', () => {
    expect(isTransientError(new Error('Agent crashed'))).toBe(false);
  });

  it('test_permission_denied', () => {
    expect(isTransientError(new Error('PERMISSION_DENIED'))).toBe(false);
  });

  it('detects a numeric 429 status', () => {
    // The reference checks google-api-core exception types here; Node has no
    // equivalent, so the status is read structurally instead.
    expect(isTransientError({status: 429, message: 'slow down'})).toBe(true);
  });

  it('detects a numeric 429 code', () => {
    expect(isTransientError({code: 429, message: 'slow down'})).toBe(true);
  });

  it('does not treat another numeric status as transient', () => {
    expect(isTransientError({status: 503, message: 'unavailable'})).toBe(false);
  });

  it('handles a thrown value that is not an object', () => {
    expect(isTransientError('rate limit reached')).toBe(true);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('TestRetryLogic', () => {
  let harness: TriggerHarness;

  beforeEach(async () => {
    // Read at construction time, so the backoff sleeps do not slow the suite.
    process.env['ADK_TRIGGER_RETRY_BASE_DELAY'] = '0';
    harness = await startBothSources();
  });

  afterEach(() => {
    delete process.env['ADK_TRIGGER_RETRY_BASE_DELAY'];
  });

  it('test_pubsub_retry_exhausted_returns_500', async () => {
    let calls = 0;
    harness.agent.behavior = () => {
      calls++;
      throw new Error('RESOURCE_EXHAUSTED: 429 quota exceeded');
    };

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('429 test')},
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Rate limit');
    // Three retries on top of the first attempt.
    expect(calls).toBe(4);
  });

  it('test_eventarc_retry_exhausted_returns_500', async () => {
    harness.agent.behavior = () => {
      throw new Error('RESOURCE_EXHAUSTED: 429 quota exceeded');
    };

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {test: '429'},
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Rate limit');
  });

  it('test_non_transient_error_not_retried', async () => {
    let calls = 0;
    harness.agent.behavior = () => {
      calls++;
      throw new Error('PERMISSION_DENIED: no access');
    };

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {test: true},
    });

    expect(response.status).toBe(500);
    expect(calls).toBe(1);
  });

  it('falls back to the default retry count for an unparsable env var', async () => {
    process.env['ADK_TRIGGER_MAX_RETRIES'] = 'not-a-number';
    let calls = 0;
    try {
      const badEnv = await startBothSources();
      badEnv.agent.behavior = () => {
        calls++;
        throw new Error('429 Resource has been exhausted');
      };

      const response = await post(badEnv.url, PUBSUB_PATH, {
        message: {data: base64('429 test')},
      });
      expect(response.status).toBe(500);
    } finally {
      delete process.env['ADK_TRIGGER_MAX_RETRIES'];
    }

    // The default of three retries, not NaN.
    expect(calls).toBe(4);
  });

  it('succeeds once a transient failure clears', async () => {
    let calls = 0;
    harness.agent.behavior = () => {
      calls++;
      if (calls < 3) {
        throw new Error('429 Resource has been exhausted');
      }
    };

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('retry test')},
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('reuses one session id across every retry attempt', async () => {
    const sessionIds: string[] = [];
    let calls = 0;
    harness.agent.behavior = (context) => {
      sessionIds.push(context.session.id);
      calls++;
      if (calls < 3) {
        throw new Error('429 Resource has been exhausted');
      }
    };

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {data: base64('retry test')},
    });

    expect(response.status).toBe(200);
    expect(new Set(sessionIds).size).toBe(1);
  });
});

describe('TestConcurrencyControl', () => {
  it('test_concurrent_pubsub_and_eventarc', async () => {
    const {url} = await startBothSources();

    const pubSub = await post(url, PUBSUB_PATH, {
      message: {data: base64('ps')},
    });
    expect(pubSub.status).toBe(200);

    const eventarc = await post(url, EVENTARC_PATH, {data: {key: 'value'}});
    expect(eventarc.status).toBe(200);
  });

  it('serves overlapping deliveries without losing a permit', async () => {
    const {url} = await startBothSources();

    const responses = await Promise.all([
      post(url, PUBSUB_PATH, {message: {data: base64('a')}}),
      post(url, PUBSUB_PATH, {message: {data: base64('b')}}),
      post(url, EVENTARC_PATH, {data: {k: 'c'}}),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
  });
});

describe('TestSelectiveRegistration', () => {
  it('test_only_pubsub', async () => {
    const {url} = await startTriggerServer({triggerSources: ['pubsub']});

    const pubSub = await post(url, PUBSUB_PATH, {
      message: {data: base64('test')},
    });
    expect(pubSub.status).toBe(200);

    const eventarc = await post(url, EVENTARC_PATH, {data: {}});
    expect(eventarc.status).toBe(404);
  });

  it('test_only_eventarc', async () => {
    const {url} = await startTriggerServer({triggerSources: ['eventarc']});

    const eventarc = await post(url, EVENTARC_PATH, {data: {k: 'v'}});
    expect(eventarc.status).toBe(200);

    const pubSub = await post(url, PUBSUB_PATH, {
      message: {data: base64('x')},
    });
    expect(pubSub.status).toBe(404);
  });
});

describe('TestUnknownTriggerSources', () => {
  it('test_unknown_source_ignored', async () => {
    const {url} = await startTriggerServer({
      triggerSources: ['unknown_source', 'pubsub'],
    });

    const pubSub = await post(url, PUBSUB_PATH, {
      message: {data: base64('test')},
    });
    expect(pubSub.status).toBe(200);

    const unknown = await post(url, '/apps/test_app/trigger/unknown_source', {
      calls: [['test']],
    });
    expect(unknown.status).toBe(404);
  });

  it('warns about every unknown source once, in a stable order', async () => {
    const serverLog = new RecordingLogger();

    await startTriggerServer({
      triggerSources: ['zeta', 'alpha', 'pubsub', 'alpha'],
      logger: serverLog,
    });

    expect(
      serverLog.lines.filter((line) => line.includes('Unknown trigger source')),
    ).toEqual([
      'Unknown trigger source(s) ignored: alpha, zeta. ' +
        'Valid sources: pubsub, eventarc',
    ]);
  });

  it('test_all_unknown_sources_results_in_no_endpoints', async () => {
    const {url} = await startTriggerServer({triggerSources: ['foo', 'bar']});

    const unknown = await post(url, '/apps/test_app/trigger/unknown_source', {
      calls: [['test']],
    });
    expect(unknown.status).toBe(404);

    const pubSub = await post(url, PUBSUB_PATH, {
      message: {data: base64('x')},
    });
    expect(pubSub.status).toBe(404);
  });
});

describe('TestTriggersDisabled', () => {
  it('test_pubsub_returns_404', async () => {
    const {url} = await startTriggerServer({triggerSources: []});
    const response = await post(url, PUBSUB_PATH, {
      message: {data: base64('x')},
    });
    expect(response.status).toBe(404);
  });

  it('test_eventarc_returns_404', async () => {
    const {url} = await startTriggerServer({triggerSources: []});
    const response = await post(url, EVENTARC_PATH, {data: {}});
    expect(response.status).toBe(404);
  });
});

describe('TestTriggerRequestModels', () => {
  let harness: TriggerHarness;

  beforeEach(async () => {
    harness = await startBothSources();
  });

  it('test_pubsub_body_without_message_is_rejected_before_the_agent_runs', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      subscription: 'projects/p/subscriptions/s',
    });

    expect(response.status).toBe(422);
    expect(captured).toEqual([]);
  });

  it('test_pubsub_accepts_the_full_push_envelope', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, PUBSUB_PATH, {
      message: {
        data: base64('envelope test'),
        attributes: {k: 'v'},
        messageId: 'msg-100',
        publishTime: '2026-01-01T00:00:00Z',
        orderingKey: 'order-1',
      },
      subscription: 'projects/p/subscriptions/s',
      deliveryAttempt: 3,
    });

    expect(response.status).toBe(200);
    expect(captured).toEqual([{data: 'envelope test', attributes: {k: 'v'}}]);
  });

  it('test_eventarc_fallback_forwards_only_the_fields_the_caller_set', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(
      harness.url,
      EVENTARC_PATH,
      {bucket: 'my-bucket', name: 'file.txt'},
      {
        'ce-source': '//storage.googleapis.com/b',
        'ce-type': 'google.cloud.storage.object.v1.finalized',
        'ce-id': 'evt-9',
        'ce-specversion': '1.0',
      },
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual([
      {
        data: {bucket: 'my-bucket', name: 'file.txt'},
        attributes: {
          'ce-id': 'evt-9',
          'ce-type': 'google.cloud.storage.object.v1.finalized',
          'ce-source': '//storage.googleapis.com/b',
          'ce-specversion': '1.0',
        },
      },
    ]);
  });

  it('reports a missing CloudEvents attribute as null', async () => {
    const captured = captureMessages(harness.agent);

    const response = await post(harness.url, EVENTARC_PATH, {
      data: {key: 'value'},
    });

    expect(response.status).toBe(200);
    expect(captured[0].attributes).toEqual({
      'ce-id': null,
      'ce-type': null,
      'ce-source': null,
      'ce-specversion': null,
    });
  });

  it('rejects a CloudEvent whose data is not an object', async () => {
    const response = await post(harness.url, EVENTARC_PATH, {
      data: 'not-an-object',
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toContain('Invalid CloudEvent body');
  });
});

describe('TriggerRouter used directly', () => {
  it('mounts nothing when no options are given', async () => {
    const context: TriggerServerContext = {
      logger: getLogger(),
      withRunner: () => Promise.reject(new Error('must not be reached')),
    };
    const app = express();
    new TriggerRouter(context).register(app);

    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        expect.fail('expected the test server to bind a TCP port');
      }
      const response = await post(
        `http://127.0.0.1:${address.port}`,
        PUBSUB_PATH,
        {message: {data: base64('x')}},
      );
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
