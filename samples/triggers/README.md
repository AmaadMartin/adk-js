# Trigger samples

`event_processor` is an agent driven by an event source instead of a chat turn.
It reads the `{"data": ..., "attributes": {...}}` message that the Pub/Sub and
Eventarc trigger endpoints deliver, and reports what it received.

See the [triggers guide](../../docs/guides/cli/triggers/index.md) for the
endpoints, the payload shapes and the authentication options.

## Run it

```bash
npm run build
node dev/dist/esm/cli_entrypoint.js api_server \
  --port 8123 --trigger_sources=pubsub,eventarc samples/triggers
```

Both endpoints answer 404 without `--trigger_sources`.

### Pub/Sub push subscription

`SGVsbG8=` is `Hello` in base64.

```bash
curl -X POST http://localhost:8123/apps/event_processor/trigger/pubsub \
  -H 'Content-Type: application/json' \
  -d '{"message":{"data":"SGVsbG8=","messageId":"m-1"},
       "subscription":"projects/p/subscriptions/s"}'
# 200 {"status":"success"}
```

The run wrote a session under the user id derived from the subscription:

```bash
curl http://localhost:8123/apps/event_processor/users/projects--p--subscriptions--s/sessions
```

Its events are:

```
user: {"data":"Hello","attributes":{}}
describe_event_node: Received an event from pub/sub: "Hello"
```

### Eventarc CloudEvent

```bash
curl -X POST http://localhost:8123/apps/event_processor/trigger/eventarc \
  -H 'Content-Type: application/json' \
  -H 'ce-source: //storage.googleapis.com/projects/_/buckets/my-bucket' \
  -H 'ce-type: google.cloud.storage.object.v1.finalized' \
  -H 'ce-id: evt-1' -H 'ce-specversion: 1.0' \
  -d '{"data":{"bucket":"my-bucket","name":"file.txt"}}'
# 200 {"status":"success"}
```

The agent receives the CloudEvents attributes alongside the data:

```
user: {"data":{"bucket":"my-bucket","name":"file.txt"},"attributes":{"ce-id":"evt-1", ...}}
describe_event_node: Received an event from //storage.googleapis.com/projects/_/buckets/my-bucket: {"bucket":"my-bucket","name":"file.txt"}
```

### Undecodable data

```bash
curl -X POST http://localhost:8123/apps/event_processor/trigger/pubsub \
  -H 'Content-Type: application/json' \
  -d '{"message":{"data":"!!!not-valid-base64!!!"}}'
# 400 {"error":"Invalid base64 message data: Incorrect base64 padding: 14 characters is not a multiple of 4."}
```
