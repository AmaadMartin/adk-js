# RedisSessionService round trip

`round_trip.ts` drives every `RedisSessionService` method against a live Redis
instance: it creates a session carrying all four state scopes, appends two
events, reads the session back, lists the application's sessions, deletes it,
and shows the read coming back `undefined`.

The guide for the service is in
[docs/guides/sessions/redis_session_service](../../../docs/guides/sessions/redis_session_service/index.md).

## Running

`redis` is an optional peer dependency, so install it first. Then build the
package, because `samples/` resolves `@google/adk` through `node_modules`
against the built types, the way a user's project does.

```bash
npm install redis
npm run build
```

Start a throwaway Redis instance:

```bash
docker run --rm -p 6379:6379 redis:7
```

Compile the sample and run it. `REDIS_URL` is the only input; the sample prints
these instructions and exits when it is unset.

```bash
npx tsc samples/sessions/redis_session_service/round_trip.ts \
  --outDir /tmp/adk-redis-sample --module nodenext --moduleResolution nodenext \
  --target es2022
REDIS_URL=redis://localhost:6379/0 node /tmp/adk-redis-sample/round_trip.js
```

Expected output, with a generated session id:

```
Created session 61429c99-d4fc-470a-8604-af12e3ad4621
  state: {"turn":0,"app:tier":"gold","user:locale":"en-US","temp:scratch":"discarded"}
Read it back with 2 events
  state: {"turn":2,"app:tier":"gold","user:locale":"en-US"}
Listed 1 session(s) for redis_round_trip: 61429c99-d4fc-470a-8604-af12e3ad4621
After delete, getSession returns undefined
```

`temp:scratch` is missing from the second line: temporary state lives only on
the object `createSession` returns and is never written to Redis.

## Against a managed instance

Point `REDIS_URL` at it. Use `rediss://` for TLS, and keep the password in the
environment rather than in a file:

```bash
REDIS_URL="rediss://:$REDIS_PASSWORD@my-instance.example.com:6380/0" \
  node /tmp/adk-redis-sample/round_trip.js
```

The sample writes under the `adk:sample:` key prefix and deletes the session it
created, but the shared `app:` and `user:` state keys it writes remain until
their TTL expires.
