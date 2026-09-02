/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentModuleExports,
  App,
  LlmAgent,
  resolveAgentForEval,
} from '@google/adk';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';

/** Resolves a fixture module to the absolute URL a dynamic import accepts. */
function fixtureSpecifier(fileName: string): string {
  return pathToFileURL(path.join(import.meta.dirname, 'fixtures', fileName))
    .href;
}

const AGENT_FIXTURE = fixtureSpecifier('agent.ts');
const WEATHER_FIXTURE = fixtureSpecifier('weather.ts');

function createAgentWithSubAgent(): LlmAgent {
  return new LlmAgent({
    name: 'root_agent',
    subAgents: [new LlmAgent({name: 'weather_agent'})],
  });
}

describe('resolveAgentForEval', () => {
  it('resolves the agent and the app from an `agent` namespace', async () => {
    const rootAgent = new LlmAgent({name: 'root_agent'});
    const app = new App({name: 'weather_app', rootAgent});

    const resolved = await resolveAgentForEval({agent: {rootAgent, app}});

    expect(resolved.agent).toBe(rootAgent);
    expect(resolved.app).toBe(app);
  });

  it('leaves the app undefined when the module exposes none', async () => {
    const rootAgent = new LlmAgent({name: 'root_agent'});

    const resolved = await resolveAgentForEval({rootAgent});

    expect(resolved.agent).toBe(rootAgent);
    expect(resolved.app).toBeUndefined();
  });

  it('ignores an `app` export that is not an App', async () => {
    const rootAgent = new LlmAgent({name: 'root_agent'});

    const resolved = await resolveAgentForEval({
      rootAgent,
      app: {name: 'not_an_app'},
    });

    expect(resolved.app).toBeUndefined();
  });

  it('selects the named sub-agent and still surfaces the app', async () => {
    const rootAgent = createAgentWithSubAgent();
    const app = new App({name: 'weather_app', rootAgent});

    const resolved = await resolveAgentForEval(
      {agent: {rootAgent, app}},
      'weather_agent',
    );

    expect(resolved.agent.name).toBe('weather_agent');
    expect(resolved.app).toBe(app);
  });

  it('calls getAgentAsync when the module binds no rootAgent', async () => {
    const rootAgent = new LlmAgent({name: 'lazy_agent'});
    const moduleExports: AgentModuleExports = {
      getAgentAsync: async () => [rootAgent, {cleanup: true}] as const,
    };

    const resolved = await resolveAgentForEval(moduleExports);

    expect(resolved.agent).toBe(rootAgent);
  });

  it('reports a module that binds neither a rootAgent nor a factory', async () => {
    await expect(
      resolveAgentForEval({agent: {app: undefined}}),
    ).rejects.toThrowError(
      'Module the agent module does not have a rootAgent or getAgentAsync ' +
        'method.',
    );
  });

  it('reports a rootAgent binding that is not an agent', async () => {
    await expect(
      resolveAgentForEval({rootAgent: {name: 'not_an_agent'}}),
    ).rejects.toThrowError(
      'Module the agent module does not expose an agent as its `rootAgent`.',
    );
  });

  it('reports an object that exposes nothing the loader recognises', async () => {
    await expect(resolveAgentForEval({})).rejects.toThrowError(
      'Module the agent module does not have a rootAgent or getAgentAsync ' +
        'method.',
    );
  });

  it('reports a specifier that names neither an agent module nor an `agent`', async () => {
    await expect(resolveAgentForEval(WEATHER_FIXTURE)).rejects.toThrowError(
      `Module ${WEATHER_FIXTURE} does not have a member named \`agent\` or ` +
        'the name should end with `agent`.',
    );
  });

  it('reports a sub-agent name that matches nothing', async () => {
    const rootAgent = createAgentWithSubAgent();

    await expect(
      resolveAgentForEval({rootAgent}, 'missing_agent'),
    ).rejects.toThrowError("Sub-Agent 'missing_agent' not found.");
  });

  it('imports a module named `agent` from its specifier', async () => {
    const resolved = await resolveAgentForEval(AGENT_FIXTURE);

    expect(resolved.agent.name).toBe('fixture_root_agent');
    expect(resolved.app?.name).toBe('fixture_app');
  });
});
