## Task

### User intent with respect to ADK

Enable agents in the JS ecosystem to safely execute bash commands with strict resource and security bounds.

### Feature Description

Implementation of `bash_tool.ts` (`ExecuteBashTool`) in `adk-js`. This tool allows executing shell commands. It must achieve parity with the `adk-python` implementation by enforcing security policies (`BashToolPolicy`) including prefix allowlists, operator blocklists, timeouts, and process limit constraints (such as max memory). It must also ALWAYS require explicit user confirmation before executing any command.

### Use Cases & Examples

- Running test suites inside an agent workflow (`npm test`)
- Extracting properties from files (`cat package.json`)
- File manipulation and moving

## Context

### ADK Context

- Documentation context:
  - Built from `BaseTool` in `@google/adk`.
- Reference context:
  - The gold standard is `adk-python/src/google/adk/tools/bash_tool.py` and its tests.
- General context:
  - Ensures consistency in behavior, configuration, and security guarantees across ADK language libraries.

### Language Specific Context

- Target language: TypeScript (Node.js)
- Target repo: `adk-js` (`core/src/tools/bash_tool.ts`)
- General context: Execution likely relies on Node's `child_process.exec` or `child_process.spawn`. Resource limitations (RLIMIT equivalents) can be enforced either via wrapper commands (like `ulimit` or `prlimit` on Linux) or Node-specific configurations, considering OS constraints.

## Definition

### Data Models

`BashToolPolicy` defaults/properties:

- `allowedCommandPrefixes`: `string[]` (Default: `['*']`)
- `blockedOperators`: `string[]` (Default: `[]`)
- `timeoutSeconds`: `number | undefined` (Default: `30`)
- `maxMemoryBytes`: `number | undefined`
- `maxFileSizeBytes`: `number | undefined`
- `maxChildProcesses`: `number | undefined`

### Inputs

- `command: string`: Passed dynamically by the LLM.

### Outputs

- `stdout: string`: The standard output stream result.
- `stderr: string`: The standard error stream result.
- `returncode: number`: The exit code of the process.
- `error?: string`: Formatted error message.

### Side Effects

Executes arbitrary file system operations, networking (if permitted), and any side-effects of the command executed.

## Constraints

### Invariants

- Command execution MUST pause and request user confirmation via `toolContext`.
- Without confirmation (`toolContext.toolConfirmation?.confirmed !== true`), the command MUST abort.

### Preconditions

- The static validation (`_validateCommand`) must run first and block if forbidden commands, operators, or empty commands are used.

### Postconditions

- Process termination signals (like `SIGKILL`) must be dispatched if a timeout occurs.
- Memory and size caps must be effectively configured.

### Error Handling Protocols

- Static validation errors return early with `{"error": "..."}`.
- Refusals from the user return early with `{"error": "This tool call is rejected."}`.
- Execution exceptions are caught and returned as `{"error": "Execution failed: ...", "stdout": "...", "stderr": "..."}`.

### Breaking Change Analysis

- None. This is an additive feature (`bash_tool.ts` doesn't exist yet).

### Testing

- #### Unit tests with >=95% New Line Coverage

  Cover empty commands, valid/invalid allowed prefixes, invalid blocked operators (`|`, `;`), executing confirmed calls vs missing confirmation, timeouts (ensure process is gracefully or forcefully killed), process errors, stdout/stderr mapping, and cwd enforcement. Mimic tests in `adk-python/tests/unittests/tools/test_bash_tool.py`.

- #### Integration tests

  N/A (covered by unit test suite leveraging child tools/mock contexts).

- #### Manual e2e test
  Run the agent locally and provide it with a prompt to execute `ls -l` with the `bash` tool to ensure it asks for confirmation.
