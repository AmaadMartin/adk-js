# RedisSessionService round trip

`round_trip.ts` drives every `RedisSessionService` method against a live Redis
instance: it creates a session carrying all four state scopes, appends two
events, reads the session back, lists the application's sessions, deletes it,
and shows the read coming back `undefined`.

Setup — installing `redis`, and what the options mean — is in the
[guide](../../../docs/guides/sessions/redis_session_service/index.md). This
sample exports no `rootAgent`, so `npm run sample` cannot launch it; compile it
and run the output. `REDIS_URL` is its only input, and it prints the setup
instructions and exits when that is unset.

```bash
npm run build
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

The sample writes under the `adk:sample:` key prefix and deletes the session it
created. The shared `app:` and `user:` state keys it writes remain until their
expiry.
