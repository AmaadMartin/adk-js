/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where an agent was loaded from, when a loader knows.
 *
 * Ported from `google/adk-python`, whose `AgentLoader` sets
 * `_adk_origin_app_name` and `_adk_origin_path` on the agent it loads. Python
 * has a second source, an `inspect.getmodule` heuristic over the file that
 * defines the agent class. That one is not ported: ESM has no portable runtime
 * equivalent, and a stack-trace guess would raise exactly the false positives
 * Python's `google.adk.*` exclusion exists to suppress.
 */
export interface AgentOrigin {
  /** The app name implied by the location, usually the directory name. */
  appName?: string;
  /** The directory the agent was loaded from. */
  path?: string;
}

/**
 * Describes the disagreement between a runner's app name and where its root
 * agent was loaded from, or `undefined` when the two agree.
 *
 * Ported from `google/adk-python` `runners.py::Runner._enforce_app_name_alignment`.
 * A name starting with `__` marks a built-in agent, which never implies an app
 * name.
 */
export function appNameMismatchDetails(
  appName: string,
  origin?: AgentOrigin,
): string | undefined {
  const originAppName = origin?.appName;
  if (!originAppName || originAppName.startsWith('__')) return undefined;
  if (originAppName === appName) return undefined;
  return (
    `The runner is configured with app name "${appName}", but the root agent ` +
    `was loaded from "${origin?.path ?? originAppName}", which implies app ` +
    `name "${originAppName}".`
  );
}
