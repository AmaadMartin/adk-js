# Public Surface Audit: Wildcard Re-exports in the Core Barrel

## 1. Scope and Method

This document is a point-in-time census of the `export * from '...'` statements
that publish symbols into `@google/adk`. It changes no code. It exists so that
each proposed retraction can ship as its own reviewable pull request, with the
evidence for the retraction already written down.

- Commit audited: `3e4f770333053ad32b33b3154d9ec062e1950c5a`.
- Package version: `@google/adk` 1.6.0 (`core/package.json`).
- Public entry points: `core/src/index.ts` (the `.` export condition) and
  `core/src/index_web.ts` (the `browser` field).

An explicit `export {X} from './y.js'` line is a decision. A wildcard is not: it
publishes every top-level export of its target module, including exports added
to that module later by an author who never considered the public surface.

`typedoc.json` sets `entryPoints` to `./core/src/index.ts` and nothing else, and
`npm run docs:check` runs typedoc with `--treatWarningsAsErrors`. Every symbol
reachable from that barrel is therefore rendered into the published API
reference.

### 1.1. Incremental Surface

The **incremental surface** of a wildcard is the set of symbols it publishes
that no explicit `export {}` / `export type {}` in the same barrel chain also
publishes. Deleting a wildcard whose incremental surface is empty changes
nothing that a consumer can observe. Deleting one with a non-empty incremental
surface removes those symbols from the package.

The barrel chain for a wildcard is evaluated with that one statement removed and
every other statement left in place. For a wildcard in `common.ts` the chain is
the explicit exports of `common.ts` plus those of `index.ts`, because
`index.ts:41` still re-exports `common.ts`.

### 1.2. Classification Rubric

Four signals mark a symbol as intended for the public surface:

1. It appears in the signature of another symbol that this audit classifies as
   intentionally-public. Signals 3 and 4 are evaluated first, then signal 1
   propagates from those symbols.
2. It carries a TSDoc block that documents its behaviour, parameters or return
   value. The `@license` header does not count.
3. It is imported outside its own module directory: by another `core/src`
   subtree, by `dev/`, by `integrations/`, or by `tests/`.
4. It is already named in an explicit `export {}` / `export type {}` in the
   barrel chain, so it survives removal of the wildcard regardless.

Verdicts follow mechanically:

| Signals that fire | Verdict                |
| ----------------- | ---------------------- |
| 1, 3 or 4         | `intentionally-public` |
| 2 only            | `needs-owner-decision` |
| none              | `accidentally-public`  |

The middle row is a deliberate refinement of the rubric. A doc comment proves
the author documented the symbol for whoever calls it; it does not prove the
package meant to publish it to consumers. Signal 2 fires for 48 of the 69 leaf
symbols in this audit, so on its own it does not discriminate. Where it is the
only signal, the owner decides.

Test usage is recorded but is not read as proof either way. A symbol used only
by `core/test` is not thereby public. A symbol a test imports from
`@google/adk`, however, is exercised through the same path a consumer would use,
and that is noted in the evidence column where it applies.

## 2. The Wildcard Graph

There are 23 `export * from` statements under `core/src`. Five of them are exact
duplicates, so they resolve to 18 distinct source-to-target pairs and 17 distinct
target modules: 15 leaf modules, plus the two barrels `common.ts` and
`integrations/agent_registry/agent_registry.ts`. The 15 leaves publish 69
top-level symbols between them.

| Source                                                   | Line | Target module                                     | Published | Incremental               |
| -------------------------------------------------------- | ---- | ------------------------------------------------- | --------- | ------------------------- |
| `core/src/index.ts`                                      | 41   | `./common.js`                                     | 378       | 372                       |
| `core/src/index.ts`                                      | 62   | `./integrations/agent_registry/agent_registry.js` | 20        | 20                        |
| `core/src/index.ts`                                      | 63   | `./telemetry/google_cloud.js`                     | 2         | 2                         |
| `core/src/index.ts`                                      | 64   | `./telemetry/setup.js`                            | 3         | 3                         |
| `core/src/index.ts`                                      | 65   | `./tools/mcp/load_mcp_resource_tool.js`           | 1         | 1                         |
| `core/src/index.ts`                                      | 66   | `./tools/mcp/mcp_session_manager.js`              | 4         | 4                         |
| `core/src/index.ts`                                      | 67   | `./tools/mcp/mcp_tool.js`                         | 1         | 1                         |
| `core/src/index.ts`                                      | 68   | `./tools/mcp/mcp_toolset.js`                      | 1         | 1                         |
| `core/src/common.ts`                                     | 338  | `./artifacts/base_artifact_service.js`            | 7         | 1                         |
| `core/src/common.ts`                                     | 339  | `./features/feature_registry.js`                  | 8         | 8                         |
| `core/src/common.ts`                                     | 340  | `./memory/base_memory_service.js`                 | 3         | 0                         |
| `core/src/common.ts`                                     | 341  | `./sessions/base_session_service.js`              | 11        | 3                         |
| `core/src/common.ts`                                     | 342  | `./tools/base_tool.js`                            | 5         | 0                         |
| `core/src/common.ts`                                     | 420  | `./apps/app.js`                                   | 4         | 4                         |
| `core/src/common.ts`                                     | 421  | `./artifacts/base_artifact_service.js`            | 7         | 0 (duplicate of line 338) |
| `core/src/common.ts`                                     | 422  | `./features/feature_registry.js`                  | 8         | 0 (duplicate of line 339) |
| `core/src/common.ts`                                     | 423  | `./memory/base_memory_service.js`                 | 3         | 0 (duplicate of line 340) |
| `core/src/common.ts`                                     | 424  | `./sessions/base_session_service.js`              | 11        | 0 (duplicate of line 341) |
| `core/src/common.ts`                                     | 425  | `./tools/base_tool.js`                            | 5         | 0 (duplicate of line 342) |
| `core/src/index_web.ts`                                  | 7    | `./common.js`                                     | 378       | 378                       |
| `core/src/integrations/agent_registry/agent_registry.ts` | 39   | `./agent_registry_mcp_toolset.js`                 | 1         | 1                         |
| `core/src/integrations/agent_registry/agent_registry.ts` | 40   | `./helpers.js`                                    | 2         | 2                         |
| `core/src/integrations/agent_registry/agent_registry.ts` | 41   | `./types.js`                                      | 16        | 16                        |

Three rows describe structure rather than leaked symbols.

- `index.ts:41` is the only path from the Node entry point to `common.ts`. Its
  378 published symbols drop to 372 incremental because `index.ts` names six of
  them explicitly as well: `CodeExecutionLanguage`, `InvocationContext`,
  `WorkflowInstructionScope`, `loadAllSkillsInDir`, `loadSkillFromDir` and
  `validateSkillDir`.
- `index_web.ts:7` is the whole body of the browser entry point. Removing it
  empties that entry point, so its incremental surface is all 378 symbols.
- `index.ts:62` publishes the union of the three `agent_registry` wildcards (19
  symbols) plus `AgentRegistry`, which the barrel declares itself. Those 19 are
  classified under their own modules in section 3 and are not counted twice.

The five duplicated statements at lines 421-425 repeat lines 338-342. Each copy
is individually a no-op while its twin remains.

`core/src/index.ts` exposes 445 symbols in total: 41 explicit and the rest
through wildcards. `core/src/common.ts` exposes 378, of which 362 are explicit.

## 3. Per-Module Findings

One subsection per leaf module, covering the incremental symbols only. Symbols
that an explicit export already publishes are omitted, because removing the
wildcard does not remove them.

### 3.1. `telemetry/google_cloud.ts`

| Symbol            | Kind     | Evidence                                                            | Verdict              |
| ----------------- | -------- | ------------------------------------------------------------------- | -------------------- |
| `getGcpExporters` | function | 3: `dev/src/utils/telemetry_utils.ts` imports it from `@google/adk` | intentionally-public |
| `getGcpResource`  | function | 3: same import                                                      | intentionally-public |

Neither carries a TSDoc block, so both are absent from the API reference prose
while still being load-bearing public API.

### 3.2. `telemetry/setup.ts`

| Symbol                  | Kind      | Evidence                                                                                            | Verdict              |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------- | -------------------- |
| `maybeSetOtelProviders` | function  | 2, 3: TSDoc marked `@experimental`; `dev/src/utils/telemetry_utils.ts`                              | intentionally-public |
| `OTelHooks`             | interface | 1, 2, 3: parameter of `maybeSetOtelProviders`, return type of `getGcpExporters`, imported by `dev/` | intentionally-public |
| `OtelExportersConfig`   | interface | 1: parameter of `getGcpExporters`                                                                   | intentionally-public |

### 3.3. `tools/mcp/load_mcp_resource_tool.ts`

| Symbol                | Kind  | Evidence                                                                                       | Verdict              |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------- | -------------------- |
| `LoadMcpResourceTool` | class | 2, 3: TSDoc; `tests/e2e/tools/mcp/load_mcp_resource_e2e_test.ts` imports it from `@google/adk` | intentionally-public |

### 3.4. `tools/mcp/mcp_session_manager.ts`

| Symbol                           | Kind      | Evidence                                                                                  | Verdict              |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------- | -------------------- |
| `MCPSessionManager`              | class     | 2, 3: TSDoc; used by `core/src/integrations/agent_registry/agent_registry_mcp_toolset.ts` | intentionally-public |
| `MCPConnectionParams`            | type      | 1, 2: TSDoc; union accepted by `MCPToolset` and `MCPSessionManager`                       | intentionally-public |
| `StdioConnectionParams`          | interface | 2, 3: TSDoc; `dev/src/integration/agent_types.ts` imports it from `@google/adk`           | intentionally-public |
| `StreamableHTTPConnectionParams` | interface | 2, 3: TSDoc; used by `core/src/integrations/agent_registry/`                              | intentionally-public |

### 3.5. `tools/mcp/mcp_tool.ts`

| Symbol    | Kind  | Evidence                                                                                  | Verdict              |
| --------- | ----- | ----------------------------------------------------------------------------------------- | -------------------- |
| `MCPTool` | class | 2, 3: TSDoc; used by `core/src/integrations/agent_registry/agent_registry_mcp_toolset.ts` | intentionally-public |

### 3.6. `tools/mcp/mcp_toolset.ts`

| Symbol       | Kind  | Evidence                                                                           | Verdict              |
| ------------ | ----- | ---------------------------------------------------------------------------------- | -------------------- |
| `MCPToolset` | class | 2, 3: TSDoc; `dev/src/integration/agent_registry.ts` imports it from `@google/adk` | intentionally-public |

### 3.7. `artifacts/base_artifact_service.ts`

| Symbol            | Kind      | Evidence                                                                                                                                                                                                       | Verdict              |
| ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `ArtifactVersion` | interface | 1, 2, 3: TSDoc; return type of `BaseArtifactService.listArtifactVersions` and `.getArtifactVersion`, and `BaseArtifactService` is explicitly exported; used by `core/src/tools/forwarding_artifact_service.ts` | intentionally-public |

The other six symbols of this module are already in an explicit `export type`
list in `common.ts`. `ArtifactVersion` is the single omission from that list.

### 3.8. `features/feature_registry.ts`

No explicit export names any symbol of this module. The whole module is public
by wildcard alone.

| Symbol                         | Kind      | Evidence                                                         | Verdict              |
| ------------------------------ | --------- | ---------------------------------------------------------------- | -------------------- |
| `FeatureName`                  | enum      | 2, 3: TSDoc; `core/src/utils/streaming_utils.ts`                 | intentionally-public |
| `isFeatureEnabled`             | function  | 2, 3: TSDoc; `core/src/utils/streaming_utils.ts`                 | intentionally-public |
| `FeatureConfig`                | interface | 2 only: TSDoc; no consumer outside `core/src/features/`          | needs-owner-decision |
| `FeatureStage`                 | enum      | 2 only: TSDoc; used in source only through `FeatureConfig.stage` | needs-owner-decision |
| `getFeatureConfig`             | function  | 2 only: TSDoc; called only inside its own module and `core/test` | needs-owner-decision |
| `registerFeature`              | function  | 2 only: TSDoc; called only from `core/test`                      | needs-owner-decision |
| `overrideFeatureEnabled`       | function  | 2 only: TSDoc; called only from `core/test`                      | needs-owner-decision |
| `withTemporaryFeatureOverride` | function  | 2 only: TSDoc; called only from `core/test`                      | needs-owner-decision |

`core/test/features/feature_registry_test.ts:7-15` imports five of the six
`needs-owner-decision` symbols from `@google/adk`; only `FeatureConfig` is
absent. That is test usage, so it does not change any verdict, but a retraction
must move that import to `'../../src/features/feature_registry.js'` or the suite
fails to compile.

`withTemporaryFeatureOverride` restores the previous override in a `finally`
block. That is test ergonomics, and it may be deliberate public API for
downstream test suites. The owner decides; the evidence does not settle it.

### 3.9. `memory/base_memory_service.ts`

Incremental surface empty. `BaseMemoryService`, `SearchMemoryRequest` and
`SearchMemoryResponse` are all in an explicit `export type` list in `common.ts`
already. The wildcard is pure redundancy.

### 3.10. `sessions/base_session_service.ts`

`BaseSessionService` and the seven request and response types are explicit.
Three helpers are not.

| Symbol               | Kind     | Evidence                                             | Verdict              |
| -------------------- | -------- | ---------------------------------------------------- | -------------------- |
| `trimTempDeltaState` | function | 2 only: TSDoc; called only from `core/src/sessions/` | needs-owner-decision |
| `trimTempState`      | function | 2 only: TSDoc; called only from `core/src/sessions/` | needs-owner-decision |
| `mergeStates`        | function | 2 only: TSDoc; called only from `core/src/sessions/` | needs-owner-decision |

An author of a custom `BaseSessionService` implementation would plausibly want
all three, which is why the verdict is not `accidentally-public`. No test
imports them through the barrel, so a retraction needs no test change.

### 3.11. `tools/base_tool.ts`

Incremental surface empty. `BaseTool`, `isBaseTool`, `BaseToolParams`,
`RunAsyncToolRequest` and `ToolProcessLlmRequest` are all explicitly exported.
The wildcard is pure redundancy.

### 3.12. `apps/app.ts`

No explicit export names any symbol of this module.

| Symbol            | Kind      | Evidence                                                                                                                                             | Verdict              |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `App`             | class     | 1, 2, 3: TSDoc; type of `RunnerConfig.app`, and `RunnerConfig` is explicitly exported; `dev/src/utils/agent_loader.ts` imports it from `@google/adk` | intentionally-public |
| `isApp`           | function  | 2, 3: TSDoc; `dev/src/utils/agent_loader.ts`, `dev/src/server/adk_api_server.ts` and `dev/src/cli/cli_run.ts` import it from `@google/adk`           | intentionally-public |
| `AppOptions`      | interface | 1, 2: TSDoc; the sole constructor parameter of `App`                                                                                                 | intentionally-public |
| `validateAppName` | function  | 2 only: TSDoc; called only from the `App` constructor and `core/test/apps/app_test.ts`, which imports it relatively, not through the barrel          | needs-owner-decision |

### 3.13. `integrations/agent_registry/agent_registry_mcp_toolset.ts`

| Symbol                          | Kind  | Evidence                                                                                                                                              | Verdict              |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `AgentRegistrySingleMCPToolset` | class | 1, 2, 3: TSDoc; return type of `AgentRegistry.getMcpToolset`; `tests/integration/agent_registry/agent_registry_test.ts` imports it from `@google/adk` | intentionally-public |

### 3.14. `integrations/agent_registry/helpers.ts`

| Symbol        | Kind     | Evidence                                                                                        | Verdict             |
| ------------- | -------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| `cleanName`   | function | none: no TSDoc, no public signature, called only from `agent_registry.ts` in the same directory | accidentally-public |
| `isGoogleApi` | function | none: no TSDoc, no public signature, called only from `agent_registry.ts` in the same directory | accidentally-public |

Both are string and URL helpers with no relation to the registry contract. They
are the finding that prompted this audit.

`core/test/integrations/agent_registry_test.ts:13,15` imports both through the
barrel, at `'../../src/index.js'`. That is test usage, so it does not change
either verdict, but the retraction must switch that import to
`'../../src/integrations/agent_registry/helpers.js'` or the suite fails to
compile.

### 3.15. `integrations/agent_registry/types.ts`

No symbol in this module carries a TSDoc block. Eleven reach the public surface
through `AgentRegistry` method signatures, and one is a metadata key that a
consumer must read.

| Symbol                          | Kind      | Evidence                                                                                                                 | Verdict              |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `McpServer`                     | interface | 1: return type of `AgentRegistry.getMcpServer`                                                                           | intentionally-public |
| `Endpoint`                      | interface | 1: return type of `AgentRegistry.getEndpoint`                                                                            | intentionally-public |
| `AgentInfo`                     | interface | 1: return type of `AgentRegistry.getAgentInfo`                                                                           | intentionally-public |
| `ListMcpServersResponse`        | interface | 1: return type of `AgentRegistry.listMcpServers`                                                                         | intentionally-public |
| `ListEndpointsResponse`         | interface | 1: return type of `AgentRegistry.listEndpoints`                                                                          | intentionally-public |
| `ListAgentsResponse`            | interface | 1: return type of `AgentRegistry.listAgents`                                                                             | intentionally-public |
| `ConnectionUriFilter`           | interface | 1: parameter of `AgentRegistry.getConnectionUri`                                                                         | intentionally-public |
| `ConnectionUriResult`           | interface | 1: return type of `AgentRegistry.getConnectionUri`                                                                       | intentionally-public |
| `ProtocolType`                  | enum      | 1: member of `ConnectionUriFilter` and of the `getConnectionUri` parameter                                               | intentionally-public |
| `Interface`                     | interface | 1: member of `Endpoint`, `McpServer` and `AgentInfo`                                                                     | intentionally-public |
| `AgentSkillMetadata`            | interface | 1: member of `AgentInfo.skills`                                                                                          | intentionally-public |
| `GCP_MCP_SERVER_DESTINATION_ID` | const     | 3: `tests/integration/agent_registry/agent_registry_test.ts` imports it from `@google/adk` to read the tool metadata key | intentionally-public |
| `AGENT_REGISTRY_BASE_URL`       | const     | none: a URL prefix read only by `agent_registry.ts` in the same directory                                                | accidentally-public  |
| `Binding`                       | interface | none: referenced only by `ListBindingsResponse`                                                                          | accidentally-public  |
| `ListBindingsResponse`          | interface | none: used only as a type argument to the private `makeRequest` method                                                   | accidentally-public  |
| `GcpAuthProviderScheme`         | interface | none: used once inside a method body, in a double cast to `AuthScheme`                                                   | accidentally-public  |

`Interface` deserves a note. The name is entirely generic, it collides with a
common English word in the API reference, and it describes one narrow thing: a
protocol interface on a registry endpoint. It is load-bearing, so it cannot
simply be dropped, but a rename is worth considering alongside any retraction of
this module's wildcard.

## 4. Summary

Population: the 47 distinct incremental symbols of the 15 leaf wildcards.
`AgentRegistry` is a 48th symbol published only by a wildcard, declared in the
`agent_registry.ts` barrel itself; it is intentionally-public by signals 3 and 4.

| Verdict              | Count  |
| -------------------- | ------ |
| intentionally-public | 31     |
| needs-owner-decision | 10     |
| accidentally-public  | 6      |
| **Total**            | **47** |

Wildcards removable with no change to the public surface:

- 2 of the 18 distinct source-to-target pairs have an empty incremental surface:
  `common.ts` to `memory/base_memory_service.js`, and `common.ts` to
  `tools/base_tool.js`.
- 7 of the 23 statements can each be deleted on their own with no surface
  change: the five duplicates at lines 421-425 of `common.ts`, plus lines 340
  and 342.

The compiler's export list and `grep -nE '^export ' <file>` agree for all 15 leaf
modules. There is no discrepancy to report.

## 5. Recommended Follow-ups

Each bullet is one pull request. `release-please` derives the changelog for
`main`, `adk`, `devtools` and `integrations` from conventional-commit subjects,
so batching unrelated surface removals into one commit produces a single
unreadable changelog entry and one change that cannot be reverted in parts.

Ordered from safest to most disruptive.

- **`common.ts` duplicate block (lines 421-425).** Delete the five repeated
  wildcards. No surface change, not breaking. **Already tracked separately.**
- **`memory/base_memory_service.js` (`common.ts:340`).** Delete the wildcard;
  the explicit `export type` list already publishes all three symbols. No
  surface change, not breaking.
- **`tools/base_tool.js` (`common.ts:342`).** Delete the wildcard; all five
  symbols are already explicit. No surface change, not breaking.
- **`artifacts/base_artifact_service.js` (`common.ts:338`).** Add
  `ArtifactVersion` to the existing explicit `export type` list, then delete the
  wildcard. No surface change, not breaking.
- **`integrations/agent_registry/agent_registry_mcp_toolset.js`
  (`agent_registry.ts:39`).** Replace with
  `export {AgentRegistrySingleMCPToolset}`. No surface change, not breaking.
- **`telemetry/google_cloud.js` (`index.ts:63`).** Replace with an explicit
  export of `getGcpExporters` and `getGcpResource`. Both are consumed by `dev/`.
  No surface change, not breaking. Add the missing TSDoc blocks in the same PR.
- **`telemetry/setup.js` (`index.ts:64`).** Replace with an explicit export of
  all three symbols. No surface change, not breaking.
- **`tools/mcp/load_mcp_resource_tool.js` (`index.ts:65`).** Replace with
  `export {LoadMcpResourceTool}`. No surface change, not breaking.
- **`tools/mcp/mcp_session_manager.js` (`index.ts:66`).** Replace with an
  explicit export of all four symbols. No surface change, not breaking.
- **`tools/mcp/mcp_tool.js` (`index.ts:67`).** Replace with `export {MCPTool}`.
  No surface change, not breaking.
- **`tools/mcp/mcp_toolset.js` (`index.ts:68`).** Replace with
  `export {MCPToolset}`. No surface change, not breaking.
- **`apps/app.js` (`common.ts:420`).** Replace with an explicit export of `App`,
  `AppOptions` and `isApp`. Decide on `validateAppName`; retracting it is
  breaking for anyone who imports it, and it has no consumer outside
  `core/src/apps/`.
- **`integrations/agent_registry/helpers.js` (`agent_registry.ts:40`).** Delete
  the wildcard and import the two helpers directly. The same PR must repoint
  `core/test/integrations/agent_registry_test.ts:13,15` at
  `'../../src/integrations/agent_registry/helpers.js'`; it reaches both helpers
  through the barrel today, so the suite fails to compile otherwise. Breaking
  for anyone importing `cleanName` or `isGoogleApi`. **Already tracked
  separately.**
- **`sessions/base_session_service.js` (`common.ts:341`).** Decide on
  `trimTempDeltaState`, `trimTempState` and `mergeStates`, then replace the
  wildcard with an explicit list. Breaking if the three are retracted.
- **`features/feature_registry.js` (`common.ts:339`).** Decide on the six
  `needs-owner-decision` symbols. `FeatureName` and `isFeatureEnabled` must stay.
  A retraction must also repoint
  `core/test/features/feature_registry_test.ts:7-15` at
  `'../../src/features/feature_registry.js'`. Breaking for anyone who drives the
  registry programmatically.
- **`integrations/agent_registry/types.js` (`agent_registry.ts:41`).** Replace
  with an explicit list of the twelve intentionally-public symbols and retract
  the other four. Breaking for anyone importing `AGENT_REGISTRY_BASE_URL`,
  `Binding`, `ListBindingsResponse` or `GcpAuthProviderScheme`. Consider
  renaming `Interface` in the same PR.
- **`index.ts:41`, `index.ts:62` and `index_web.ts:7`** are the structural
  barrel links. Leave them. Retracting a symbol is done at the leaf, not here.

## 6. Appendix: Reproduction

Run from the repository root at commit
`3e4f770333053ad32b33b3154d9ec062e1950c5a`, after `npm ci`. `typescript` is
already a root devDependency, so no package needs installing.

### 6.1. Enumerate the wildcard statements

```
grep -rn "export \* from" core/src --include=*.ts
```

### 6.2. The enumeration script

```js
// /tmp/dump-surface.mjs - throwaway, not part of the diff.
// Usage: node /tmp/dump-surface.mjs <entry.ts> [--explicit]
//   default    print "<name>\t<kind>" for every export of <entry.ts>
//   --explicit print only the names <entry.ts> binds with a NON-wildcard
//              top-level export statement (its explicit surface)
import {createRequire} from 'node:module';
const ts = createRequire(`${process.cwd()}/`)('typescript');

const entry = process.argv[2];
const explicitOnly = process.argv.includes('--explicit');
const program = ts.createProgram([entry], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
});
const checker = program.getTypeChecker();
const file = program.getSourceFile(entry);

if (explicitOnly) {
  const names = new Set();
  for (const st of file.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) continue; // export * from '...'
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) names.add(el.name.text);
      } else {
        names.add(st.exportClause.name.text); // export * as ns from '...'
      }
      continue;
    }
    const isExported = ts
      .getModifiers(st)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) names.add(d.name.text);
    } else if (st.name) {
      names.add(st.name.text);
    }
  }
  for (const n of [...names].sort()) console.log(n);
} else {
  const F = ts.SymbolFlags;
  const kindOf = (s) => {
    const f = s.flags & F.Alias ? checker.getAliasedSymbol(s).flags : s.flags;
    if (f & F.Class) return 'class';
    if (f & F.Enum || f & F.RegularEnum || f & F.ConstEnum) return 'enum';
    if (f & F.Function) return 'function';
    if (f & F.Interface) return 'interface';
    if (f & F.TypeAlias) return 'type';
    if (f & F.Variable) return 'const';
    if (f & F.Module) return 'namespace';
    return 'other';
  };
  const sym = checker.getSymbolAtLocation(file);
  const rows = checker
    .getExportsOfModule(sym)
    .map((e) => `${e.getName()}\t${kindOf(e)}`)
    .sort();
  for (const r of rows) console.log(r);
}
```

### 6.3. Published symbols per module

`node /tmp/dump-surface.mjs <module.ts>` prints one symbol and kind per line.
Run it on each of the 15 leaves, on `core/src/index.ts`, on
`core/src/index_web.ts` and on `core/src/common.ts`. Those counts are the
Published column of section 2.

### 6.4. Cross-check against the source

Sort that output and compare it against `grep -nE '^export ' <file>` reduced to
declaration names. Doing so for each of the 15 leaves is what backs the
equivalence claim in section 4.

### 6.5. Incremental surface

Build the explicit surface of the barrel chain once, then subtract it from each
module's published list.

```
node /tmp/dump-surface.mjs core/src/index.ts --explicit > /tmp/explicit_index.txt
node /tmp/dump-surface.mjs core/src/common.ts --explicit > /tmp/explicit_common.txt
sort -u /tmp/explicit_index.txt /tmp/explicit_common.txt > /tmp/chain.txt

for m in core/src/sessions/base_session_service.ts core/src/apps/app.ts \
         core/src/features/feature_registry.ts \
         core/src/artifacts/base_artifact_service.ts \
         core/src/memory/base_memory_service.ts core/src/tools/base_tool.ts; do
  echo -n "$m -> "
  comm -23 <(node /tmp/dump-surface.mjs $m | cut -f1 | sort) /tmp/chain.txt \
    | tr '\n' ' '
  echo
done
```

Output:

```
core/src/sessions/base_session_service.ts -> mergeStates trimTempDeltaState trimTempState
core/src/apps/app.ts -> App AppOptions isApp validateAppName
core/src/features/feature_registry.ts -> FeatureConfig FeatureName FeatureStage getFeatureConfig isFeatureEnabled overrideFeatureEnabled registerFeature withTemporaryFeatureOverride
core/src/artifacts/base_artifact_service.ts -> ArtifactVersion
core/src/memory/base_memory_service.ts ->
core/src/tools/base_tool.ts ->
```

For the three `agent_registry` wildcards, add `AgentRegistry` to the chain file
first, because `agent_registry.ts` declares it explicitly and it survives their
removal.

### 6.6. TSDoc presence

Signal 2 is a JSDoc block on the exported declaration, read with
`ts.getJSDocCommentsAndTags` and ignoring any block containing `@license` or
`SPDX-License-Identifier`. The per-symbol result is the `2:` or `2 only:` prefix
in every section 3 evidence cell.

### 6.7. Usage evidence

Signal 3 requires a consumer outside the symbol's own module directory. The
search must span every workspace, not `core/src` alone.

```
grep -rn '\b<Symbol>\b' core dev integrations tests docs \
  --include='*.ts' --include='*.md' | grep -v node_modules
```
