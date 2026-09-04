/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/tools/data_agent/test_data_agent_tool.py`. The ported cases
 * keep their Python names.
 *
 * Python patches `_gda_stream_util.get_gda_session` and `_get_data_agent_info`
 * with `mock.patch.object`. Here the HTTP surface is injected instead, so the
 * same assertions on the URL, the headers and the payload survive, and the
 * preflight read is the real one rather than a stub.
 */

import {describe, expect, it} from 'vitest';
// Not part of the public entry point: these are the module's own seams, so
// they are imported from the source they live in.
import {z} from 'zod';
import {resolveDataAgentToolConfig} from '../../../src/tools/data_agent/config.js';
import {DataAgentCredentialsManager} from '../../../src/tools/data_agent/credentials.js';
import {
  askDataAgent,
  awaitLro,
  createDataAgent,
  createDataAgentTool,
  deleteDataAgent,
  extractLocationFromResourceName,
  getDataAgentInfo,
  listAccessibleDataAgents,
  parseAgentConfig,
  updateDataAgent,
  validateDataAgentName,
  validatePathSegment,
} from '../../../src/tools/data_agent/data_agent_tool.js';
import {
  DEFAULT_ENDPOINT,
  errorOf,
  errorResponse,
  FakeClock,
  FakeGdaSession,
  jsonResponse,
  makeDeps,
  makeToolContext,
  successOf,
} from './data_agent_test_utils.js';

const AGENT_NAME = 'projects/p/locations/g/dataAgents/agent-1';
/** The host location `l` resolves to, since it is neither `eu` nor `us`. */
const LOCATION_L_ENDPOINT = 'https://geminidataanalytics-l.googleapis.com';
const OPERATION_NAME = 'projects/p/locations/g/operations/op-1';
const MUTATION_ENABLED = {
  enableDataAgentModification: true,
  dataAgentModificationTimeoutSeconds: 60,
  dataAgentModificationPollIntervalSeconds: 2,
};
const GDA_HEADERS = {
  'Content-Type': 'application/json',
  'X-Goog-API-Client': 'GOOGLE_ADK',
};

/** An operation that has not finished yet. */
function runningOperation() {
  return jsonResponse({name: OPERATION_NAME, done: false});
}

/** An operation that finished with `response`. */
function finishedOperation(response: unknown) {
  return jsonResponse({name: OPERATION_NAME, done: true, response});
}

/** A failure carrying the error code a dropped connection reports. */
function connectionError(message: string): Error {
  return Object.assign(new Error(message), {code: 'ECONNRESET'});
}

/** Runs `awaitLro` over `session` on a clock only sleeping advances. */
function pollWith(
  session: FakeGdaSession,
  clock: FakeClock,
  initial: ReturnType<typeof jsonResponse>,
  overrides: {deadline?: number; pollIntervalSeconds?: number} = {},
) {
  return awaitLro({
    session,
    baseUrl: `${DEFAULT_ENDPOINT}/v1`,
    headers: {},
    response: initial,
    deadline: overrides.deadline ?? 100,
    pollIntervalSeconds: overrides.pollIntervalSeconds ?? 0.1,
    totalTimeoutSeconds: 60,
    clock,
  });
}

describe('data agent tools, ported from test_data_agent_tool.py', () => {
  it('test_list_accessible_data_agents_success', async () => {
    const {deps, session, factory} = makeDeps();
    session.respond(jsonResponse({dataAgents: ['agent1', 'agent2']}));

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps,
    );

    expect(successOf(result)['response']).toEqual(['agent1', 'agent2']);
    expect(factory.calls).toEqual([{location: 'global'}]);
    expect(session.requests).toEqual([
      {
        method: 'GET',
        url: `${DEFAULT_ENDPOINT}/v1/projects/test-project/locations/global/dataAgents:listAccessible`,
        headers: GDA_HEADERS,
        timeoutSeconds: 30,
      },
    ]);
  });

  it('test_list_accessible_data_agents_exception', async () => {
    const {deps, session, factory} = makeDeps();
    session.respond(new Error('List failed!'));

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps,
    );

    expect(errorOf(result)).toContain('List failed!');
    expect(factory.calls).toEqual([{location: 'global'}]);
    expect(session.requests).toHaveLength(1);
  });

  it('test_get_data_agent_info_success', async () => {
    const {deps, session, factory} = makeDeps();
    session.respond(jsonResponse('agent_info'));

    const result = await getDataAgentInfo('agent_name', deps);

    expect(successOf(result)['response']).toBe('agent_info');
    expect(factory.calls).toEqual([{}]);
    expect(session.requests).toEqual([
      {
        method: 'GET',
        url: `${DEFAULT_ENDPOINT}/v1/agent_name`,
        headers: GDA_HEADERS,
        timeoutSeconds: 30,
      },
    ]);
  });

  it('test_get_data_agent_info_exception', async () => {
    const {deps, session, factory} = makeDeps();
    session.respond(new Error('Get failed!'));

    const result = await getDataAgentInfo('agent_name', deps);

    expect(errorOf(result)).toContain('Get failed!');
    expect(factory.calls).toEqual([{}]);
    expect(session.requests).toHaveLength(1);
  });

  it('test_ask_data_agent_success', async () => {
    // The preflight read derives its own host from the location, so the
    // factory reports the host that location resolves to, as in production.
    const {deps, session, factory} = makeDeps({}, LOCATION_L_ENDPOINT);
    session.respond(
      jsonResponse({name: 'projects/p/locations/l/dataAgents/a'}),
    );
    session.stream(
      '[{',
      '"text": {"parts": ["response1"], "textType": "THOUGHT"}',
      '}',
      ',',
      '{',
      '"text": {"parts": ["response2"], "textType": "FINAL_RESPONSE"}',
      '}]',
    );

    const result = await askDataAgent(
      {dataAgentName: 'projects/p/locations/l/dataAgents/a', query: 'query'},
      deps,
    );

    expect(successOf(result)['response']).toEqual([
      {text: {parts: ['response1'], textType: 'THOUGHT'}},
      {text: {parts: ['response2'], textType: 'FINAL_RESPONSE'}},
    ]);
    expect(factory.calls).toEqual([{location: 'l'}]);
    expect(session.requests[0].url).toBe(
      `${LOCATION_L_ENDPOINT}/v1/projects/p/locations/l/dataAgents/a`,
    );
    expect(session.streams).toEqual([
      {
        url: `${LOCATION_L_ENDPOINT}/v1/projects/p/locations/l:chat`,
        payload: {
          messages: [{userMessage: {text: 'query'}}],
          dataAgentContext: {dataAgent: 'projects/p/locations/l/dataAgents/a'},
          clientIdEnum: 'GOOGLE_ADK',
        },
        headers: GDA_HEADERS,
      },
    ]);
  });

  it('test_ask_data_agent_exception', async () => {
    const {deps, session, factory} = makeDeps();
    session.respond(
      jsonResponse({name: 'projects/p/locations/l/dataAgents/a'}),
    );
    session.failStream(new Error('Chat failed!'));

    const result = await askDataAgent(
      {dataAgentName: 'projects/p/locations/l/dataAgents/a', query: 'query'},
      deps,
    );

    expect(errorOf(result)).toContain('Chat failed!');
    expect(factory.calls).toEqual([{location: 'l'}]);
    expect(session.streams).toHaveLength(1);
  });

  it('test_extract_location_from_resource_name', () => {
    expect(
      extractLocationFromResourceName('projects/p/locations/eu/dataAgents/a_1'),
    ).toBe('eu');
    expect(
      extractLocationFromResourceName('projects/p/locations/us/dataAgents/a_2'),
    ).toBe('us');
    expect(
      extractLocationFromResourceName(
        'projects/p/locations/global/dataAgents/a_3',
      ),
    ).toBe('global');
    expect(extractLocationFromResourceName('invalid_name')).toBeUndefined();
  });

  it('test_get_data_agent_info_auto_extract_location', async () => {
    const {deps, session, factory} = makeDeps({location: undefined});
    session.respond(jsonResponse({name: 'agent_eu'}));

    const result = await getDataAgentInfo(
      'projects/my-proj/locations/eu/dataAgents/my-agent',
      deps,
    );

    expect(successOf(result)['response']).toEqual({name: 'agent_eu'});
    expect(factory.calls).toEqual([{location: 'eu'}]);
    // adk-python asserts the location passed to `get_gda_endpoint`; here the
    // endpoint helper is not injected, so the URL it produced is asserted.
    expect(session.lastRequest().url).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com/v1/projects/my-proj/locations/eu/dataAgents/my-agent',
    );
  });

  it('test_list_accessible_data_agents_regional', async () => {
    const {deps, session, factory} = makeDeps(
      {location: 'eu'},
      'https://geminidataanalytics.eu.rep.googleapis.com',
    );
    session.respond(jsonResponse({dataAgents: ['agent_eu']}));

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps,
    );

    expect(successOf(result)['response']).toEqual(['agent_eu']);
    expect(factory.calls).toEqual([{location: 'eu'}]);
    expect(session.lastRequest().url).toBe(
      'https://geminidataanalytics.eu.rep.googleapis.com/v1/projects/test-project/locations/eu/dataAgents:listAccessible',
    );
  });

  it('test_list_accessible_data_agents_explicit_location', async () => {
    const {deps, session, factory} = makeDeps(
      {location: 'eu'},
      'https://geminidataanalytics.us.rep.googleapis.com',
    );
    session.respond(jsonResponse({dataAgents: ['agent_us']}));

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project', location: 'us'},
      deps,
    );

    expect(successOf(result)['response']).toEqual(['agent_us']);
    expect(factory.calls).toEqual([{location: 'us'}]);
    expect(session.lastRequest().url).toBe(
      'https://geminidataanalytics.us.rep.googleapis.com/v1/projects/test-project/locations/us/dataAgents:listAccessible',
    );
  });

  it('test_list_accessible_data_agents_invalid_location', async () => {
    const {deps, factory} = makeDeps();

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project', location: 'invalid/segment'},
      deps,
    );

    expect(errorOf(result)).toContain('Invalid location format');
    expect(factory.calls).toEqual([]);
  });

  it('test_list_accessible_data_agents_invalid_project_id', async () => {
    const {deps, factory} = makeDeps();

    const result = await listAccessibleDataAgents(
      {projectId: 'invalid/project'},
      deps,
    );

    expect(errorOf(result)).toContain('Invalid project_id format');
    expect(factory.calls).toEqual([]);
  });

  it('test_create_data_agent_success', async () => {
    const {deps, session, factory} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'agent1'}));

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: '{"displayName": "test"}',
        location: 'us-central1',
      },
      deps,
    );

    expect(successOf(result)['response']).toEqual({name: 'agent1'});
    expect(factory.calls).toEqual([{location: 'us-central1'}]);
    expect(session.requests).toEqual([
      {
        method: 'POST',
        url: `${DEFAULT_ENDPOINT}/v1/projects/test-project/locations/us-central1/dataAgents`,
        headers: GDA_HEADERS,
        timeoutSeconds: 30,
        params: {dataAgentId: 'new-agent'},
        body: {displayName: 'test'},
      },
    ]);
  });

  it('test_create_data_agent_non_2xx', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(errorResponse(400, 'Bad Request'));

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: '{"displayName": "test"}',
      },
      deps,
    );

    expect(errorOf(result)).toContain(
      'API returned error status: 400 Bad Request',
    );
  });

  it('test_create_data_agent_malformed_config', async () => {
    const {deps, factory} = makeDeps(MUTATION_ENABLED);

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: 'invalid-json',
      },
      deps,
    );

    expect(errorOf(result)).toContain('Invalid agent_config:');
    expect(factory.calls).toEqual([]);
  });

  it('test_create_data_agent_non_dict_config', async () => {
    const {deps} = makeDeps(MUTATION_ENABLED);

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: '[1, 2]',
      },
      deps,
    );

    expect(errorOf(result)).toContain('agent_config must be a dictionary');
  });

  it('test_create_data_agent_creation_disabled', async () => {
    const {deps, factory} = makeDeps();

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: '{"displayName": "test"}',
      },
      deps,
    );

    expect(errorOf(result)).toContain('Data agent mutation is disabled');
    expect(factory.calls).toEqual([]);
  });

  it('test_create_data_agent_exception', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(new Error('Post failed!'));

    const result = await createDataAgent(
      {
        projectId: 'test-project',
        dataAgentId: 'new-agent',
        agentConfig: '{"displayName": "test"}',
      },
      deps,
    );

    expect(errorOf(result)).toContain('Post failed!');
  });

  it('test_create_data_agent_is_coroutine_function', () => {
    // adk-python asserts `inspect.iscoroutinefunction`. The TypeScript
    // equivalent is that the tool answers with a promise the caller awaits.
    const {deps} = makeDeps(MUTATION_ENABLED);
    const pending = createDataAgent(
      {projectId: 'p', dataAgentId: 'a', agentConfig: 'invalid-json'},
      deps,
    );
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).resolves.toMatchObject({status: 'ERROR'});
  });

  it('test_create_data_agent_lro_polls_until_done', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(
      runningOperation(),
      runningOperation(),
      finishedOperation({name: 'projects/p/locations/g/dataAgents/new-agent'}),
    );

    const result = await createDataAgent(
      {
        projectId: 'p',
        dataAgentId: 'new-agent',
        agentConfig: '{"displayName": "test"}',
      },
      deps,
    );

    expect(successOf(result)['response']).toEqual({
      name: 'projects/p/locations/g/dataAgents/new-agent',
    });
    expect(session.requests).toHaveLength(3);
    expect(session.lastRequest()).toEqual({
      method: 'GET',
      url: `${DEFAULT_ENDPOINT}/v1/${OPERATION_NAME}`,
      headers: GDA_HEADERS,
      timeoutSeconds: 30,
    });
  });

  it('test_create_data_agent_accepts_dict_from_programmatic_caller', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'agent1', done: true}));

    const result = await createDataAgent(
      {
        projectId: 'p',
        dataAgentId: 'new-agent',
        agentConfig: {displayName: 'test'},
      },
      deps,
    );

    expect(successOf(result)).toBeDefined();
    expect(session.requests).toHaveLength(1);
    expect(session.lastRequest()).toMatchObject({
      method: 'POST',
      url: `${DEFAULT_ENDPOINT}/v1/projects/p/locations/global/dataAgents`,
      params: {dataAgentId: 'new-agent'},
      body: {displayName: 'test'},
    });
  });

  it('test_await_lro_returns_immediately_when_done', async () => {
    const session = new FakeGdaSession();
    const result = await pollWith(
      session,
      new FakeClock(),
      finishedOperation({name: AGENT_NAME}),
      {pollIntervalSeconds: 2},
    );

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_non_operation_name_returns_immediately', async () => {
    const session = new FakeGdaSession();
    const result = await pollWith(
      session,
      new FakeClock(),
      jsonResponse({name: AGENT_NAME}),
      {pollIntervalSeconds: 2},
    );

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_polls_until_done', async () => {
    const session = new FakeGdaSession().respond(
      runningOperation(),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await awaitLro({
      session,
      baseUrl: `${DEFAULT_ENDPOINT}/v1`,
      headers: {'X-Test': '1'},
      response: runningOperation(),
      deadline: 100,
      pollIntervalSeconds: 0.1,
      totalTimeoutSeconds: 60,
      clock: new FakeClock(),
    });

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toHaveLength(2);
    expect(session.lastRequest()).toMatchObject({
      url: `${DEFAULT_ENDPOINT}/v1/${OPERATION_NAME}`,
      headers: {'X-Test': '1'},
    });
  });

  it('test_await_lro_operation_error', async () => {
    const session = new FakeGdaSession().respond(
      jsonResponse({
        name: OPERATION_NAME,
        done: true,
        error: {code: 400, message: 'Mutation invalid'},
      }),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Mutation invalid');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it('test_await_lro_poll_http_error', async () => {
    const session = new FakeGdaSession().respond(
      errorResponse(400, 'Bad Request'),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain(
      'Polling failed with status: 400 Bad Request',
    );
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it.each([429, 500, 502, 503, 504])(
    'test_await_lro_retryable_http_error_recovers [%i]',
    async (code) => {
      const session = new FakeGdaSession().respond(
        errorResponse(code, 'Retryable Error'),
        finishedOperation({name: AGENT_NAME}),
      );

      const result = await pollWith(
        session,
        new FakeClock(),
        runningOperation(),
      );

      expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
      expect(session.requests).toHaveLength(2);
    },
  );

  it('test_await_lro_connection_error_retries_and_recovers', async () => {
    const session = new FakeGdaSession().respond(
      connectionError('Temporary network failure'),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
    expect(session.requests).toHaveLength(2);
  });

  it('test_await_lro_poll_invalid_json', async () => {
    const session = new FakeGdaSession().respond({
      ok: true,
      status: 200,
      text: 'not json',
    });

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Polling returned invalid JSON');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it.each([
    'agent-1',
    'projects/p/locations/g/dataAgents/',
    'projects/p/locations/g/dataAgents/a/extra',
    'projects/p/locations/g/dataAgents/a\n',
    'projects/p/locations/g/dataAgents/..',
    'projects/../locations/../dataAgents/x',
  ])('test_validate_data_agent_name_invalid [%j]', (badName) => {
    const error = validateDataAgentName(badName);
    expect(error?.status).toBe('ERROR');
    expect(error?.error_details).toContain('Invalid data_agent_name format');
  });

  it('test_await_lro_unpollable_operation_not_done_returns_error', async () => {
    const session = new FakeGdaSession();

    const result = await pollWith(
      session,
      new FakeClock(),
      jsonResponse({name: 'invalid-op-name', done: false}),
    );

    expect(errorOf(result)).toContain(
      'Operation is not completed and does not contain a pollable',
    );
    expect(session.requests).toEqual([]);
  });

  it('test_await_lro_timeout', async () => {
    const clock = new FakeClock();
    const session = new FakeGdaSession().respond(() => {
      clock.seconds += 30;
      return runningOperation();
    });

    const result = await awaitLro({
      session,
      baseUrl: `${DEFAULT_ENDPOINT}/v1`,
      headers: {},
      response: runningOperation(),
      deadline: clock.now() + 10,
      pollIntervalSeconds: 0.1,
      totalTimeoutSeconds: 10,
      clock,
    });

    expect(errorOf(result)).toContain('did not complete within');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
  });

  it('test_await_lro_poll_network_exception', async () => {
    const session = new FakeGdaSession().respond(
      new Error('Network unreachable'),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(errorOf(result)).toContain('Network unreachable');
    expect(result).toMatchObject({operation_name: OPERATION_NAME});
    expect(session.requests).toHaveLength(1);
  });

  it('test_delete_data_agent_success', async () => {
    const {deps, session, factory} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'operations/op-1', done: true}));

    const result = await deleteDataAgent(AGENT_NAME, deps);

    expect(successOf(result)).toBeDefined();
    expect(factory.calls).toEqual([{location: 'g'}]);
    expect(session.requests).toEqual([
      {
        method: 'DELETE',
        url: `${DEFAULT_ENDPOINT}/v1/${AGENT_NAME}`,
        headers: GDA_HEADERS,
        timeoutSeconds: 30,
        params: undefined,
        body: undefined,
      },
    ]);
  });

  it('test_delete_data_agent_disabled', async () => {
    const {deps} = makeDeps();
    const result = await deleteDataAgent(AGENT_NAME, deps);
    expect(errorOf(result)).toContain('mutation is disabled');
  });

  it('test_delete_data_agent_endpoint_matches_resource_name', async () => {
    const {deps, session, factory} = makeDeps({
      ...MUTATION_ENABLED,
      location: 'eu',
    });
    session.respond(jsonResponse({name: 'op-1', done: true}));

    const result = await deleteDataAgent(
      'projects/p/locations/us/dataAgents/agent-1',
      deps,
    );

    expect(successOf(result)).toBeDefined();
    expect(factory.calls).toEqual([{location: 'us'}]);
  });

  it.each([
    {value: 'my-project', fieldName: 'project_id', valid: true},
    {value: 'global', fieldName: 'location', valid: true},
    {value: 'agent-123', fieldName: 'data_agent_id', valid: true},
    {value: 'p/locations', fieldName: 'project_id', valid: false},
    {value: '..', fieldName: 'location', valid: false},
    {value: 'agent?x=1', fieldName: 'data_agent_id', valid: false},
  ])('test_validate_path_segment [$value]', ({value, fieldName, valid}) => {
    const error = validatePathSegment(value, fieldName);
    if (valid) {
      expect(error).toBeUndefined();
      return;
    }
    expect(error?.error_details).toContain(`Invalid ${fieldName} format`);
  });

  it('test_create_data_agent_invalid_path_segment', async () => {
    const {deps} = makeDeps(MUTATION_ENABLED);

    const result = await createDataAgent(
      {
        projectId: 'my/project',
        dataAgentId: 'my-agent',
        agentConfig: {displayName: 'Test'},
      },
      deps,
    );

    expect(errorOf(result)).toContain('Invalid project_id format');
  });

  it('test_update_data_agent_success', async () => {
    const {deps, session, factory} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'operations/op-1', done: true}));

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: '{"displayName": "updated"}',
        updateMask: 'displayName',
      },
      deps,
    );

    expect(successOf(result)).toBeDefined();
    expect(factory.calls).toEqual([{location: 'g'}]);
    expect(session.lastRequest()).toMatchObject({
      method: 'PATCH',
      url: `${DEFAULT_ENDPOINT}/v1/${AGENT_NAME}`,
      params: {updateMask: 'displayName'},
      body: {displayName: 'updated'},
    });
  });

  it('test_update_data_agent_disabled', async () => {
    const {deps} = makeDeps();

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: '{"displayName": "updated"}',
        updateMask: 'displayName',
      },
      deps,
    );

    expect(errorOf(result)).toContain('mutation is disabled');
  });

  it('test_update_data_agent_missing_mask_field_rejected', async () => {
    const {deps, factory} = makeDeps(MUTATION_ENABLED);

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: '{"displayName": "updated"}',
        updateMask: 'displayName,description',
      },
      deps,
    );

    expect(errorOf(result)).toContain(
      'update_mask fields description are not present',
    );
    expect(factory.calls).toEqual([]);
  });

  it('test_update_data_agent_missing_nested_mask_field_rejected', async () => {
    const {deps} = makeDeps(MUTATION_ENABLED);

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: '{"dataAnalyticsAgent": {}}',
        updateMask: 'dataAnalyticsAgent.publishedContext.systemInstruction',
      },
      deps,
    );

    expect(errorOf(result)).toContain(
      'update_mask fields' +
        ' dataAnalyticsAgent.publishedContext.systemInstruction are not present',
    );
  });

  it('test_update_data_agent_nested_mask_field_success', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'operations/op-1', done: true}));

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig:
          '{"dataAnalyticsAgent": {"publishedContext": {"systemInstruction":' +
          ' "test"}}}',
        updateMask: 'dataAnalyticsAgent.publishedContext.systemInstruction',
      },
      deps,
    );

    expect(successOf(result)).toBeDefined();
  });

  it('test_update_data_agent_empty_mask_error', async () => {
    const {deps} = makeDeps(MUTATION_ENABLED);

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: '{"displayName": "New"}',
        updateMask: '   ',
      },
      deps,
    );

    expect(errorOf(result)).toContain(
      'update_mask must be a non-empty comma-separated list',
    );
  });

  it('test_update_data_agent_invalid_name_error', async () => {
    const {deps} = makeDeps(MUTATION_ENABLED);

    const result = await updateDataAgent(
      {
        dataAgentName: 'invalid-name',
        agentConfig: '{"displayName": "New"}',
        updateMask: 'displayName',
      },
      deps,
    );

    expect(errorOf(result)).toContain('Invalid data_agent_name format');
  });

  it('test_update_data_agent_accepts_dict_from_programmatic_caller', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'op-1', done: true}));

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: {displayName: 'dict-config'},
        updateMask: 'displayName',
      },
      deps,
    );

    expect(successOf(result)).toBeDefined();
    expect(session.requests).toHaveLength(1);
    expect(session.lastRequest()).toMatchObject({
      method: 'PATCH',
      url: `${DEFAULT_ENDPOINT}/v1/${AGENT_NAME}`,
      params: {updateMask: 'displayName'},
      body: {displayName: 'dict-config'},
    });
  });

  it('test_update_data_agent_endpoint_matches_resource_name', async () => {
    const {deps, session, factory} = makeDeps({
      ...MUTATION_ENABLED,
      location: 'eu',
    });
    session.respond(jsonResponse({name: 'op-1', done: true}));

    const result = await updateDataAgent(
      {
        dataAgentName: 'projects/p/locations/us/dataAgents/agent-1',
        agentConfig: '{"displayName": "New"}',
        updateMask: 'displayName',
      },
      deps,
    );

    expect(successOf(result)).toBeDefined();
    expect(factory.calls).toEqual([{location: 'us'}]);
  });
});

describe('validators', () => {
  it('accepts a well-formed data agent name', () => {
    expect(validateDataAgentName(AGENT_NAME)).toBeUndefined();
  });

  it('reads no location from a name that ends in locations', () => {
    expect(
      extractLocationFromResourceName('projects/p/locations'),
    ).toBeUndefined();
  });
});

describe('parseAgentConfig', () => {
  it('accepts an object a programmatic caller already parsed', () => {
    expect(parseAgentConfig({displayName: 'a'})).toEqual({displayName: 'a'});
  });

  it('names the type it refused', () => {
    expect(() => parseAgentConfig('null')).toThrow('got null');
    expect(() => parseAgentConfig('7')).toThrow('got number');
    expect(() => parseAgentConfig([1])).toThrow('got array');
  });
});

describe('listAccessibleDataAgents', () => {
  it('answers with no agents when the body carries none', async () => {
    const {deps, session} = makeDeps();
    session.respond(jsonResponse({}));

    const result = await listAccessibleDataAgents({projectId: 'p'}, deps);

    expect(successOf(result)['response']).toEqual([]);
  });

  it('reports a non-2xx status to the model', async () => {
    const {deps, session} = makeDeps();
    session.respond(errorResponse(403, 'denied'));

    const result = await listAccessibleDataAgents({projectId: 'p'}, deps);

    expect(errorOf(result)).toContain('API returned error status: 403 denied');
  });

  it('sends the request to a pinned api endpoint', async () => {
    const {deps, session, factory} = makeDeps(
      {apiEndpoint: 'https://gda.test'},
      'https://gda.test',
    );
    session.respond(jsonResponse({dataAgents: []}));

    await listAccessibleDataAgents({projectId: 'p'}, deps);

    expect(factory.calls).toEqual([
      {location: 'global', apiEndpoint: 'https://gda.test'},
    ]);
    expect(session.lastRequest().url).toBe(
      'https://gda.test/v1/projects/p/locations/global/dataAgents:listAccessible',
    );
  });
});

describe('askDataAgent', () => {
  it('returns the preflight error and never reaches the chat endpoint', async () => {
    const {deps, session} = makeDeps();
    session.respond(errorResponse(404, 'no such agent'));

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'how many rows?'},
      deps,
    );

    expect(errorOf(result)).toContain('404 no such agent');
    expect(session.streams).toEqual([]);
  });

  it('keeps the location out of the request when an endpoint is pinned', async () => {
    const {deps, session, factory} = makeDeps(
      {apiEndpoint: 'https://gda.test'},
      'https://gda.test',
    );
    session.respond(jsonResponse({name: AGENT_NAME}));
    session.stream('[{', '"systemMessage": {"text": "hi"}', '}]');

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'q'},
      deps,
    );

    expect(successOf(result)['response']).toEqual([{text: 'hi'}]);
    expect(factory.calls).toEqual([{apiEndpoint: 'https://gda.test'}]);
    expect(session.streams[0].url).toBe(
      'https://gda.test/v1/projects/p/locations/g:chat',
    );
  });

  it('truncates the rows to the configured maximum', async () => {
    const {deps, session} = makeDeps({maxQueryResultRows: 1});
    session.respond(jsonResponse({name: AGENT_NAME}));
    session.stream(
      '{"systemMessage":{"data":{"result":{"data":[{"a":1},{"a":2}]}}}}',
    );

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'q'},
      deps,
    );

    expect(successOf(result)['response']).toEqual([
      {
        'Data Retrieved': {
          headers: ['a'],
          rows: [[1]],
          summary: 'Showing the first 1 of 2 total rows.',
        },
      },
    ]);
  });
});

describe('awaitLro', () => {
  it('reports the mutation status when the mutation itself failed', async () => {
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      errorResponse(500, 'boom'),
    );

    expect(errorOf(result)).toBe('API returned error status: 500 boom');
    expect(result).not.toHaveProperty('operation_name');
  });

  it('reads a finished operation that carries no response field', async () => {
    const operation = {name: OPERATION_NAME, done: true};
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      jsonResponse(operation),
    );

    expect(successOf(result)['response']).toEqual(operation);
  });

  it('gives up on a retryable status once the budget is spent', async () => {
    const session = new FakeGdaSession().respond(errorResponse(503, 'busy'));
    const clock = new FakeClock();

    const result = await pollWith(session, clock, runningOperation(), {
      deadline: 1,
      pollIntervalSeconds: 2,
    });

    expect(errorOf(result)).toContain('Polling failed with status: 503 busy');
    expect(session.requests).toHaveLength(1);
  });

  it('gives up on a dropped connection once the budget is spent', async () => {
    const session = new FakeGdaSession().respond(connectionError('reset'));

    const result = await pollWith(
      session,
      new FakeClock(),
      runningOperation(),
      {
        deadline: 1,
        pollIntervalSeconds: 2,
      },
    );

    expect(errorOf(result)).toContain('Polling failed with exception: reset');
    expect(session.requests).toHaveLength(1);
  });

  it('retries after an aborted request', async () => {
    const session = new FakeGdaSession().respond(
      Object.assign(new Error('timed out'), {name: 'TimeoutError'}),
      finishedOperation({name: AGENT_NAME}),
    );

    const result = await pollWith(session, new FakeClock(), runningOperation());

    expect(successOf(result)['response']).toEqual({name: AGENT_NAME});
  });

  it('reports the timeout without polling when the budget is already spent', async () => {
    const session = new FakeGdaSession();

    const result = await pollWith(
      session,
      new FakeClock(),
      runningOperation(),
      {
        deadline: 0,
      },
    );

    expect(errorOf(result)).toContain('did not complete within');
    expect(session.requests).toEqual([]);
  });

  it('stops after a poll that leaves no budget for another', async () => {
    const clock = new FakeClock();
    const session = new FakeGdaSession().respond(() => {
      clock.seconds += 5;
      return runningOperation();
    });

    const result = await pollWith(session, clock, runningOperation(), {
      deadline: 5,
    });

    expect(errorOf(result)).toContain('did not complete within');
    expect(session.requests).toHaveLength(1);
  });

  it('answers with a bare success for a body that is not an object', async () => {
    const result = await pollWith(
      new FakeGdaSession(),
      new FakeClock(),
      jsonResponse('finished'),
    );

    expect(successOf(result)['response']).toEqual({});
  });
});

describe('createDataAgentTool', () => {
  const settings = resolveDataAgentToolConfig();
  const definition = {
    name: 'probe_tool',
    description: 'A tool that reports what it was given.',
    parameters: z.object({value: z.string()}),
    run: async (args: {value: string}) => ({
      status: 'SUCCESS' as const,
      response: args.value,
    }),
  };

  it('keeps the credentials and the settings out of the declaration', () => {
    const tool = createDataAgentTool(undefined, settings, definition);
    const declared = tool._getDeclaration().parameters?.properties ?? {};
    expect(Object.keys(declared)).toEqual(['value']);
  });

  it('runs without a credentials manager', async () => {
    const tool = createDataAgentTool(undefined, settings, definition);
    const result = await tool.runAsync({
      args: {value: 'ok'},
      toolContext: makeToolContext(),
    });
    expect(result).toEqual({status: 'SUCCESS', response: 'ok'});
  });

  it('asks the user to authorize when the OAuth flow is in flight', async () => {
    const credentials = new DataAgentCredentialsManager({
      clientId: 'abc',
      clientSecret: 'def',
    });
    const tool = createDataAgentTool(credentials, settings, definition);

    const result = await tool.runAsync({
      args: {value: 'ok'},
      toolContext: makeToolContext(),
    });

    expect(result).toBe(
      'User authorization is required to access Google services for' +
        ' probe_tool. Please complete the authorization flow.',
    );
  });

  it('turns a credential failure into an error result', async () => {
    const credentials = new DataAgentCredentialsManager({
      externalAccessTokenKey: 'missing_key',
    });
    const tool = createDataAgentTool(credentials, settings, definition);

    const result = await tool.runAsync({
      args: {value: 'ok'},
      toolContext: makeToolContext(),
    });

    expect(errorOf(result)).toContain(
      'external_access_token_key is provided but no access token found in' +
        ' tool_context.state with key missing_key.',
    );
  });
});
