/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A module the code-reference tests resolve by name, standing in for the file
 * a configuration document points at.
 */

import {LlmAgent} from '@google/adk';

/** Resolved when a qualified name carries no export name. */
export default 'the default export';

/** A value that is not an agent, resolved by `#staticProvider`. */
export const staticProvider = () => 'provided';

/** An agent, resolved by `#fixtureAgent`. */
export const fixtureAgent = new LlmAgent({name: 'fixture_agent'});
