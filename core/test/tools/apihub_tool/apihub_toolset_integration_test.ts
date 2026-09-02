/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APIHubToolset,
  BaseAPIHubClient,
  BaseTool,
  OpenAPIToolset,
} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

const SPEC_PATH = path.resolve(
  __dirname,
  '../openapi_tool/fixtures/truanon.yaml',
);
const RESOURCE_NAME =
  'projects/p/locations/us-central1/apis/truanon/versions/v1/specs/s1';

/** Serves a spec read from disk, standing in for the API Hub service. */
class FileAPIHubClient implements BaseAPIHubClient {
  constructor(private readonly spec: string) {}

  async getSpecContent(_resourceName: string): Promise<string> {
    return this.spec;
  }
}

function declarationOf(tool: BaseTool): unknown {
  return tool._getDeclaration();
}

describe('APIHubToolset with a real OpenAPI spec', () => {
  let spec: string;

  beforeAll(() => {
    spec = fs.readFileSync(SPEC_PATH, 'utf8');
  });

  it('should generate the same tools as OpenAPIToolset does from the spec', async () => {
    const apihubToolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FileAPIHubClient(spec),
    });
    const openapiToolset = new OpenAPIToolset({
      specStr: spec,
      specType: 'yaml',
    });

    const apihubTools = await apihubToolset.getTools();
    const openapiTools = await openapiToolset.getTools();

    expect(apihubTools.map((tool) => tool.name)).toEqual([
      'get_profile',
      'get_token',
    ]);
    expect(apihubTools.map((tool) => tool.name)).toEqual(
      openapiTools.map((tool) => tool.name),
    );
    expect(apihubTools.map(declarationOf)).toEqual(
      openapiTools.map(declarationOf),
    );
  });

  it('should name itself from the spec title and description', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FileAPIHubClient(spec),
    });

    await toolset.getTools();

    expect(toolset.name).toBe('tru_anon_private_api');
    expect(toolset.description).toContain('Welcome to TruAnon!');
  });

  it('should expose only the tools the filter names', async () => {
    const toolset = new APIHubToolset({
      apihubResourceName: RESOURCE_NAME,
      apihubClient: new FileAPIHubClient(spec),
      toolFilter: ['get_token'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['get_token']);
  });
});
