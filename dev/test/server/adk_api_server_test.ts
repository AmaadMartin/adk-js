/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Runner,
  Session,
} from '@google/adk';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  EvalCase,
  EvalSet,
  EvalSetResult,
} from '../../src/server/evaluation_types.js';
import {LocalEvalSetResultsManager} from '../../src/server/local_eval_set_results_manager.js';

import {AgentLoader} from '../../src/utils/agent_loader.js';

/**
 * Http client for testing the AdkWebServer. It makes real http requests to the
 * server.
 */
class HttpClient {
  constructor(private readonly baseUrl: string) {}

  get<T>(url: string) {
    return this.request<T>(url, {method: 'GET'});
  }

  post<T>(url: string, body?: unknown) {
    return this.request<T>(url, {method: 'POST', body});
  }

  put<T>(url: string, body?: unknown) {
    return this.request<T>(url, {method: 'PUT', body});
  }

  delete<T>(url: string) {
    return this.request<T>(url, {method: 'DELETE'});
  }

  private async request<T = unknown>(
    url: string,
    {method, body}: {method: string; body?: unknown},
  ): Promise<{status: number; data?: T; text?: string}> {
    const options = {
      method,
      headers: body ? {'Content-Type': 'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual' as const,
    };

    const response = await fetch(`${this.baseUrl}${url}`, options);
    const contentType = response.headers.get('content-type');
    let data: T | undefined = undefined;
    let text: string | undefined = undefined;

    if (contentType?.includes('application/json')) {
      data = (await response.json().catch(() => undefined)) as T;
    } else {
      text = await response.text();
    }

    if (response.status > 399) {
      throw {
        response: {status: response.status},
        message: (data as {error?: string})?.error || response.statusText,
      };
    }

    return {
      status: response.status,
      data,
      text,
    };
  }
}

class TestAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (context.userContent?.parts?.[0]?.text === 'throw') {
      throw new Error('Agent execution failed');
    }

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: "Hello user! I'm streaming you events now!",
          },
        ],
        role: 'model',
      },
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'Event 1',
          },
        ],
        role: 'model',
      },
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'Event 2',
          },
        ],
        role: 'model',
      },
    });

    return;
  }

  async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'test live content',
          },
        ],
        role: 'model',
      },
    });
  }
}

const TEST_AGENT = new TestAgent({
  name: 'testAgent',
  description: 'test agent',
  tools: [
    new FunctionTool({
      name: 'foo',
      description: 'foo tool',
      parameters: z.object({}),
      execute: async () => 'bar',
    }),
  ],
});

describe('AdkWebServer', () => {
  let agentLoader: AgentLoader;
  let sessionService: BaseSessionService;
  let memoryService: BaseMemoryService;
  let artifactService: BaseArtifactService;
  let server: AdkApiServer;
  let client: HttpClient;
  let tempAgentsDir: string;

  beforeEach(async () => {
    tempAgentsDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'adk-api-server-test-'),
    );
    agentLoader = {
      listAgents: () => Promise.resolve(['testApp']),
      getAgentFile: (appName: string) => {
        if (appName === 'brokenApp') {
          return Promise.reject(new Error('Failed to load agent'));
        }
        return Promise.resolve({
          load() {
            return Promise.resolve(TEST_AGENT);
          },
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        });
      },
    } as unknown as AgentLoader;
    sessionService = new InMemorySessionService();
    memoryService = new InMemoryMemoryService();
    artifactService = new InMemoryArtifactService();
    server = new AdkApiServer({
      agentsDir: tempAgentsDir,
      agentLoader,
      sessionService,
      memoryService,
      artifactService,
    });
    await server.start();

    client = new HttpClient(server.url);
  });

  afterEach(async () => {
    await server.stop();
    await fsPromises.rm(tempAgentsDir, {recursive: true, force: true});
  });

  describe('Sessions', () => {
    it('should return an empty list of sessions', async () => {
      const response = await client.get<{
        sessions: Session[];
      }>('/apps/testApp/users/testUser/sessions');

      expect(response.status).toBe(200);
      expect(response.data?.sessions).toEqual([]);
    });

    it('should create a session with a random id', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions',
        {},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toBeDefined();
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
    });

    it('should create a session with a given id', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
        {},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
    });

    it('should create a session with a given id and state', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
        {state: {foo: 'bar'}},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
      expect(response.data?.state).toEqual({foo: 'bar'});
    });

    it('should create a session with random id and state', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions',
        {state: {foo: 'bar'}},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toBeDefined();
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
      expect(response.data?.state).toEqual({foo: 'bar'});
    });

    it('should return 400 if session with given id already exists', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post(
          '/apps/testApp/users/testUser/sessions/sessionId',
          {},
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(400);
      }
    });

    it('should return a session by id', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.get<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.get('/apps/testApp/users/testUser/sessions/sessionId');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should delete a session', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.delete(
        '/apps/testApp/users/testUser/sessions/sessionId',
      );

      expect(response.status).toBe(204);
      expect(
        await sessionService.getSession({
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
        }),
      ).toBeUndefined();
    });
  });

  describe('Artifacts', () => {
    it('should return an empty list of artifacts', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual([]);
    });

    it('should return an artifact by name', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        text: 'content',
      });
    });

    it('should return 404 if artifact not found', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return an artifact by version', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt/versions/0',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual({text: 'content'});
    });

    it('should return a list of artifact versions', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content2',
        },
      });

      const response = await client.get<string[]>(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt/versions',
      );

      expect(response.status).toBe(200);
      expect(response.data?.length).toEqual(2);
    });

    it('should delete an artifact', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.delete(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
      );

      expect(response.status).toBe(204);
      expect(
        await artifactService.loadArtifact({
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          filename: 'artifact.txt',
        }),
      ).toBeUndefined();
    });
  });

  describe('run', () => {
    it('should return a list of events', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data!.length).toBe(3);
      expect((response.data as Event[])[0].content!.parts![0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('should update session state if stateDelta is provided', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        state: {foo: 'bar'},
      });

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
        stateDelta: {baz: 'qux'},
      });

      expect(response.status).toBe(200);
      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      // The state should be merged or updated. Assuming deep merge or at least key addition.
      // If Runner does shallow merge of stateDelta:
      expect(session?.state).toEqual({foo: 'bar', baz: 'qux'});
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {parts: [{text: 'Hello'}], role: 'user'},
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });

    it('should pass abortSignal to Runner.runAsync in /run', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      const runAsyncParams = spy.mock.calls[0][0];
      expect(runAsyncParams.abortSignal).toBeDefined();
      expect(runAsyncParams.abortSignal).toBeInstanceOf(AbortSignal);

      spy.mockRestore();
    });
  });

  describe('run_sse', () => {
    it('should return a stream of events', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
      });

      const rawEvent = response.text!.split('\n\n');
      // Last element is always empty.
      rawEvent.pop();

      const events = rawEvent.map(
        (eventText) => JSON.parse(eventText.split('data: ')[1]) as Event,
      );

      expect(response.status).toBe(200);
      expect(events.length).toBe(3);
      expect(events[0]!.content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
      expect(events[1]!.content?.parts?.[0].text).toBe('Event 1');
      expect(events[2]!.content?.parts?.[0].text).toBe('Event 2');
    });

    it('should update session state if stateDelta is provided', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        state: {foo: 'bar'},
      });

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
        stateDelta: {baz: 'qux'},
      });

      expect(response.status).toBe(200);
      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      expect(session?.state).toEqual({foo: 'bar', baz: 'qux'});
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.post('/run_sse', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post('/run_sse', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {parts: [{text: 'Hello'}], role: 'user'},
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });

    it('should pass abortSignal to Runner.runAsync in /run_sse', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      const runAsyncParams = spy.mock.calls[0][0];
      expect(runAsyncParams.abortSignal).toBeDefined();
      expect(runAsyncParams.abortSignal).toBeInstanceOf(AbortSignal);

      spy.mockRestore();
    });
  });

  describe('List Apps', () => {
    it('should return list of apps', async () => {
      const response = await client.get<string[]>('/list-apps');
      expect(response.status).toBe(200);
      expect(response.data).toEqual(['testApp']);
    });

    it('should return 500 if listAgents fails', async () => {
      const originalListAgents = agentLoader.listAgents;
      agentLoader.listAgents = () => Promise.reject(new Error('List failed'));

      try {
        await client.get('/list-apps');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.listAgents = originalListAgents;
      }
    });
  });

  describe('Debug UI', () => {
    it('should redirect to dev-ui when enabled', async () => {
      const debugServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        serveDebugUI: true,
      });
      await debugServer.start();
      const debugClient = new HttpClient(debugServer.url);

      const response = await debugClient.get('/');
      expect(response.status).toBe(302);
      await debugServer.stop();
    });
  });

  describe('Debug Trace', () => {
    it('should return trace by event id', async () => {
      (server as unknown as {traceDict: {[key: string]: unknown}}).traceDict[
        'event1'
      ] = {some: 'trace'};

      const response = await client.get<{some: string}>('/debug/trace/event1');
      expect(response.status).toBe(200);
      expect(response.data).toEqual({some: 'trace'});
    });

    it('should return 404 for missing trace', async () => {
      try {
        await client.get('/debug/trace/missing');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return session traces', async () => {
      const mockSpan = {
        name: 'call_llm',
        spanContext: () => ({traceId: 'trace1', spanId: 'span1'}),
        startTime: [1, 0],
        endTime: [2, 0],
        attributes: {'gcp.vertex.agent.session_id': 'session1'},
        parentSpanContext: undefined,
      } as unknown as ReadableSpan;

      (
        server as unknown as {
          memoryExporter: {
            export: (
              spans: ReadableSpan[],
              resultCallback: (result: {code: number}) => void,
            ) => void;
          };
        }
      ).memoryExporter.export([mockSpan], () => {});

      const response = await client.get<{name: string}[]>(
        '/debug/trace/session/session1',
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
      expect(response.data![0].name).toBe('call_llm');
    });
  });

  describe('Graph', () => {
    it('should return graph for function calls', async () => {
      const originalGetSession = sessionService.getSession;
      sessionService.getSession = async () =>
        createSession({
          id: 'fullSession',
          appName: 'testApp',
          userId: 'testUser',
          events: [
            createEvent({
              id: 'event1',
              author: 'model',
              content: {parts: [{functionCall: {name: 'foo', args: {}}}]},
              invocationId: 'inv-1',
            }),
          ],
        });

      try {
        const response = await client.get<{
          dotSrc: string;
        }>(
          '/apps/testApp/users/testUser/sessions/fullSession/events/event1/graph',
        );

        expect(response.status).toBe(200);
        expect(response.data!.dotSrc).toBeDefined();
        expect(response.data!.dotSrc).toContain('testAgent');
        expect(response.data!.dotSrc).toContain('foo');
      } finally {
        sessionService.getSession = originalGetSession;
      }
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/missing/events/event1/graph',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 404 if event not found', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionNoEvents',
      });
      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/sessionNoEvents/events/missing/graph',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });
  });

  describe('A2A', () => {
    it('should return 404 for A2A endpoints when disabled', async () => {
      try {
        await client.get(`/a2a/testApp/${AGENT_CARD_PATH}`);
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return Agent Card when enabled', async () => {
      const a2aServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        a2a: true,
      });
      await a2aServer.start();
      const a2aClient = new HttpClient(a2aServer.url);

      const response = await a2aClient.get<AgentCard>(
        `/a2a/testApp/${AGENT_CARD_PATH}`,
      );
      expect(response.status).toBe(200);
      expect(response.data?.name).toBe('testAgent');

      await a2aServer.stop();
    });
  });

  describe('Reasoning Engine', () => {
    it('should return 200 OK on health endpoints when debug UI is disabled', async () => {
      const healthResponse = await client.get<string>('/health');
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.text).toBe('OK');

      const rootResponse = await client.get<string>('/');
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.text).toBe('OK');
    });

    it('should query the agent using reasoning_engine route with valid JSON', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post<{output: Event[]}>(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: {
              parts: [{text: 'Hello'}],
              role: 'user',
            },
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.data?.output).toBeDefined();
      expect(response.data?.output.length).toBe(3);
      expect(response.data?.output[0].content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('should auto-create session if not exists on reasoning_engine query', async () => {
      const response = await client.post<{output: Event[]}>(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'newSessionId',
            newMessage: {
              parts: [{text: 'Hello'}],
              role: 'user',
            },
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.data?.output).toBeDefined();

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'newSessionId',
      });
      expect(session).toBeDefined();
    });

    it('should support raw body query and parse headers workaround', async () => {
      const url = `${server.url}/api/reasoning_engine`;
      const payload = {
        input: {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'rawSessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json,application/json',
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {output: Event[]};
      expect(data.output).toBeDefined();
      expect(data.output[0].content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('should return 400 if appName is missing', async () => {
      try {
        await client.post('/api/reasoning_engine', {
          input: {
            userId: 'testUser',
            sessionId: 'sessionId',
          },
        });
        expect.fail('Should fail with 400');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(400);
        expect((e as {message: string}).message).toContain(
          'appName is required',
        );
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      try {
        await client.post('/api/reasoning_engine', {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
          },
        });
        expect.fail('Should fail with 500');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });
  });

  describe('Startup', () => {
    it('should throw an error if the port is already in use', async () => {
      const portString = server.url.split(':').pop();
      const port = portString ? parseInt(portString, 10) : 0;

      expect(port).toBeGreaterThan(0);

      const duplicateServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        port: port,
      });

      try {
        await expect(duplicateServer.start()).rejects.toThrow(
          `Port ${port} is already in use`,
        );
      } finally {
        await duplicateServer.stop().catch(() => {});
      }
    });

    it('should default to listening on localhost', async () => {
      const defaultServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await defaultServer.start();
      try {
        const address = (
          defaultServer as unknown as {
            server: {address: () => {address: string}};
          }
        ).server.address();
        expect(address.address).toMatch(/127\.0\.0\.1|::1|localhost/);
      } finally {
        await defaultServer.stop();
      }
    });

    it('should listen on specified host', async () => {
      const specificServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        host: '127.0.0.1',
      });
      await specificServer.start();
      try {
        const address = (
          specificServer as unknown as {
            server: {address: () => {address: string}};
          }
        ).server.address();
        expect(address.address).toBe('127.0.0.1');
      } finally {
        await specificServer.stop();
      }
    });
  });

  describe('Eval Sets and Results Endpoints', () => {
    const appName = 'testApp';
    const evalSetId = 'api_test_set';

    it('should create and list eval sets', async () => {
      const createRes = await client.post<EvalSet>(
        `/apps/${appName}/eval_sets/${evalSetId}`,
      );
      expect(createRes.status).toBe(200);
      expect(createRes.data!.evalSetId).toBe(evalSetId);

      const listRes = await client.get<{evalSetIds: string[]}>(
        `/apps/${appName}/eval_sets`,
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data!.evalSetIds).toContain(evalSetId);
    });

    it('should manage cases in eval set', async () => {
      await client.post(`/apps/${appName}/eval_sets/${evalSetId}`);

      const session = await sessionService.createSession({
        appName,
        userId: 'u1',
        sessionId: 's1',
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: 'inv1',
          author: 'user',
          content: {role: 'user', parts: [{text: 'test query'}]},
        }),
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: 'inv1',
          author: 'agent',
          content: {role: 'model', parts: [{text: 'test response'}]},
        }),
      });

      const addCaseRes = await client.post(
        `/apps/${appName}/eval_sets/${evalSetId}/add_session`,
        {userId: 'u1', sessionId: 's1', evalId: 'case_1'},
      );
      expect(addCaseRes.status).toBe(204);

      const listEvalsRes = await client.get<string[]>(
        `/apps/${appName}/eval_sets/${evalSetId}/evals`,
      );
      expect(listEvalsRes.status).toBe(200);
      expect(listEvalsRes.data).toContain('case_1');

      const getCaseRes = await client.get<EvalCase>(
        `/apps/${appName}/eval_sets/${evalSetId}/evals/case_1`,
      );
      expect(getCaseRes.status).toBe(200);
      expect(getCaseRes.data!.evalId).toBe('case_1');
      expect(getCaseRes.data!.conversation!.length).toBe(1);
      expect(getCaseRes.data!.conversation![0].userContent.parts[0].text).toBe(
        'test query',
      );

      const updatedCase: EvalCase = {
        ...getCaseRes.data!,
        conversation: [
          {
            ...getCaseRes.data!.conversation![0],
            userContent: {role: 'user', parts: [{text: 'updated query'}]},
          },
        ],
      };
      const updateRes = await client.put(
        `/apps/${appName}/eval_sets/${evalSetId}/evals/case_1`,
        updatedCase,
      );
      expect(updateRes.status).toBe(204);

      const getCaseRes2 = await client.get<EvalCase>(
        `/apps/${appName}/eval_sets/${evalSetId}/evals/case_1`,
      );
      expect(getCaseRes2.data!.conversation![0].userContent.parts[0].text).toBe(
        'updated query',
      );

      const deleteRes = await client.delete(
        `/apps/${appName}/eval_sets/${evalSetId}/evals/case_1`,
      );
      expect(deleteRes.status).toBe(204);

      const listEvalsRes2 = await client.get<string[]>(
        `/apps/${appName}/eval_sets/${evalSetId}/evals`,
      );
      expect(listEvalsRes2.data).not.toContain('case_1');
    });

    it('should list and get eval results', async () => {
      const resultsManager = new LocalEvalSetResultsManager(tempAgentsDir);
      const caseResults = [
        {
          evalSetFile: 'test.json',
          evalSetId: 'set1',
          evalId: 'c1',
          finalEvalStatus: 'PASSED' as const,
          overallEvalMetricResults: [],
          evalMetricResultPerInvocation: [],
          sessionId: 's1',
          userId: 'u1',
        },
      ];
      const savedResult = await resultsManager.saveEvalSetResult(
        appName,
        'set1',
        caseResults,
      );

      const listRes = await client.get<{evalResultIds: string[]}>(
        `/apps/${appName}/eval_results`,
      );
      expect(listRes.status).toBe(200);
      expect(listRes.data!.evalResultIds).toContain(
        savedResult.evalSetResultName,
      );

      const getRes = await client.get<EvalSetResult>(
        `/apps/${appName}/eval_results/${savedResult.evalSetResultName}`,
      );
      expect(getRes.status).toBe(200);
      expect(getRes.data!.evalSetResultId).toBe(savedResult.evalSetResultId);
      expect(getRes.data!.evalCaseResults.length).toBe(1);
    });

    it('should run evaluation', async () => {
      // Create eval set
      await client.post(`/apps/${appName}/eval_sets/${evalSetId}`);

      // Add a case with a conversation
      const session = await sessionService.createSession({
        appName,
        userId: 'u1',
        sessionId: 's1',
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: 'inv1',
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello'}]},
        }),
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: 'inv1',
          author: 'agent',
          content: {role: 'model', parts: [{text: 'hi'}]},
        }),
      });

      await client.post(`/apps/${appName}/eval_sets/${evalSetId}/add_session`, {
        userId: 'u1',
        sessionId: 's1',
        evalId: 'case_1',
      });

      // Run eval
      const runRes = await client.post<EvalSetResult>(
        `/apps/${appName}/eval_sets/${evalSetId}/run_eval`,
      );
      expect(runRes.status).toBe(200);
      expect(runRes.data!.evalSetId).toBe(evalSetId);
      expect(runRes.data!.evalCaseResults.length).toBe(1);

      const caseResult = runRes.data!.evalCaseResults[0];
      expect(caseResult.evalId).toBe('case_1');
      expect(caseResult.finalEvalStatus).toBe('NOT_EVALUATED');
      expect(caseResult.evalMetricResultPerInvocation.length).toBe(1);

      const invResult = caseResult.evalMetricResultPerInvocation[0];
      expect(invResult.expectedInvocation).toBeDefined();
      expect(invResult.expectedInvocation!.userContent.parts[0].text).toBe(
        'hello',
      );
      expect(invResult.actualInvocation).toBeDefined();
      expect(invResult.actualInvocation.userContent.parts[0].text).toBe(
        'hello',
      );
      expect(invResult.actualInvocation.finalResponse).toBeDefined();
    });

    it('should return 404 if eval set not found for run_eval', async () => {
      try {
        await client.post(`/apps/${appName}/eval_sets/non_existent/run_eval`);
        expect.fail('Should have failed with 404');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 500 if agent fails to load in run_eval', async () => {
      await client.post(`/apps/brokenApp/eval_sets/set1`);
      try {
        await client.post(`/apps/brokenApp/eval_sets/set1/run_eval`);
        expect.fail('Should have failed with 500');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      }
    });

    it('should handle agent execution failure in run_eval', async () => {
      await client.post(`/apps/${appName}/eval_sets/error_set`);

      const session = await sessionService.createSession({
        appName,
        userId: 'u1',
        sessionId: 's1',
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: 'inv1',
          author: 'user',
          content: {role: 'user', parts: [{text: 'throw'}]},
        }),
      });

      await client.post(`/apps/${appName}/eval_sets/error_set/add_session`, {
        userId: 'u1',
        sessionId: 's1',
        evalId: 'case_error',
      });

      const runRes = await client.post<EvalSetResult>(
        `/apps/${appName}/eval_sets/error_set/run_eval`,
      );
      expect(runRes.status).toBe(200);
      expect(runRes.data!.evalCaseResults.length).toBe(1);

      const caseResult = runRes.data!.evalCaseResults[0];
      expect(caseResult.evalId).toBe('case_error');
      expect(caseResult.finalEvalStatus).toBe('NOT_EVALUATED');
      expect(caseResult.evalMetricResultPerInvocation.length).toBe(1);
      const invResult = caseResult.evalMetricResultPerInvocation[0];
      expect(invResult.actualInvocation.finalResponse).toBeUndefined();
    });

    it('should return empty list for eval_metrics', async () => {
      const res = await client.get<unknown[]>(`/apps/${appName}/eval_metrics`);
      expect(res.status).toBe(200);
      expect(res.data).toEqual([]);
    });
  });
});
