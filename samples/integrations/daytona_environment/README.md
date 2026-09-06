# DaytonaEnvironment sample

Runs a Python script inside a Daytona sandbox and reads its output file back.
Nothing runs on the host.

## Prerequisites

1. A Daytona account and an API key from https://app.daytona.io/.
2. The optional peer dependency:

   ```sh
   npm install @daytona/sdk
   ```

3. The key in the environment:

   ```sh
   export DAYTONA_API_KEY=<your key>
   # Optional, only for a self-hosted Daytona:
   export DAYTONA_API_URL=<your api url>
   ```

## Run it

The sample is a TypeScript script, not an agent, so run it with a TypeScript
runner:

```sh
npx tsx samples/integrations/daytona_environment/sandbox_workspace.ts
```

It prints the working directory, the exit code and standard output of the
script, and the contents of the `report.json` the script wrote.

## What it shows

- `initialize()` creates the sandbox, `close()` deletes it.
- `writeFile` creates parent directories and resolves a relative path against
  `/workspaces`.
- `execute` reports the exit code and standard output. Daytona merges standard
  error into standard output, so `result.stderr` is always empty.
- `readFile` returns the raw bytes of a file the command produced.

See [the guide](../../../docs/guides/integrations/daytona_environment/index.md)
for the rest of the behaviour.
