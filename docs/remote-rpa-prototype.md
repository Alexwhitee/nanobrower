# Remote RPA Prototype

This prototype connects a local Nanobrowser extension to a thin bridge service so a cloud orchestrator such as OpenClaw can drive browser actions step by step.

## Run the bridge

```bash
node /Users/xi/suanneng/nanobrowser/packages/hmr/lib/remote-bridge/server.mjs
```

Environment variables:

- `REMOTE_BRIDGE_HOST`
- `REMOTE_BRIDGE_PORT`

Default WebSocket URL for the extension:

```text
ws://127.0.0.1:8787/ws
```

## HTTP API

Create a session:

```bash
curl -X POST http://127.0.0.1:8787/sessions \
  -H 'Content-Type: application/json' \
  -d '{"device_id":"dev_xxx","task_id":"task_demo","start_url":"https://example.com"}'
```

Get page state:

```bash
curl -X POST http://127.0.0.1:8787/tools/get-page-state \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"sess_xxx"}'
```

Session status:

```bash
curl http://127.0.0.1:8787/sessions/sess_xxx/status
```

Click:

```bash
curl -X POST http://127.0.0.1:8787/tools/click \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"sess_xxx","args":{"element_id":"e12"}}'
```

Type:

```bash
curl -X POST http://127.0.0.1:8787/tools/type \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"sess_xxx","args":{"element_id":"e12","text":"张三"}}'
```

Screenshot:

```bash
curl -X POST http://127.0.0.1:8787/tools/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"sess_xxx"}'
```
