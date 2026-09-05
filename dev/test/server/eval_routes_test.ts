/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
  setEvalRuntime,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {StubEvalRuntime} from '../cli/stub_eval_runtime.js';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'eval_source_session';
const EVAL_SET_ID = 'my_eval_set';

class EchoAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {parts: [{text: '4'}], role: 'model'},
    });
  }
}

const ROOT_AGENT = new EchoAgent({
  name: 'echo_agent',
  description: 'answers arithmetic',
  instruction: 'Answer as {persona} would.',
});

function loaderFor(agent: LlmAgent): AgentLoader {
  return {
    listAgents: () => Promise.resolve([APP_NAME]),
    loadAgent: () => Promise.resolve(agent),
    getAgentFile: () =>
      Promise.resolve({
        load: () => Promise.resolve(agent),
        async [Symbol.asyncDispose](): Promise<void> {
          return;
        },
      }),
  } as unknown as AgentLoader;
}

interface HttpResult<T> {
  status: number;
  body: T;
}

/** Sends a request and reads the body as JSON when the server sent JSON. */
async function request<T>(
  baseUrl: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers:
      body === undefined ? undefined : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = response.headers
    .get('content-type')
    ?.includes('application/json');
  return {
    status: response.status,
    body: (isJson ? await response.json() : await response.text()) as T,
  };
}

describe('eval routes', () => {
  let agentsDir: string;
  let sessionService: InMemorySessionService;
  let server: AdkApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-eval-agents-'));
    fs.mkdirSync(path.join(agentsDir, APP_NAME));
    sessionService = new InMemorySessionService();
    server = new AdkApiServer({
      agentsDir,
      serveDebugUI: true,
      agentLoader: loaderFor(ROOT_AGENT),
      sessionService,
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
      evalSetsManager: new LocalEvalSetsManager(agentsDir),
      evalSetResultsManager: new LocalEvalSetResultsManager(agentsDir),
    });
    await server.start();
    baseUrl = server.url;
  });

  afterEach(async () => {
    await server.stop();
    setEvalRuntime(undefined);
    fs.rmSync(agentsDir, {recursive: true, force: true});
  });

  function get<T>(url: string): Promise<HttpResult<T>> {
    return request<T>(baseUrl, 'GET', url);
  }

  function post<T>(url: string, body?: unknown): Promise<HttpResult<T>> {
    return request<T>(baseUrl, 'POST', url, body ?? {});
  }

  function put<T>(url: string, body: unknown): Promise<HttpResult<T>> {
    return request<T>(baseUrl, 'PUT', url, body);
  }

  function del<T>(url: string): Promise<HttpResult<T>> {
    return request<T>(baseUrl, 'DELETE', url);
  }

  function createEvalSet(evalSetId = EVAL_SET_ID) {
    return post<{evalSetId: string}>(`/dev/apps/${APP_NAME}/eval-sets`, {
      evalSet: {evalSetId},
    });
  }

  async function createSourceSession(): Promise<void> {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      state: {},
    });
    await sessionService.appendEvent({
      session: (await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      }))!,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'what is 2+2?'}]},
      }),
    });
    await sessionService.appendEvent({
      session: (await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      }))!,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'echo_agent',
        content: {role: 'model', parts: [{text: '4'}]},
      }),
    });
  }

  function addSession(
    evalSetId: string,
    evalId: string,
    sessionId = SESSION_ID,
  ) {
    return post(`/dev/apps/${APP_NAME}/eval-sets/${evalSetId}/add-session`, {
      evalId,
      sessionId,
      userId: USER_ID,
    });
  }

  describe('createEvalSet', () => {
    it('creates the eval set and lists it', async () => {
      const created = await createEvalSet();

      expect(created.status).toBe(200);
      expect(created.body.evalSetId).toBe(EVAL_SET_ID);
      const listed = await get<{evalSetIds: string[]}>(
        `/dev/apps/${APP_NAME}/eval-sets`,
      );
      expect(listed.body.evalSetIds).toEqual([EVAL_SET_ID]);
    });

    it('answers 400 for an eval set id the manager cannot store', async () => {
      const response = await createEvalSet('not a valid id');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Invalid Eval Set ID'),
      });
    });

    it('answers 400 when the body names no eval set id', async () => {
      const response = await post(`/dev/apps/${APP_NAME}/eval-sets`, {});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: 'evalSet.evalSetId is required.',
      });
    });

    it('answers 400 for an eval set id already taken', async () => {
      await createEvalSet();

      const again = await createEvalSet();

      expect(again.status).toBe(400);
    });

    it('creates an eval set from the legacy route', async () => {
      const response = await post(
        `/dev/apps/${APP_NAME}/eval_sets/legacy_eval_set`,
      );

      expect(response.status).toBe(200);
      const listed = await get<string[]>(`/dev/apps/${APP_NAME}/eval_sets`);
      expect(listed.body).toEqual(['legacy_eval_set']);
    });
  });

  describe('listEvalSets', () => {
    it('reports an app with no eval sets as an empty list', async () => {
      const response = await get<{evalSetIds: string[]}>(
        `/dev/apps/unknown_app/eval-sets`,
      );

      expect(response.status).toBe(200);
      expect(response.body.evalSetIds).toEqual([]);
    });
  });

  describe('addSessionToEvalSet', () => {
    it('turns a live session into an eval case', async () => {
      await createEvalSet();
      await createSourceSession();

      const response = await addSession(EVAL_SET_ID, 'my_eval_case');

      expect(response.status).toBe(200);
      const evalCase = await get<{
        sessionInput: {appName: string; userId: string; state: object};
        conversation: Array<{userContent: {parts: Array<{text: string}>}}>;
      }>(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
      );
      expect(evalCase.body.sessionInput.appName).toBe(APP_NAME);
      expect(evalCase.body.sessionInput.userId).toBe(USER_ID);
      expect(
        evalCase.body.conversation.flatMap((invocation) =>
          invocation.userContent.parts.map((part) => part.text),
        ),
      ).toEqual(['what is 2+2?']);
    });

    it("seeds the state keys the agent's instruction reads", async () => {
      await createEvalSet();
      await createSourceSession();

      await addSession(EVAL_SET_ID, 'my_eval_case');

      const evalCase = await get<{sessionInput: {state: object}}>(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
      );
      expect(evalCase.body.sessionInput.state).toEqual({persona: ''});
    });

    it('answers 400 when the session does not exist', async () => {
      await createEvalSet();

      const response = await addSession(EVAL_SET_ID, 'case', 'no_such_session');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: 'Session not found: no_such_session',
      });
    });

    it('answers 400 when the eval set does not exist', async () => {
      await createSourceSession();

      const response = await addSession('missing_eval_set', 'case');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('missing_eval_set'),
      });
    });

    it('answers 400 when the eval case id is already taken', async () => {
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const again = await addSession(EVAL_SET_ID, 'my_eval_case');

      expect(again.status).toBe(400);
      expect(again.body).toMatchObject({
        error: expect.stringContaining('my_eval_case'),
      });
    });
  });

  describe('listEvalsInEvalSet', () => {
    it('lists the eval case ids in order', async () => {
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'b_case');
      await addSession(EVAL_SET_ID, 'a_case');

      const response = await get<string[]>(
        `/dev/apps/${APP_NAME}/eval_sets/${EVAL_SET_ID}/evals`,
      );

      expect(response.body).toEqual(['a_case', 'b_case']);
    });

    it('answers 400, not 404, when the eval set does not exist', async () => {
      const response = await get(
        `/dev/apps/${APP_NAME}/eval_sets/missing_eval_set/evals`,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('getEval', () => {
    it('answers 404 when the eval set does not exist', async () => {
      const response = await get(
        `/dev/apps/${APP_NAME}/eval-sets/missing/eval-cases/case`,
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: 'Eval set `missing` or Eval `case` not found.',
      });
    });

    it('answers 404 when the eval case does not exist', async () => {
      await createEvalSet();

      const response = await get(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/missing`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('updateEval', () => {
    it('replaces the eval case', async () => {
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const response = await put(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
        {evalId: 'my_eval_case', conversation: []},
      );

      expect(response.status).toBe(200);
      const updated = await get<{conversation: unknown[]}>(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
      );
      expect(updated.body.conversation).toEqual([]);
    });

    it('takes the eval id from the path when the body omits it', async () => {
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const response = await put<{evalId: string}>(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
        {conversation: []},
      );

      expect(response.body.evalId).toBe('my_eval_case');
    });

    it('answers 400 when the body names a different eval id', async () => {
      await createEvalSet();

      const response = await put(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
        {evalId: 'another_case', conversation: []},
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: 'Eval id in EvalCase should match the eval id in the API route.',
      });
    });

    it('answers 404 when the eval case does not exist', async () => {
      await createEvalSet();

      const response = await put(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/missing`,
        {evalId: 'missing', conversation: []},
      );

      expect(response.status).toBe(404);
    });
  });

  describe('deleteEval', () => {
    it('removes the eval case', async () => {
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const response = await del(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/my_eval_case`,
      );

      expect(response.status).toBe(200);
      const listed = await get<string[]>(
        `/dev/apps/${APP_NAME}/eval_sets/${EVAL_SET_ID}/evals`,
      );
      expect(listed.body).toEqual([]);
    });

    it('answers 404 when the eval case does not exist', async () => {
      await createEvalSet();

      const response = await del(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/eval-cases/missing`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('runEval', () => {
    it('answers 400 with the missing-dependencies message when no runtime is installed', async () => {
      await createEvalSet();

      const response = await post(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/run`,
        {},
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: MISSING_EVAL_DEPENDENCIES_MESSAGE,
      });
    });

    it('answers 400 when the eval set does not exist', async () => {
      setEvalRuntime(new StubEvalRuntime());

      const response = await post(
        `/dev/apps/${APP_NAME}/eval-sets/missing_eval_set/run`,
        {},
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: 'Eval set `missing_eval_set` not found.',
      });
    });

    it('scores every eval case and reports the results', async () => {
      setEvalRuntime(new StubEvalRuntime());
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const response = await post<{
        runEvalResults: Array<{evalId: string; evalSetId: string}>;
      }>(`/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/run`, {});

      expect(response.status).toBe(200);
      expect(response.body.runEvalResults).toHaveLength(1);
      expect(response.body.runEvalResults[0]).toMatchObject({
        evalId: 'my_eval_case',
        evalSetId: EVAL_SET_ID,
      });
    });

    it('scores only the eval cases the request names', async () => {
      setEvalRuntime(new StubEvalRuntime());
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'first_case');
      await addSession(EVAL_SET_ID, 'second_case');

      const response = await post<{runEvalResults: Array<{evalId: string}>}>(
        `/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/run`,
        {evalIds: ['second_case']},
      );

      expect(
        response.body.runEvalResults.map((result) => result.evalId),
      ).toEqual(['second_case']);
    });

    it('returns a bare list from the legacy run route', async () => {
      setEvalRuntime(new StubEvalRuntime());
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');

      const response = await post<Array<{evalId: string}>>(
        `/dev/apps/${APP_NAME}/eval_sets/${EVAL_SET_ID}/run_eval`,
        {},
      );

      expect(response.body.map((result) => result.evalId)).toEqual([
        'my_eval_case',
      ]);
    });
  });

  describe('eval results', () => {
    async function runOneEval(): Promise<void> {
      setEvalRuntime(new StubEvalRuntime());
      await createEvalSet();
      await createSourceSession();
      await addSession(EVAL_SET_ID, 'my_eval_case');
      await post(`/dev/apps/${APP_NAME}/eval-sets/${EVAL_SET_ID}/run`, {});
    }

    it('lists and reads back a saved result', async () => {
      await runOneEval();

      const listed = await get<{evalResultIds: string[]}>(
        `/dev/apps/${APP_NAME}/eval-results`,
      );
      expect(listed.body.evalResultIds).toHaveLength(1);

      const result = await get<{evalSetId: string}>(
        `/dev/apps/${APP_NAME}/eval-results/${listed.body.evalResultIds[0]}`,
      );
      expect(result.status).toBe(200);
      expect(result.body.evalSetId).toBe(EVAL_SET_ID);
    });

    it('returns a bare list from the legacy list route', async () => {
      await runOneEval();

      const listed = await get<string[]>(`/dev/apps/${APP_NAME}/eval_results`);

      expect(listed.body).toHaveLength(1);
    });

    it('answers 404 for an eval result id that is unknown', async () => {
      const response = await get(
        `/dev/apps/${APP_NAME}/eval-results/no_such_result`,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('metrics info', () => {
    it('describes every metric the registry can score', async () => {
      const response = await get<{
        metricsInfo: Array<{metricName: string}>;
      }>(`/dev/apps/${APP_NAME}/metrics-info`);

      expect(response.status).toBe(200);
      expect(
        response.body.metricsInfo.map((info) => info.metricName).sort(),
      ).toEqual([
        'response_evaluation_score',
        'response_match_score',
        'tool_trajectory_avg_score',
      ]);
    });
  });
});

describe('eval route registration', () => {
  let agentsDir: string;
  let servers: AdkApiServer[];

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-eval-routes-'));
    fs.mkdirSync(path.join(agentsDir, APP_NAME));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    fs.rmSync(agentsDir, {recursive: true, force: true});
  });

  async function startServer(serveDebugUI: boolean): Promise<string> {
    const server = new AdkApiServer({
      agentsDir,
      serveDebugUI,
      agentLoader: loaderFor(ROOT_AGENT),
      sessionService: new InMemorySessionService(),
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
    });
    servers.push(server);
    await server.start();
    return server.url;
  }

  it('serves the paths that used to answer 501 on the API server', async () => {
    const baseUrl = await startServer(false);

    const created = await request(
      baseUrl,
      'POST',
      `/apps/${APP_NAME}/eval_sets/${EVAL_SET_ID}`,
    );
    const listed = await request<string[]>(
      baseUrl,
      'GET',
      `/apps/${APP_NAME}/eval_sets`,
    );

    expect(created.status).toBe(200);
    expect(listed.body).toEqual([EVAL_SET_ID]);
  });

  it('builds the local eval managers from agentsDir by default', async () => {
    const baseUrl = await startServer(false);

    await request(
      baseUrl,
      'POST',
      `/apps/${APP_NAME}/eval_sets/${EVAL_SET_ID}`,
    );

    expect(
      fs.existsSync(path.join(agentsDir, APP_NAME, `${EVAL_SET_ID}.evalset.json`)),
    ).toBe(true);
  });

  it('does not serve the developer UI paths from the API server', async () => {
    const baseUrl = await startServer(false);

    const response = await request(
      baseUrl,
      'GET',
      `/dev/apps/${APP_NAME}/eval-sets`,
    );

    expect(response.status).toBe(404);
  });

  it('serves the developer UI paths from the web server', async () => {
    const baseUrl = await startServer(true);

    const response = await request<{evalSetIds: string[]}>(
      baseUrl,
      'GET',
      `/dev/apps/${APP_NAME}/eval-sets`,
    );

    expect(response.status).toBe(200);
    expect(response.body.evalSetIds).toEqual([]);
  });

  it('serves the legacy eval metrics path on the API server', async () => {
    const baseUrl = await startServer(false);

    const response = await request<{metricsInfo: unknown[]}>(
      baseUrl,
      'GET',
      `/apps/${APP_NAME}/eval_metrics`,
    );

    expect(response.status).toBe(200);
    expect(response.body.metricsInfo).toHaveLength(3);
  });
});
