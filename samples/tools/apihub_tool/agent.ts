/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * API Hub tool: a catalogued API becomes a set of tools
 * ../../../docs/guides/tools/apihub_tool/index.md
 *
 * `APIHubToolset` resolves an API Hub resource name to one OpenAPI
 * specification and turns every operation in it into a callable tool. The
 * agent below holds two of them, `get_repository` and
 * `get_repository_languages`, and both call the public GitHub REST API.
 *
 * A live API Hub read needs a Google Cloud project, a catalogued API and
 * credentials. This sample substitutes its own `BaseAPIHubClient`, which
 * returns the bundled `github_spec.yaml`, so the toolset, the generated tools
 * and the HTTP calls they make are all real while the catalogue is not. The
 * README gives the two-line change that points the same toolset at a real
 * resource.
 *
 * `apihubResourceName` is still required with a substituted client, because
 * the client decides what to do with it. The client below ignores it.
 *
 * GitHub rate-limits unauthenticated callers, so a burst of prompts can be
 * answered with 403.
 *
 * REQUIRES an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/tools/apihub_tool/agent.ts
 * Try "how many stars does googleapis/js-genai have?".
 */

import {APIHubToolset, BaseAPIHubClient, LlmAgent} from '@google/adk';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The specification lives beside this file rather than inside it. A caller
// receives a document; inlining it here would put the sample's subject behind
// its fixture.
const GITHUB_SPEC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'github_spec.yaml'),
  'utf8',
);

/**
 * Stands in for the API Hub service. `BaseAPIHubClient` declares one method,
 * so an object literal satisfies it. A real deployment omits this option and
 * lets the toolset build an `APIHubClient` from its own credentials.
 */
const bundledSpecClient: BaseAPIHubClient = {
  getSpecContent: async () => GITHUB_SPEC,
};

const githubToolset = new APIHubToolset({
  apihubResourceName:
    'projects/sample-project/locations/us-central1/apis/github-repositories',
  apihubClient: bundledSpecClient,
});

export const rootAgent = new LlmAgent({
  name: 'api_hub_assistant',
  model: 'gemini-flash-latest',
  description: 'Answers questions about public GitHub repositories.',
  instruction:
    'Answer questions about GitHub repositories by calling get_repository ' +
    'and get_repository_languages. Report the numbers the tools return and ' +
    'do not estimate them. If a tool returns an error, report the error ' +
    'instead of inventing an answer.',
  tools: [githubToolset],
});
