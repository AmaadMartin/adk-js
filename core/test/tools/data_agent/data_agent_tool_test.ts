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

import {afterEach, describe, expect, it, vi} from 'vitest';
// Not part of the public entry point: these are the module's own seams, so
// they are imported from the source they live in.
import {z} from 'zod';
import {resolveDataAgentToolConfig} from '../../../src/tools/data_agent/config.js';
import {DataAgentCredentialsManager} from '../../../src/tools/data_agent/credentials.js';
import {
  askDataAgent,
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
import {DataAgentToolset} from '../../../src/tools/data_agent/data_agent_toolset.js';
import {
  AGENT_NAME,
  DEFAULT_ENDPOINT,
  errorOf,
  errorResponse,
  finishedOperation,
  jsonResponse,
  makeDeps,
  makeToolContext,
  OPERATION_NAME,
  runningOperation,
  successOf,
} from './data_agent_test_utils.js';

/** The host location `l` resolves to, since it is neither `eu` nor `us`. */
const LOCATION_L_ENDPOINT = 'https://geminidataanalytics-l.googleapis.com';
/** The host `AGENT_NAME`'s own location, `g`, resolves to. */
const LOCATION_G_ENDPOINT = 'https://geminidataanalytics-g.googleapis.com';
const MUTATION_ENABLED = {
  enableDataAgentModification: true,
  dataAgentModificationTimeoutSeconds: 60,
  dataAgentModificationPollIntervalSeconds: 2,
};
const GDA_HEADERS = {
  'Content-Type': 'application/json',
  'X-Goog-API-Client': 'GOOGLE_ADK',
};

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

  it('answers with no agents when the body is not an object', async () => {
    const {deps, session} = makeDeps();
    session.respond(jsonResponse('not an object'));

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

describe('updateDataAgent', () => {
  it('reports a config that is not JSON', async () => {
    const {deps, factory} = makeDeps(MUTATION_ENABLED);

    const result = await updateDataAgent(
      {
        dataAgentName: AGENT_NAME,
        agentConfig: 'invalid-json',
        updateMask: 'displayName',
      },
      deps,
    );

    expect(errorOf(result)).toContain('Invalid agent_config:');
    expect(factory.calls).toEqual([]);
  });
});

describe('deleteDataAgent', () => {
  it('refuses a resource name that is not a data agent', async () => {
    const {deps, factory} = makeDeps(MUTATION_ENABLED);

    const result = await deleteDataAgent('invalid-name', deps);

    expect(errorOf(result)).toContain('Invalid data_agent_name format');
    expect(factory.calls).toEqual([]);
  });

  it('reports a request that never reached the API', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(new Error('Delete failed!'));

    const result = await deleteDataAgent(AGENT_NAME, deps);

    expect(errorOf(result)).toContain('Delete failed!');
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

describe('the six tools, driven through their model-facing schema', () => {
  /**
   * Runs one tool the way a model calls it, over a stubbed `fetch`, and
   * reports the requests that reached the network. This is what pins the
   * snake_case parameter names the model sees, and the mapping from them to
   * the TypeScript arguments each function takes.
   */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    bodies: string[],
  ): Promise<{result: unknown; urls: string[]}> {
    const urls: string[] = [];
    let answered = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = bodies[Math.min(answered, bodies.length - 1)];
        answered += 1;
        return new Response(body, {status: 200});
      }),
    );

    const toolset = new DataAgentToolset({
      dataAgentToolConfig: {enableDataAgentModification: true},
    });
    const tool = (await toolset.getTools()).find((each) => each.name === name);
    if (!tool) {
      return expect.fail(`the toolset exposes no tool named ${name}`);
    }
    const result = await tool.runAsync({args, toolContext: makeToolContext()});
    return {result, urls};
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the agents a project can see', async () => {
    const {result, urls} = await callTool(
      'list_accessible_data_agents',
      {project_id: 'p', location: 'eu'},
      ['{"dataAgents":["a"]}'],
    );

    expect(successOf(result)['response']).toEqual(['a']);
    expect(urls).toEqual([
      'https://geminidataanalytics.eu.rep.googleapis.com/v1/projects/p/locations/eu/dataAgents:listAccessible',
    ]);
  });

  it('reads one agent by resource name', async () => {
    const {result, urls} = await callTool(
      'get_data_agent_info',
      {data_agent_name: AGENT_NAME},
      ['{"name":"agent-1"}'],
    );

    expect(successOf(result)['response']).toEqual({name: 'agent-1'});
    expect(urls).toEqual([`${LOCATION_G_ENDPOINT}/v1/${AGENT_NAME}`]);
  });

  it('asks an agent a question', async () => {
    const {result, urls} = await callTool(
      'ask_data_agent',
      {data_agent_name: AGENT_NAME, query: 'how many rows?'},
      ['{"name":"agent-1"}', '[{\n"systemMessage": {"text": "hi"}\n}]'],
    );

    expect(successOf(result)['response']).toEqual([{text: 'hi'}]);
    expect(urls).toEqual([
      `${LOCATION_G_ENDPOINT}/v1/${AGENT_NAME}`,
      `${LOCATION_G_ENDPOINT}/v1/projects/p/locations/g:chat`,
    ]);
  });

  it('creates an agent from a JSON config string', async () => {
    const {result, urls} = await callTool(
      'create_data_agent',
      {
        project_id: 'p',
        data_agent_id: 'new-agent',
        agent_config: '{"displayName":"test"}',
        location: 'global',
      },
      ['{"name":"agent-1","done":true}'],
    );

    expect(successOf(result)).toBeDefined();
    expect(urls).toEqual([
      `${DEFAULT_ENDPOINT}/v1/projects/p/locations/global/dataAgents?dataAgentId=new-agent`,
    ]);
  });

  it('patches an agent under an update mask', async () => {
    const {result, urls} = await callTool(
      'update_data_agent',
      {
        data_agent_name: AGENT_NAME,
        agent_config: '{"displayName":"new"}',
        update_mask: 'displayName',
      },
      ['{"name":"op","done":true}'],
    );

    expect(successOf(result)).toBeDefined();
    expect(urls).toEqual([
      `${LOCATION_G_ENDPOINT}/v1/${AGENT_NAME}?updateMask=displayName`,
    ]);
  });

  it('deletes an agent', async () => {
    const {result, urls} = await callTool(
      'delete_data_agent',
      {data_agent_name: AGENT_NAME},
      ['{"name":"op","done":true}'],
    );

    expect(successOf(result)).toBeDefined();
    expect(urls).toEqual([`${LOCATION_G_ENDPOINT}/v1/${AGENT_NAME}`]);
  });
});

describe('the system clock', () => {
  it('mutates on real time when no clock is injected', async () => {
    const {deps, session} = makeDeps(MUTATION_ENABLED);
    session.respond(jsonResponse({name: 'op', done: true}));

    const result = await deleteDataAgent(AGENT_NAME, {
      openSession: deps.openSession,
      settings: deps.settings,
    });

    expect(successOf(result)).toBeDefined();
  });
});
