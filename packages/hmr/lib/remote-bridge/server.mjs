import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createOpenClawBrowserAdapter } from './openclaw-browser-adapter.mjs';

const PORT = Number.parseInt(process.env.REMOTE_BRIDGE_PORT || '8787', 10);
const HOST = process.env.REMOTE_BRIDGE_HOST || '0.0.0.0';

const devices = new Map();
const sessions = new Map();
const commands = new Map();
const pendingCommands = new Map();

const actionByRoute = new Map([
  ['get-page-state', 'get_page_state'],
  ['get-tabs', 'get_tabs'],
  ['open-tab', 'open_tab'],
  ['focus-tab', 'focus_tab'],
  ['close-tab', 'close_tab'],
  ['click', 'click'],
  ['hover', 'hover'],
  ['drag', 'drag'],
  ['type', 'type'],
  ['press-key', 'press_key'],
  ['select-option', 'select_option'],
  ['navigate', 'navigate'],
  ['go-back', 'go_back'],
  ['go-forward', 'go_forward'],
  ['scroll', 'scroll'],
  ['wait-for', 'wait_for'],
  ['extract-text', 'extract_text'],
  ['evaluate', 'evaluate_script'],
  ['console', 'console_messages'],
  ['pdf', 'save_pdf'],
  ['arm-file-chooser', 'arm_file_chooser'],
  ['arm-dialog', 'arm_dialog'],
  ['resize-window', 'resize_window'],
  ['screenshot', 'screenshot'],
  ['native-action', 'native_action'],
  ['stop-session', 'stop_session'],
]);

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-OpenClaw-Session-Key',
  });
  res.end(JSON.stringify(body));
}

function getTimeoutMs(action) {
  if (action === 'click') {
    // Clicks may block on a local "Allow once" confirmation for sensitive actions.
    return 70000;
  }
  if (action === 'navigate' || action === 'wait_for') {
    return 45000;
  }
  if (action === 'get_page_state') {
    return 30000;
  }
  if (action === 'press_key') {
    return 15000;
  }
  return 20000;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getDevice(deviceId) {
  return devices.get(deviceId);
}

function ensureOnlineDevice(deviceId) {
  const device = getDevice(deviceId);
  if (!device) {
    return { ok: false, error: `Device ${deviceId} is not registered` };
  }
  if (!device.ws || device.status !== 'connected') {
    return { ok: false, error: `Device ${deviceId} is offline` };
  }
  return { ok: true, device };
}

function buildSessionStatus(session) {
  return {
    session_id: session.session_id,
    task_id: session.task_id,
    device_id: session.device_id,
    status: session.status,
    active_tab_id: session.active_tab_id || null,
    last_page_state: session.last_page_state || null,
    last_result: session.last_result || null,
    confirmation_status: session.last_confirmation_status || null,
    last_confirmation: session.last_confirmation || null,
    active_target_id: session.active_target_id || null,
    tabs_by_target_id: session.tabs_by_target_id || {},
    pending_file_chooser: session.pending_file_chooser || null,
    pending_dialog_policy: session.pending_dialog_policy || null,
    last_console_messages: session.last_console_messages || [],
    last_pdf_path: session.last_pdf_path || null,
  };
}

function buildDeviceStatus(device) {
  return {
    device_id: device.device_id,
    user_id: device.user_id || null,
    status: device.status,
    last_seen_at: device.last_seen_at || null,
    metadata: device.metadata || {},
  };
}

function sendCommandToDevice(session, action, args, explicitCommandId, metadata = {}) {
  const device = devices.get(session.device_id);
  if (!device?.ws || device.status !== 'connected') {
    throw new Error(`Device ${session.device_id} is offline`);
  }

  const commandId = explicitCommandId || `cmd_${randomUUID()}`;
  if (commands.has(commandId)) {
    return Promise.resolve(commands.get(commandId).result);
  }

  const command = {
    command_id: commandId,
    session_id: session.session_id,
    action,
    args: args || {},
    metadata,
  };

  const timeoutMs = getTimeoutMs(action);
  const promise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingCommands.delete(commandId);
      commands.set(commandId, {
        command_id: commandId,
        session_id: session.session_id,
        action,
        status: 'timeout',
        result: {
          command_id: commandId,
          session_id: session.session_id,
          ok: false,
          error: `Command timed out after ${timeoutMs}ms`,
        },
        created_at: Date.now(),
      });
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCommands.set(commandId, {
      resolve,
      reject,
      timeoutId,
      session_id: session.session_id,
    });
  });

  commands.set(commandId, {
    command_id: commandId,
    session_id: session.session_id,
    action,
    status: 'sent',
    result: null,
    created_at: Date.now(),
  });

  device.ws.send(
    JSON.stringify({
      type: 'run_command',
      command,
    }),
  );

  return promise;
}

const handleOpenClawBrowserRequest = createOpenClawBrowserAdapter({
  devices,
  sessions,
  ensureOnlineDevice,
  sendCommandToDevice,
});

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    writeJson(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    writeJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    const handledOpenClawBrowser = await handleOpenClawBrowserRequest(req, res, url, {
      writeJson,
      readJson,
    });
    if (handledOpenClawBrowser) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        devices: devices.size,
        sessions: sessions.size,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/devices') {
      writeJson(res, 200, {
        ok: true,
        devices: Array.from(devices.values()).map(buildDeviceStatus),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = await readJson(req);
      const deviceId = String(body.device_id || '');
      const taskId = String(body.task_id || `task_${Date.now()}`);
      const startUrl = typeof body.start_url === 'string' ? body.start_url : '';

      const onlineCheck = ensureOnlineDevice(deviceId);
      if (!onlineCheck.ok) {
        writeJson(res, 409, { error: onlineCheck.error });
        return;
      }

      const sessionId = `sess_${randomUUID()}`;
      const session = {
        session_id: sessionId,
        device_id: deviceId,
        task_id: taskId,
        start_url: startUrl,
        status: 'created',
        created_at: Date.now(),
        active_tab_id: null,
        last_page_state: null,
        last_result: null,
        tabs_by_target_id: {},
        active_target_id: null,
        pending_file_chooser: null,
        pending_dialog_policy: null,
        last_console_messages: [],
        last_pdf_path: null,
      };
      sessions.set(sessionId, session);
      writeJson(res, 200, {
        session_id: sessionId,
        task_id: taskId,
        device_id: deviceId,
      });
      return;
    }

    if (
      req.method === 'GET' &&
      (url.pathname.startsWith('/sessions/') || url.pathname.startsWith('/session-status/'))
    ) {
      const pathParts = url.pathname.split('/').filter(Boolean);
      const sessionId =
        pathParts[0] === 'sessions' && pathParts[2] === 'status'
          ? pathParts[1]
          : pathParts[0] === 'session-status'
            ? pathParts[1]
            : pathParts[1];
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(res, 404, { error: `Session ${sessionId} not found` });
        return;
      }
      writeJson(res, 200, buildSessionStatus(session));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/tools/')) {
      const routeAction = actionByRoute.get(url.pathname.replace('/tools/', ''));
      if (!routeAction) {
        writeJson(res, 404, { error: 'Unknown tool route' });
        return;
      }

      const body = await readJson(req);
      const sessionId = String(body.session_id || '');
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(res, 404, { error: `Session ${sessionId} not found` });
        return;
      }

      const existingCommandId = typeof body.command_id === 'string' ? body.command_id : '';
      if (existingCommandId && commands.has(existingCommandId)) {
        writeJson(res, 200, commands.get(existingCommandId).result);
        return;
      }

      try {
        const result = await sendCommandToDevice(session, routeAction, body.args || {}, existingCommandId);
        session.status = result.ok ? 'running' : 'error';
        session.last_result = result;
        writeJson(res, 200, result);
      } catch (error) {
        session.status = 'error';
        writeJson(res, 504, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    writeJson(res, 404, { error: 'Not found' });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let boundDeviceId = null;

  ws.on('message', raw => {
    const message = JSON.parse(String(raw));

    switch (message.type) {
      case 'hello': {
        boundDeviceId = message.device_id;
        const device = {
          device_id: message.device_id,
          user_id: message.metadata?.user_id || 'demo-user',
          status: 'connected',
          last_seen_at: Date.now(),
          ws,
          metadata: message.metadata || {},
        };
        devices.set(message.device_id, device);
        ws.send(
          JSON.stringify({
            type: 'bind_ok',
            device_id: message.device_id,
          }),
        );
        break;
      }
      case 'heartbeat': {
        const device = devices.get(message.device_id);
        if (device) {
          device.last_seen_at = Date.now();
          device.status = 'connected';
        }
        break;
      }
      case 'command_result': {
        const commandRecord = commands.get(message.result.command_id);
        if (commandRecord) {
          commandRecord.status = message.result.ok ? 'completed' : 'failed';
          commandRecord.result = message.result;
        }

        const pending = pendingCommands.get(message.result.command_id);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingCommands.delete(message.result.command_id);
          pending.resolve(message.result);
        }

        const session = sessions.get(message.result.session_id);
        if (session) {
          session.last_result = message.result;
          session.status = message.result.ok ? 'running' : 'error';
          if (message.result.payload?.policy?.paths) {
            session.pending_file_chooser = message.result.payload.policy;
          }
          if (message.result.payload?.policy && Object.hasOwn(message.result.payload.policy, 'accept')) {
            session.pending_dialog_policy = message.result.payload.policy;
          }
          if (Array.isArray(message.result.payload?.messages)) {
            session.last_console_messages = message.result.payload.messages;
          }
        }
        break;
      }
      case 'page_state_event': {
        const session = sessions.get(message.session_id);
        if (session) {
          session.last_page_state = message.page_state;
          session.active_tab_id = message.page_state.tab_id;
          session.active_target_id = Number.isFinite(message.page_state.tab_id)
            ? `tab_${message.page_state.tab_id}`
            : session.active_target_id || null;
          if (Array.isArray(message.page_state.tabs)) {
            session.tabs_by_target_id = Object.fromEntries(
              message.page_state.tabs.map(tab => [tab.target_id || `tab_${tab.tab_id}`, tab]),
            );
          }
        }
        break;
      }
      case 'user_confirmation_result': {
        const session = sessions.get(message.response.session_id);
        if (session) {
          session.last_confirmation = message.response;
          session.last_confirmation_status =
            message.response.decision === 'approve'
              ? 'approved'
              : message.response.decision === 'reject'
                ? 'rejected'
                : message.response.decision === 'stop'
                  ? 'rejected'
                  : session.last_confirmation_status || null;
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!boundDeviceId) {
      return;
    }

    const device = devices.get(boundDeviceId);
    if (device) {
      device.status = 'device_offline';
      device.ws = null;
      device.last_seen_at = Date.now();
    }

    for (const session of sessions.values()) {
      if (session.device_id === boundDeviceId) {
        session.status = 'device_offline';
      }
    }

    const activeSessionsCount = Array.from(sessions.values()).filter(
      session => session.device_id === boundDeviceId,
    ).length;
    console.log(
      `[remote-bridge] ${JSON.stringify({
        event: 'device_disconnected',
        at: new Date().toISOString(),
        device_id: boundDeviceId,
        active_sessions_count: activeSessionsCount,
        last_seen_at: Date.now(),
      })}`,
    );
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[remote-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[remote-bridge] websocket endpoint ws://${HOST}:${PORT}/ws`);
});
