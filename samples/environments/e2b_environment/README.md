# E2B environment sample

`sandbox_workspace.ts` drives a real [E2B](https://e2b.dev) sandbox through
`E2BEnvironment`. It installs `requests`, writes a Python script, runs the
script, reads back the file the script produced, and kills the sandbox. It then
checks the two contract points that are easy to get wrong: a non-zero exit code
comes back as a result, and a missing file throws `ENOENT`.

Nothing is mocked, so this is the manual end-to-end test for the class. The
unit tests in `core/test/integrations/e2b/` cover the same paths against fakes.

## Running it costs credits

The script creates a live sandbox on your E2B account. The sandbox has a
300-second time-to-live and the script kills it on every exit path, but a run
still consumes credits.

## Prerequisites

1. Install the optional peer dependency:

   ```bash
   npm install e2b
   ```

2. Set your E2B API key. Get one at https://e2b.dev.

   ```bash
   export E2B_API_KEY="your-api-key"
   ```

3. Build the package. A sample resolves `@google/adk` through `node_modules`,
   the way a user's project does, so it needs the built output:

   ```bash
   npm run build
   ```

## Run

`samples/` is not an npm workspace and the repo ships no TypeScript runner, so
transpile with `esbuild` (a devDependency) and pipe the result to Node. Run
this from the repository root:

```bash
npx esbuild --format=esm --platform=node \
  samples/environments/e2b_environment/sandbox_workspace.ts | node --input-type=module
```

Without `E2B_API_KEY` the script prints how to get one and exits with status 1.

## Expected output

One line per step. `<version>` is whatever `pip` installs on the day you run
it.

```
working dir: /home/user
pip install requests: exit 0
python report.py: exit 0, wrote report.txt
requests version: <version>
exit 3: exitCode 3, timedOut false
missing.txt: ENOENT: no such file or directory, open '/home/user/missing.txt'
sandbox killed
```
