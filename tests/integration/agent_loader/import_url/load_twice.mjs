/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loads one agent file twice through `AgentFile` and reports the URL each load
 * gave the module. Vitest's module runner rewrites import specifiers and drops
 * the `?t=` query, so only a real Node process can observe this.
 *
 * Usage: node load_twice.mjs <agent-file> <reloadable:true|false>
 */

import {AgentFile} from '../../../../dev/dist/esm/utils/agent_loader.js';

const [agentPath, reloadableArg] = process.argv.slice(2);
const reloadable = reloadableArg === 'true';
const options = {compile: false, bundle: false};

const first = await new AgentFile(agentPath, options, reloadable).load();
const second = await new AgentFile(agentPath, options, reloadable).load();

process.stdout.write(
  JSON.stringify({
    firstUrl: first.description,
    secondUrl: second.description,
    sameModule: first === second,
  }),
);
