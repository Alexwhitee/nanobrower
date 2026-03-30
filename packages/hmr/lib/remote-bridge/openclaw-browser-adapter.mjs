import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildContentExtractMessage,
  buildDefaultProbeScript,
  buildXiaohongshuExpandScript,
  buildXiaohongshuProbeScript,
  createContentExtractResponse,
  deriveMetadataFromPageState,
  detectXiaohongshuNoteDetail,
  normalizeStats,
  parseCountValue,
} from './content-extract-utils.mjs';

const OPENCLAW_BROWSER_BASE = '/openclaw/browser';
const DEFAULT_START_URL = 'about:blank';
const DEFAULT_DEVICE_ID = (process.env.NANOBROWER_DEFAULT_DEVICE_ID || '').trim();
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'openclaw-bridge', 'browser-screenshots');
const PDF_DIR = path.join(os.tmpdir(), 'openclaw-bridge', 'browser-pdfs');
const DEVICE_READY_WAIT_MS = 8000;
const DEVICE_READY_POLL_MS = 500;
const MAX_AI_SNAPSHOT_ELEMENTS = 25;
const DEFAULT_SNAPSHOT_MAX_CHARS = 3500;
const DEFAULT_ACTION_PAGE_SUMMARY_CHARS = 700;
const DEFAULT_ACTION_TEXT_CHARS = 1600;
const DEFAULT_ACTION_ELEMENT_LIMIT = 8;
const STRUCTURAL_ELEMENT_ROLES = new Set(['generic', 'div', 'span', 'section', 'article', 'li', 'ul', 'ol', 'p']);
const ROLE_PRIORITY = new Map([
  ['searchbox', 120],
  ['textbox', 110],
  ['combobox', 105],
  ['button', 100],
  ['link', 95],
  ['menuitem', 92],
  ['tab', 90],
  ['checkbox', 85],
  ['radio', 85],
  ['option', 82],
  ['listbox', 80],
  ['dialog', 78],
  ['img', 70],
]);

const openClawSessionMappings = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSessionKey(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  return value || 'anonymous';
}

function writeNotFound(writeJson, res) {
  writeJson(res, 404, { error: 'Not found' });
}

function writeUnsupported(writeJson, res, kind, hint) {
  writeJson(res, 501, {
    error: `Unsupported bridge browser action: ${kind}`,
    hint:
      hint ||
      'Use tabs/open/focus/close, snapshot, content/extract, screenshot, console, pdf, upload, dialog, and act(click/type/fill/press/hover/drag/select/resize/wait/evaluate/close/native) in bridge mode.',
  });
}

function mappingKey(sessionKey, deviceId) {
  return `${sessionKey}\u0000${deviceId}`;
}

function tabTargetId(tabId) {
  return `tab_${tabId}`;
}

function parseTabTargetId(targetId) {
  const value = typeof targetId === 'string' ? targetId.trim() : '';
  if (!/^tab_\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value.slice(4), 10);
}

function buildBridgeProfile(device) {
  return {
    name: device.device_id,
    label: device.device_id,
    connected: device.status === 'connected',
    device_id: device.device_id,
    metadata: device.metadata || {},
  };
}

function logOpenClawEvent(event, details = {}) {
  console.log(
    `[remote-bridge][openclaw] ${JSON.stringify({
      event,
      at: new Date().toISOString(),
      ...details,
    })}`,
  );
}

function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Unsupported bridge browser action')) return 'unsupported_action';
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('offline')) return 'device_offline';
  if (message.includes('not registered')) return 'device_not_registered';
  if (message.includes('WebSocket')) return 'websocket_error';
  if (message.includes('unsupported_frame_scope')) return 'unsupported_frame_scope';
  return 'unknown';
}

function buildSnapshotLine(element, compact = true) {
  const parts = [`[${element.id}]`, element.role || 'element'];
  const label = typeof element.label === 'string' ? element.label.trim() : '';
  const text = typeof element.text === 'string' ? element.text.trim() : '';
  const value = typeof element.value === 'string' ? element.value.trim() : '';

  if (label) parts.push(`label="${label}"`);
  if (text && text !== label) parts.push(`text="${text}"`);
  if (value) parts.push(`value="${value}"`);
  if (typeof element.url === 'string' && element.url.trim()) parts.push(`url="${element.url.trim()}"`);
  if (compact) {
    parts.push(element.visible === false ? 'hidden' : 'visible');
    parts.push(element.enabled === false ? 'disabled' : 'enabled');
  }
  return `- ${parts.join(' ')}`;
}

function pickTrimmedString(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return '';
}

function parseInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function collapseWhitespace(value) {
  return pickTrimmedString(value).replace(/\s+/g, ' ').trim();
}

function buildPreviewText(value, maxChars = DEFAULT_ACTION_TEXT_CHARS) {
  return capText(collapseWhitespace(value), maxChars);
}

function buildPreviewUrl(value, maxChars = 160) {
  return capText(pickTrimmedString(value), maxChars);
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function scoreSnapshotElement(element, index) {
  const role = pickTrimmedString(element?.role).toLowerCase() || 'generic';
  const label = pickTrimmedString(element?.label);
  const text = pickTrimmedString(element?.text);
  const value = pickTrimmedString(element?.value);
  const url = pickTrimmedString(element?.url);
  const selector = pickTrimmedString(element?.selector).toLowerCase();
  const combinedText = `${label} ${text}`.trim();

  let score = ROLE_PRIORITY.get(role) || 50;

  if (element?.visible !== false) score += 24;
  else score -= 60;

  if (element?.enabled !== false) score += 8;
  else score -= 24;

  if (label) score += Math.min(label.length, 40);
  if (text && text !== label) score += Math.min(text.length, 28);
  if (value) score += Math.min(value.length, 18);
  if (url) score += 20;
  if (selector.includes('search')) score += 40;
  if (/搜索|search/.test(combinedText)) score += 36;
  if (/笔记|结果|详情|作者|评论|收藏|点赞|更多|展开/.test(combinedText)) score += 12;
  if (/\/explore\/|\/search_result|\/user\/profile\//.test(url)) score += 18;
  if (combinedText.length > 100) score -= 8;

  if (STRUCTURAL_ELEMENT_ROLES.has(role) && !label && !text && !value && !url) {
    score -= 80;
  } else if (STRUCTURAL_ELEMENT_ROLES.has(role) && !label && !url) {
    score -= 20;
  }

  return {
    element,
    index,
    score,
  };
}

function filterSnapshotElements(pageState, query = {}) {
  const selector = typeof query.selector === 'string' ? query.selector.trim() : '';
  const interactive = query.interactive === true || query.interactive === 'true';
  const limit = parseInteger(query.limit, MAX_AI_SNAPSHOT_ELEMENTS);
  let elements = Array.isArray(pageState.elements) ? [...pageState.elements] : [];

  if (selector) {
    elements = elements.filter(element => typeof element.selector === 'string' && element.selector.includes(selector));
  }

  if (interactive) {
    elements = elements.filter(element => element.visible !== false && element.enabled !== false);
  }

  if (Number.isFinite(limit) && limit > 0) {
    elements = elements
      .map((element, index) => scoreSnapshotElement(element, index))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      })
      .slice(0, Math.floor(limit))
      .map(entry => entry.element);
  }

  return elements;
}

function capText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return text;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function buildAiSnapshot(pageState, query = {}) {
  const maxChars = parseInteger(query.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS);
  const compact = query.compact !== false && query.compact !== 'false';
  const lines = [`Page Title: ${pageState.title || '(untitled)'}`, `Page URL: ${pageState.url || '(unknown)'}`];

  if (typeof pageState.page_text_summary === 'string' && pageState.page_text_summary.trim()) {
    lines.push(`Summary: ${pageState.page_text_summary.trim()}`);
  }

  const elements = filterSnapshotElements(pageState, query);
  lines.push(
    `Interactive Elements (${elements.length}/${Array.isArray(pageState.elements) ? pageState.elements.length : 0}):`,
  );
  for (const element of elements) {
    lines.push(buildSnapshotLine(element, compact));
  }

  const snapshotText = lines.join('\n');
  return {
    snapshot: capText(snapshotText, maxChars),
    elements,
    refs: Object.fromEntries(elements.map(element => [element.id, element.role || 'element'])),
    truncated: snapshotText.length > maxChars,
    stats: {
      total: Array.isArray(pageState.elements) ? pageState.elements.length : 0,
      returned: elements.length,
    },
  };
}

function buildCompactElement(element) {
  const label = pickTrimmedString(element?.label);
  const text = pickTrimmedString(element?.text);
  const value = pickTrimmedString(element?.value);
  const url = pickTrimmedString(element?.url);

  return {
    ref: pickTrimmedString(element?.id) || undefined,
    role: pickTrimmedString(element?.role) || 'generic',
    label: label || undefined,
    text: text && text !== label ? buildPreviewText(text, 120) : undefined,
    value: value ? buildPreviewText(value, 80) : undefined,
    url: url ? buildPreviewUrl(url) : undefined,
  };
}

function buildCompactPageState(pageState, query = {}) {
  if (!pageState || typeof pageState !== 'object') {
    return null;
  }

  const elements = filterSnapshotElements(pageState, {
    selector: query.selector || '',
    interactive: query.interactive ?? true,
    limit: parseInteger(query.limit, DEFAULT_ACTION_ELEMENT_LIMIT),
  });

  return {
    url: pickTrimmedString(pageState.url) || '',
    title: pickTrimmedString(pageState.title) || '',
    summary:
      buildPreviewText(
        pageState.page_text_summary || '',
        parseInteger(query.maxChars, DEFAULT_ACTION_PAGE_SUMMARY_CHARS),
      ) || undefined,
    elements: elements.map(buildCompactElement),
    stats: {
      total: Array.isArray(pageState.elements) ? pageState.elements.length : 0,
      returned: elements.length,
    },
  };
}

function summarizeActionValue(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return {
      type: 'string',
      chars: value.length,
      preview: buildPreviewText(value),
    };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length,
      preview: value.slice(0, 5).map(entry => {
        if (typeof entry === 'string') return buildPreviewText(entry, 120);
        if (entry && typeof entry === 'object') return Object.keys(entry).slice(0, 6);
        return entry;
      }),
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).slice(0, 12),
    };
  }
  return String(value);
}

function buildCompactActionPayload(kind, payload) {
  if (!payload || typeof payload !== 'object') {
    return payload ?? null;
  }

  const compact = {};
  const message = pickTrimmedString(payload.message);
  if (message) {
    compact.message = message;
  }

  if (Object.hasOwn(payload, 'navigated')) {
    compact.navigated = Boolean(payload.navigated);
  }
  if (Object.hasOwn(payload, 'bridgeAliasedFrom')) {
    compact.bridgeAliasedFrom = payload.bridgeAliasedFrom;
  }
  if (Object.hasOwn(payload, 'nativeAction')) {
    compact.nativeAction = payload.nativeAction;
  }
  if (Object.hasOwn(payload, 'screenshot_ref')) {
    compact.screenshotRef = payload.screenshot_ref;
  }
  if (Object.hasOwn(payload, 'value')) {
    compact.value = summarizeActionValue(payload.value);
  }
  if (typeof payload.text === 'string') {
    compact.text = buildPreviewText(payload.text);
  }
  if (Array.isArray(payload.messages)) {
    compact.messages = {
      count: payload.messages.length,
      preview: payload.messages.slice(0, 3).map(messageValue => buildPreviewText(String(messageValue || ''), 160)),
    };
  }
  if (payload.policy && typeof payload.policy === 'object') {
    compact.policy = payload.policy;
  }
  if (payload.extraction && typeof payload.extraction === 'object') {
    compact.extraction = {
      ok: payload.extraction.ok !== false,
      url: pickTrimmedString(payload.extraction.url) || undefined,
      pageKind: pickTrimmedString(payload.extraction.pageKind) || undefined,
      title: pickTrimmedString(payload.extraction.title) || undefined,
      author: pickTrimmedString(payload.extraction.author) || undefined,
      stats: payload.extraction.stats || undefined,
      bodyChars: payload.extraction.bodyChars ?? undefined,
      bodyPreview:
        typeof payload.extraction.body === 'string'
          ? buildPreviewText(payload.extraction.body, DEFAULT_ACTION_TEXT_CHARS)
          : undefined,
      extractedBy: pickTrimmedString(payload.extraction.extractedBy) || undefined,
      completeness: pickTrimmedString(payload.extraction.completeness) || undefined,
      reason: pickTrimmedString(payload.extraction.reason) || undefined,
    };
  }

  const pageState = payload.page_state || payload.pageState || null;
  const compactPage = buildCompactPageState(pageState);
  if (compactPage) {
    compact.page = compactPage;
  }

  if (!Object.keys(compact).length) {
    return {
      kind,
      keys: Object.keys(payload).slice(0, 12),
    };
  }

  return compact;
}

function buildAriaNode(element) {
  return {
    ref: element.id,
    role: element.role || 'generic',
    name: element.label || element.text || '',
    value: element.value || '',
    description: element.text || '',
    url: element.url || '',
    visible: element.visible !== false,
    enabled: element.enabled !== false,
  };
}

function readProfileFromRequest(url) {
  return (url.searchParams.get('profile') || '').trim();
}

function ensureSessionFields(session) {
  if (!session.tabs_by_target_id) {
    session.tabs_by_target_id = {};
  }
  if (!Object.hasOwn(session, 'active_target_id')) {
    session.active_target_id = null;
  }
  if (!Object.hasOwn(session, 'pending_file_chooser')) {
    session.pending_file_chooser = null;
  }
  if (!Object.hasOwn(session, 'pending_dialog_policy')) {
    session.pending_dialog_policy = null;
  }
  if (!Object.hasOwn(session, 'last_console_messages')) {
    session.last_console_messages = [];
  }
  if (!Object.hasOwn(session, 'last_pdf_path')) {
    session.last_pdf_path = null;
  }
}

function updateSessionTabs(session, tabs = [], activeTabId = null) {
  ensureSessionFields(session);
  const next = {};
  for (const tab of tabs) {
    const targetId = tab.target_id || tabTargetId(tab.tab_id);
    next[targetId] = {
      ...tab,
      targetId,
    };
  }
  session.tabs_by_target_id = next;
  if (Number.isFinite(activeTabId)) {
    session.active_tab_id = activeTabId;
    session.active_target_id = tabTargetId(activeTabId);
  } else {
    const activeTab = tabs.find(tab => tab.active) || tabs[0] || null;
    session.active_tab_id = activeTab?.tab_id ?? session.active_tab_id ?? null;
    session.active_target_id = activeTab ? tabTargetId(activeTab.tab_id) : session.active_target_id || null;
  }
}

function syncSessionFromPageState(session, pageState) {
  if (!session || !pageState) return;
  session.last_page_state = pageState;
  updateSessionTabs(
    session,
    Array.isArray(pageState.tabs)
      ? pageState.tabs.map(tab => ({
          ...tab,
          target_id: tab.target_id || tabTargetId(tab.tab_id),
        }))
      : pageState.tab_id
        ? [
            {
              tab_id: pageState.tab_id,
              target_id: tabTargetId(pageState.tab_id),
              url: pageState.url || '',
              title: pageState.title || '',
              active: true,
            },
          ]
        : [],
    pageState.tab_id ?? null,
  );
}

function syncSessionFromPayload(session, payload) {
  if (!session || !payload || typeof payload !== 'object') return;
  if (payload.page_state) {
    syncSessionFromPageState(session, payload.page_state);
  }
  if (Array.isArray(payload.tabs)) {
    updateSessionTabs(session, payload.tabs, payload.active_tab_id ?? session.active_tab_id ?? null);
  }
  if (Array.isArray(payload.messages)) {
    session.last_console_messages = payload.messages;
  }
  if (payload.policy && payload.policy.paths) {
    session.pending_file_chooser = payload.policy;
  }
  if (payload.policy && Object.hasOwn(payload.policy, 'accept')) {
    session.pending_dialog_policy = payload.policy;
  }
}

function resolveTargetSession({ sessions, targetId, sessionKey, deviceId }) {
  const target = typeof targetId === 'string' ? targetId.trim() : '';
  const mapping = deviceId ? openClawSessionMappings.get(mappingKey(sessionKey, deviceId)) : null;
  const session = mapping?.bridgeSessionId ? sessions.get(mapping.bridgeSessionId) : null;

  if (session) {
    ensureSessionFields(session);
    if (!target || target === session.session_id || session.tabs_by_target_id[target]) {
      return {
        bridgeSessionId: session.session_id,
        session,
        mapping,
      };
    }
  }

  if (target && sessions.has(target)) {
    return {
      bridgeSessionId: target,
      session: sessions.get(target),
    };
  }

  return null;
}

function resolveDeviceId({ explicitProfile, targetSession }) {
  if (explicitProfile) return explicitProfile;
  if (targetSession?.session?.device_id) return targetSession.session.device_id;
  return DEFAULT_DEVICE_ID;
}

function setConfirmationStatus(session, status) {
  if (!session) return;
  session.last_confirmation_status = status;
}

function rememberSessionMapping({ sessionKey, session, latestPageState, screenshotPath }) {
  const key = mappingKey(sessionKey, session.device_id);
  const current = openClawSessionMappings.get(key);
  openClawSessionMappings.set(key, {
    openClawSessionKey: sessionKey,
    deviceId: session.device_id,
    bridgeSessionId: session.session_id,
    latestPageState: latestPageState ?? current?.latestPageState ?? null,
    latestScreenshotPath: screenshotPath ?? current?.latestScreenshotPath ?? null,
    updatedAt: Date.now(),
  });
}

function forgetSessionMapping({ sessionKey, deviceId }) {
  openClawSessionMappings.delete(mappingKey(sessionKey, deviceId));
}

async function resolveReadyDevice(ctx, deviceId, options = {}) {
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : DEVICE_READY_WAIT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEVICE_READY_POLL_MS;
  const deadline = Date.now() + waitMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    const onlineCheck = ctx.ensureOnlineDevice(deviceId);
    if (onlineCheck.ok) {
      return onlineCheck.device;
    }

    lastError = onlineCheck.error;
    if (typeof lastError !== 'string' || !lastError.includes('offline')) {
      throw new Error(lastError || `Device ${deviceId} is not ready`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }

  throw new Error(lastError || `Device ${deviceId} is offline`);
}

async function ensureBridgeSession(ctx, params) {
  const { sessions } = ctx;
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const deviceId = (params.deviceId || '').trim();

  if (!deviceId) {
    throw new Error('device required: pass profile=<device_id> or set NANOBROWER_DEFAULT_DEVICE_ID');
  }

  const existing = resolveTargetSession({
    sessions,
    targetId: params.targetId,
    sessionKey,
    deviceId,
  });
  if (existing?.session) {
    ensureSessionFields(existing.session);
    return existing.session;
  }

  await resolveReadyDevice(ctx, deviceId);

  const sessionId = `sess_${randomUUID()}`;
  const session = {
    session_id: sessionId,
    device_id: deviceId,
    task_id: `openclaw_${sessionKey}`,
    start_url: params.startUrl || DEFAULT_START_URL,
    status: 'created',
    created_at: Date.now(),
    active_tab_id: null,
    last_page_state: null,
    last_result: null,
    openclaw_session_key: sessionKey,
    last_confirmation_status: null,
    tabs_by_target_id: {},
    active_target_id: null,
    pending_file_chooser: null,
    pending_dialog_policy: null,
    last_console_messages: [],
    last_pdf_path: null,
  };
  sessions.set(sessionId, session);
  rememberSessionMapping({ sessionKey, session });
  logOpenClawEvent('session_created', {
    openclaw_session_key: sessionKey,
    device_id: deviceId,
    bridge_session_id: sessionId,
  });
  return session;
}

async function runBridgeAction(ctx, params) {
  const { sendCommandToDevice } = ctx;
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const session = params.session;
  const action = params.action;
  const startedAt = Date.now();

  if (action === 'click') {
    setConfirmationStatus(session, 'pending');
  }

  logOpenClawEvent('action_start', {
    openclaw_session_key: sessionKey,
    device_id: session.device_id,
    bridge_session_id: session.session_id,
    action,
  });

  let result;
  let retryCount = 0;

  try {
    result = await sendCommandToDevice(session, action, params.args || {}, undefined, {
      openclaw_session_key: sessionKey,
      attempt: 1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('offline') && !message.includes('WebSocket')) {
      logOpenClawEvent('action_error', {
        openclaw_session_key: sessionKey,
        device_id: session.device_id,
        bridge_session_id: session.session_id,
        action,
        attempt: 1,
        duration_ms: Date.now() - startedAt,
        error: message,
        error_class: classifyError(error),
      });
      throw error;
    }

    retryCount = 1;
    await resolveReadyDevice(ctx, session.device_id);
    result = await sendCommandToDevice(session, action, params.args || {}, undefined, {
      openclaw_session_key: sessionKey,
      attempt: 2,
    });
  }

  if (result?.payload) {
    syncSessionFromPayload(session, result.payload);
  }

  const pageState = result.payload?.page_state || session.last_page_state || null;
  const confirmationStatus =
    session.last_confirmation_status ||
    (action === 'click' && result.ok ? 'approved' : action === 'click' && !result.ok ? 'rejected' : null);

  if (action === 'click' && !result.ok && typeof result.error === 'string' && result.error.includes('timed out')) {
    setConfirmationStatus(session, 'timeout');
  } else if (confirmationStatus) {
    setConfirmationStatus(session, confirmationStatus);
  }

  rememberSessionMapping({
    sessionKey,
    session,
    latestPageState: pageState,
  });

  logOpenClawEvent('action_end', {
    openclaw_session_key: sessionKey,
    device_id: session.device_id,
    bridge_session_id: session.session_id,
    action,
    command_id: result.command_id,
    ok: result.ok,
    retry_count: retryCount,
    confirmation_status: session.last_confirmation_status || null,
    duration_ms: Date.now() - startedAt,
  });

  return result;
}

async function fetchFreshPageState(ctx, params) {
  const result = await runBridgeAction(ctx, {
    sessionKey: params.sessionKey,
    session: params.session,
    action: 'get_page_state',
    args: {},
  });

  if (!result.ok) {
    throw new Error(result.error || 'Failed to collect page state');
  }

  const pageState = result.payload?.page_state || params.session.last_page_state;
  if (!pageState) {
    throw new Error('Bridge did not return page_state');
  }

  rememberSessionMapping({
    sessionKey: params.sessionKey,
    session: params.session,
    latestPageState: pageState,
  });

  return pageState;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function mergeUniqueValues(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const text = normalizeText(value);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      merged.push(text);
    }
  }
  return merged;
}

function pickFirstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function mergeStats(...statsList) {
  const merged = {};
  for (const stats of statsList) {
    const normalized = normalizeStats(stats || {});
    for (const [key, value] of Object.entries(normalized)) {
      if (!Object.hasOwn(merged, key)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function mapProbeStats(statsTexts = []) {
  const values = Array.isArray(statsTexts)
    ? statsTexts.map(value => parseCountValue(value)).filter(value => Number.isFinite(value))
    : [];
  if (values.length < 3) {
    return {};
  }
  return {
    favorites: values[0],
    likes: values[1],
    comments: values[2],
  };
}

function buildContentResponse(response) {
  const message = buildContentExtractMessage(response);
  return message ? { ...response, message } : response;
}

async function runEvaluateScript(ctx, { sessionKey, session, fn }) {
  const result = await runBridgeAction(ctx, {
    sessionKey,
    session,
    action: 'evaluate_script',
    args: { fn },
  });
  if (!result.ok) {
    throw new Error(result.error || 'Bridge evaluate failed');
  }
  return {
    value: result.payload?.result?.value,
    pageState: result.payload?.page_state || session.last_page_state || null,
  };
}

async function runExtractText(ctx, { sessionKey, session, mode, selector }) {
  const result = await runBridgeAction(ctx, {
    sessionKey,
    session,
    action: 'extract_text',
    args: {
      mode,
      selector: selector || undefined,
    },
  });
  if (!result.ok) {
    throw new Error(result.error || `Bridge extract_text failed for ${mode}`);
  }
  return {
    text: normalizeText(result.payload?.text),
    pageState: result.payload?.page_state || session.last_page_state || null,
  };
}

function selectContentExtractor(pageState, domainHint = '') {
  const normalizedHint = normalizeText(domainHint).toLowerCase();
  const url = normalizeText(pageState?.url);
  const wantsXiaohongshu = normalizedHint === 'xiaohongshu' || url.includes('xiaohongshu.com');
  if (wantsXiaohongshu) {
    return {
      key: 'xiaohongshu',
      probeScript: buildXiaohongshuProbeScript(),
      expandScript: buildXiaohongshuExpandScript(),
      pageKind: detectXiaohongshuNoteDetail(pageState, normalizedHint) ? 'xiaohongshu_note_detail' : 'unknown',
    };
  }

  return {
    key: 'default',
    probeScript: buildDefaultProbeScript(),
    expandScript: null,
    pageKind: 'unknown',
  };
}

async function extractContent(ctx, { sessionKey, session, domainHint = '' }) {
  let pageState = await fetchFreshPageState(ctx, {
    sessionKey,
    session,
  });

  const extractor = selectContentExtractor(pageState, domainHint);
  const initialMeta = deriveMetadataFromPageState(pageState);

  if (extractor.key === 'xiaohongshu' && extractor.pageKind !== 'xiaohongshu_note_detail') {
    return buildContentResponse(
      createContentExtractResponse({
        pageState,
        pageKind: 'unknown',
        title: initialMeta.title,
        author: initialMeta.author,
        hashtags: initialMeta.hashtags,
        stats: initialMeta.stats,
        body: '',
        extractedBy: 'page_state_only',
        reason: 'not_detail_page',
      }),
    );
  }

  let expandFailed = false;
  if (extractor.expandScript) {
    try {
      const expanded = await runEvaluateScript(ctx, {
        sessionKey,
        session,
        fn: extractor.expandScript,
      });
      pageState = expanded.pageState || pageState;
      if (expanded.value?.attempted && !expanded.value?.clicked && expanded.value?.reason !== 'not_found') {
        expandFailed = true;
      }
    } catch {
      expandFailed = true;
    }
  }

  pageState = await fetchFreshPageState(ctx, {
    sessionKey,
    session,
  });

  const pageStateMeta = deriveMetadataFromPageState(pageState);
  let probeData = {};
  let evaluateFailed = false;
  try {
    const evaluated = await runEvaluateScript(ctx, {
      sessionKey,
      session,
      fn: extractor.probeScript,
    });
    pageState = evaluated.pageState || pageState;
    probeData = typeof evaluated.value === 'object' && evaluated.value !== null ? evaluated.value : {};
  } catch {
    evaluateFailed = true;
  }

  const mergedTitle = pickFirstText(probeData.title, pageStateMeta.title, initialMeta.title, pageState.title);
  const mergedAuthor = pickFirstText(probeData.author, pageStateMeta.author, initialMeta.author);
  const mergedHashtags = mergeUniqueValues(probeData.hashtags, pageStateMeta.hashtags, initialMeta.hashtags);
  const mergedStats = mergeStats(mapProbeStats(probeData.statsTexts), pageStateMeta.stats, initialMeta.stats);
  const containerSelector = normalizeText(probeData.containerSelector);
  const visibleBodyChars = Number(probeData.visibleBodyChars) || 0;

  let currentBody = pickFirstText(probeData.body, '');
  let extractedBy = currentBody ? 'evaluate' : 'page_state_only';
  let currentReason = evaluateFailed ? 'evaluate_error' : undefined;

  const shouldReplaceBody = nextBody => normalizeText(nextBody).length > normalizeText(currentBody).length;

  if ((!currentBody || normalizeText(currentBody).length < 200) && containerSelector) {
    try {
      const markdown = await runExtractText(ctx, {
        sessionKey,
        session,
        mode: 'markdown',
        selector: containerSelector,
      });
      pageState = markdown.pageState || pageState;
      if (shouldReplaceBody(markdown.text)) {
        currentBody = markdown.text;
        extractedBy = 'extract_text_markdown';
        currentReason = undefined;
      }
    } catch {
      currentReason = currentReason || 'extract_text_error';
    }
  }

  if (!currentBody || normalizeText(currentBody).length < 200) {
    try {
      const readability = await runExtractText(ctx, {
        sessionKey,
        session,
        mode: 'readability',
      });
      pageState = readability.pageState || pageState;
      if (shouldReplaceBody(readability.text)) {
        currentBody = readability.text;
        extractedBy = 'extract_text_readability';
        currentReason = undefined;
      }
    } catch {
      currentReason = currentReason || 'extract_text_error';
    }
  }

  const refreshedMeta = deriveMetadataFromPageState(pageState);
  if ((!currentBody || normalizeText(currentBody).length < 120) && shouldReplaceBody(refreshedMeta.body)) {
    currentBody = refreshedMeta.body;
    extractedBy = extractedBy === 'page_state_only' ? 'page_state_only' : extractedBy;
  }

  const response = createContentExtractResponse({
    pageState,
    pageKind: extractor.pageKind,
    title: pickFirstText(mergedTitle, refreshedMeta.title, pageState.title),
    author: pickFirstText(mergedAuthor, refreshedMeta.author),
    hashtags: mergeUniqueValues(mergedHashtags, refreshedMeta.hashtags),
    stats: mergeStats(mergedStats, refreshedMeta.stats),
    body: currentBody,
    extractedBy,
    reason: currentReason || (expandFailed ? 'expand_failed' : undefined),
    containerSelector,
    visibleBodyChars,
  });

  return buildContentResponse(response);
}

async function saveBase64Artifact(baseDir, base64Value, extension) {
  if (typeof base64Value !== 'string' || !base64Value.trim()) {
    throw new Error('Bridge artifact payload missing data');
  }

  await mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `bridge-${Date.now()}-${randomUUID()}.${extension}`);
  await writeFile(filePath, Buffer.from(base64Value, 'base64'));
  return filePath;
}

async function ensureTargetFocused(ctx, sessionKey, session, targetId) {
  const tabId = parseTabTargetId(targetId);
  if (!Number.isFinite(tabId)) {
    return;
  }
  if (session.active_tab_id === tabId) {
    return;
  }

  const result = await runBridgeAction(ctx, {
    sessionKey,
    session,
    action: 'focus_tab',
    args: { tab_id: tabId },
  });
  if (!result.ok) {
    throw new Error(result.error || `Failed to focus tab ${targetId}`);
  }
}

function buildStatusPayload(session) {
  ensureSessionFields(session || {});
  return {
    ok: true,
    running: Boolean(session) && session.status !== 'stopped',
    chosenBrowser: 'bridge',
    bridge: true,
    targetId: session?.active_target_id || null,
    tabCount: session ? Object.keys(session.tabs_by_target_id || {}).length : 0,
    sessionId: session?.session_id || null,
    deviceId: session?.device_id || null,
    confirmationStatus: session?.last_confirmation_status || null,
  };
}

function buildTabsResponse(session) {
  ensureSessionFields(session);
  const tabs = Object.values(session.tabs_by_target_id || {}).map(tab => ({
    targetId: tab.targetId || tab.target_id || tabTargetId(tab.tab_id),
    tabId: tab.tab_id,
    url: tab.url,
    title: tab.title,
    active: (tab.targetId || tab.target_id || tabTargetId(tab.tab_id)) === session.active_target_id,
  }));
  return {
    tabs,
  };
}

export function createOpenClawBrowserAdapter(ctx) {
  return async function handleOpenClawBrowserRequest(req, res, url, { writeJson, readJson }) {
    if (!url.pathname.startsWith(OPENCLAW_BROWSER_BASE)) {
      return false;
    }

    const sessionKey = normalizeSessionKey(req.headers['x-openclaw-session-key']);
    const relativePath = url.pathname.slice(OPENCLAW_BROWSER_BASE.length) || '/';
    const explicitProfile = readProfileFromRequest(url);
    const targetSession = resolveTargetSession({
      sessions: ctx.sessions,
      targetId: url.searchParams.get('targetId') || '',
      sessionKey,
      deviceId: explicitProfile || DEFAULT_DEVICE_ID,
    });
    const deviceId = resolveDeviceId({
      explicitProfile,
      targetSession,
    });

    try {
      if (url.searchParams.get('frame')) {
        writeJson(res, 501, {
          error: 'unsupported_frame_scope',
          hint: 'Bridge mode does not support frame-scoped snapshot yet.',
        });
        return true;
      }

      if (req.method === 'GET' && relativePath === '/profiles') {
        writeJson(res, 200, {
          profiles: Array.from(ctx.devices.values())
            .filter(device => device.status === 'connected')
            .map(buildBridgeProfile),
        });
        return true;
      }

      if (req.method === 'GET' && relativePath === '/') {
        const session = deviceId
          ? resolveTargetSession({
              sessions: ctx.sessions,
              sessionKey,
              deviceId,
            })?.session || null
          : null;
        writeJson(res, 200, buildStatusPayload(session));
        return true;
      }

      if (req.method === 'POST' && relativePath === '/start') {
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
        });
        writeJson(res, 200, buildStatusPayload(session));
        return true;
      }

      if (req.method === 'POST' && relativePath === '/stop') {
        const resolved = deviceId
          ? resolveTargetSession({
              sessions: ctx.sessions,
              sessionKey,
              deviceId,
            })
          : null;
        if (resolved?.session) {
          await runBridgeAction(ctx, {
            sessionKey,
            session: resolved.session,
            action: 'stop_session',
            args: {},
          });
          resolved.session.status = 'stopped';
          forgetSessionMapping({
            sessionKey,
            deviceId: resolved.session.device_id,
          });
        }
        writeJson(res, 200, {
          ok: true,
          stopped: true,
          bridge: true,
        });
        return true;
      }

      if (req.method === 'GET' && relativePath === '/tabs') {
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
        });
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'get_tabs',
          args: {},
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge tab listing failed' });
          return true;
        }

        writeJson(res, 200, buildTabsResponse(session));
        return true;
      }

      if (req.method === 'POST' && relativePath === '/tabs/open') {
        const body = await readJson(req);
        const targetUrl = typeof body.url === 'string' ? body.url.trim() : '';
        if (!targetUrl) {
          writeJson(res, 400, { error: 'url is required' });
          return true;
        }

        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
        });
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'open_tab',
          args: { url: targetUrl },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge open tab failed' });
          return true;
        }

        const tab =
          result.payload?.tab || Object.values(session.tabs_by_target_id || {}).find(entry => entry.active) || null;
        writeJson(res, 200, {
          ok: true,
          targetId: tab?.target_id || tab?.targetId || session.active_target_id,
          url: tab?.url || result.payload?.page_state?.url || targetUrl,
          title: tab?.title || result.payload?.page_state?.title || 'Bridge Tab',
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/tabs/focus') {
        const body = await readJson(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const tabId = parseTabTargetId(targetId);
        if (!Number.isFinite(tabId)) {
          writeJson(res, 400, { error: 'targetId must be a bridge tab id like tab_123' });
          return true;
        }

        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'focus_tab',
          args: { tab_id: tabId },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge focus tab failed' });
          return true;
        }

        writeJson(res, 200, {
          ok: true,
          targetId: tabTargetId(tabId),
          focused: true,
        });
        return true;
      }

      if (req.method === 'DELETE' && relativePath.startsWith('/tabs/')) {
        const targetId = decodeURIComponent(relativePath.slice('/tabs/'.length));
        const tabId = parseTabTargetId(targetId);
        const resolved = resolveTargetSession({
          sessions: ctx.sessions,
          targetId,
          sessionKey,
          deviceId,
        });
        if (!resolved?.session) {
          writeJson(res, 404, { error: `Session for ${targetId} not found` });
          return true;
        }

        if (Number.isFinite(tabId)) {
          const result = await runBridgeAction(ctx, {
            sessionKey,
            session: resolved.session,
            action: 'close_tab',
            args: { tab_id: tabId },
          });
          if (!result.ok) {
            writeJson(res, 502, { error: result.error || `Failed to close ${targetId}` });
            return true;
          }
          writeJson(res, 200, { ok: true, targetId, closed: true });
          return true;
        }

        await runBridgeAction(ctx, {
          sessionKey,
          session: resolved.session,
          action: 'stop_session',
          args: {},
        });
        resolved.session.status = 'stopped';
        forgetSessionMapping({
          sessionKey,
          deviceId: resolved.session.device_id,
        });
        writeJson(res, 200, { ok: true, targetId: resolved.session.session_id, stopped: true });
        return true;
      }

      if (req.method === 'GET' && relativePath === '/snapshot') {
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId: url.searchParams.get('targetId') || '',
        });
        const targetId = url.searchParams.get('targetId') || '';
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }
        const pageState = await fetchFreshPageState(ctx, {
          sessionKey,
          session,
        });
        const format = (url.searchParams.get('format') || 'ai').trim();
        const activeTargetId = session.active_target_id || tabTargetId(pageState.tab_id);

        if (format === 'aria') {
          const elements = filterSnapshotElements(pageState, {
            selector: url.searchParams.get('selector') || '',
            interactive: url.searchParams.get('interactive') === 'true',
            limit: url.searchParams.get('limit') || MAX_AI_SNAPSHOT_ELEMENTS,
          });
          writeJson(res, 200, {
            ok: true,
            format: 'aria',
            targetId: activeTargetId,
            url: pageState.url || '',
            title: pageState.title || '',
            nodes: elements.map(buildAriaNode),
            labels: Boolean(url.searchParams.get('labels')),
            labelsCount: 0,
            labelsSkipped: Boolean(url.searchParams.get('labels')),
          });
          return true;
        }

        const aiSnapshot = buildAiSnapshot(pageState, {
          selector: url.searchParams.get('selector') || '',
          interactive: url.searchParams.get('interactive') === 'true',
          compact: url.searchParams.get('compact') !== 'false',
          limit: url.searchParams.get('limit') || MAX_AI_SNAPSHOT_ELEMENTS,
          maxChars: url.searchParams.get('maxChars') || DEFAULT_SNAPSHOT_MAX_CHARS,
        });

        writeJson(res, 200, {
          ok: true,
          format: 'ai',
          targetId: activeTargetId,
          url: pageState.url || '',
          title: pageState.title || '',
          snapshot: aiSnapshot.snapshot,
          refs: aiSnapshot.refs,
          truncated: aiSnapshot.truncated,
          stats: aiSnapshot.stats,
          labels: Boolean(url.searchParams.get('labels')),
          labelsCount: 0,
          labelsSkipped: Boolean(url.searchParams.get('labels')),
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/content/extract') {
        const body = await readJson(req);
        const targetId = normalizeText(body.targetId || url.searchParams.get('targetId') || '');
        const domainHint = normalizeText(body.domainHint || url.searchParams.get('domainHint') || '');
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        const extraction = await extractContent(ctx, {
          sessionKey,
          session,
          domainHint,
        });

        writeJson(res, 200, {
          ...extraction,
          targetId: session.active_target_id || targetId || null,
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/screenshot') {
        const body = await readJson(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
        const element = typeof body.element === 'string' ? body.element.trim() : '';
        const imageType = body.type === 'png' ? 'png' : 'jpeg';
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'screenshot',
          args: {
            full_page: Boolean(body.fullPage),
            element_id: ref || element || undefined,
          },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge screenshot failed' });
          return true;
        }

        const savedPath = await saveBase64Artifact(
          SCREENSHOT_DIR,
          result.payload?.screenshot,
          imageType === 'png' ? 'png' : 'jpg',
        );
        rememberSessionMapping({
          sessionKey,
          session,
          latestPageState: result.payload?.page_state || session.last_page_state || null,
          screenshotPath: savedPath,
        });
        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          path: savedPath,
          type: imageType,
          screenshotRef: result.payload?.screenshot_ref || null,
          url: result.payload?.page_state?.url || session.last_page_state?.url || '',
        });
        return true;
      }

      if (req.method === 'GET' && relativePath === '/console') {
        const targetId = url.searchParams.get('targetId') || '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'console_messages',
          args: {
            level: url.searchParams.get('level') || undefined,
          },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge console failed' });
          return true;
        }
        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          messages: result.payload?.messages || session.last_console_messages || [],
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/pdf') {
        const body = await readJson(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'save_pdf',
          args: {},
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge pdf failed' });
          return true;
        }

        const savedPath = await saveBase64Artifact(PDF_DIR, result.payload?.pdf, 'pdf');
        session.last_pdf_path = savedPath;
        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          path: savedPath,
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/hooks/file-chooser') {
        const body = await readJson(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'arm_file_chooser',
          args: {
            paths: Array.isArray(body.paths) ? body.paths : [],
            ref: typeof body.ref === 'string' ? body.ref : undefined,
            input_ref: typeof body.inputRef === 'string' ? body.inputRef : undefined,
            element: typeof body.element === 'string' ? body.element : undefined,
          },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge upload arm failed' });
          return true;
        }

        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          armed: true,
          policy: result.payload?.policy || null,
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/hooks/dialog') {
        const body = await readJson(req);
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'arm_dialog',
          args: {
            accept: Boolean(body.accept),
            prompt_text: typeof body.promptText === 'string' ? body.promptText : undefined,
          },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge dialog arm failed' });
          return true;
        }

        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          armed: true,
          policy: result.payload?.policy || null,
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/navigate') {
        const body = await readJson(req);
        const targetUrl = typeof body.url === 'string' ? body.url.trim() : '';
        if (!targetUrl) {
          writeJson(res, 400, { error: 'url is required' });
          return true;
        }

        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });
        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }
        const result = await runBridgeAction(ctx, {
          sessionKey,
          session,
          action: 'navigate',
          args: {
            url: targetUrl,
            tab_id: Number.isFinite(parseTabTargetId(targetId)) ? parseTabTargetId(targetId) : undefined,
          },
        });
        if (!result.ok) {
          writeJson(res, 502, { error: result.error || 'Bridge navigate failed' });
          return true;
        }

        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          url: result.payload?.page_state?.url || targetUrl,
          navigated: result.payload?.navigated ?? true,
        });
        return true;
      }

      if (req.method === 'POST' && relativePath === '/act') {
        const rawBody = await readJson(req);
        const body =
          typeof rawBody.request === 'object' && rawBody.request !== null
            ? {
                ...rawBody.request,
                ...rawBody,
              }
            : rawBody;
        delete body.request;

        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
        const verbose = parseBooleanFlag(body.verbose ?? url.searchParams.get('verbose'), false);
        const session = await ensureBridgeSession(ctx, {
          sessionKey,
          deviceId,
          targetId,
        });

        if (!kind) {
          writeJson(res, 400, { error: 'kind is required' });
          return true;
        }

        if (targetId) {
          await ensureTargetFocused(ctx, sessionKey, session, targetId);
        }

        let result;
        switch (kind) {
          case 'click': {
            const ref = pickTrimmedString(body.ref, body.inputRef);
            if (!ref) {
              writeJson(res, 400, { error: 'ref is required for click' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'click',
              args: { element_id: ref },
            });
            break;
          }
          case 'type': {
            const ref = pickTrimmedString(body.ref, body.inputRef);
            const text = typeof body.text === 'string' ? body.text : '';
            if (!ref || !text) {
              writeJson(res, 400, { error: 'ref and text are required for type' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'type',
              args: { element_id: ref, text },
            });
            break;
          }
          case 'fill': {
            const ref = pickTrimmedString(body.ref, body.inputRef);
            const text = typeof body.text === 'string' ? body.text : '';
            if (!ref || !text) {
              writeJson(res, 400, { error: 'ref and text are required for fill' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'type',
              args: { element_id: ref, text },
            });
            if (result?.payload) {
              result = {
                ...result,
                payload: {
                  ...(result.payload || {}),
                  bridgeAliasedFrom: 'fill',
                },
              };
            }
            break;
          }
          case 'press': {
            const key = typeof body.key === 'string' ? body.key.trim() : '';
            const ref = pickTrimmedString(body.ref, body.inputRef);
            if (!key) {
              writeJson(res, 400, { error: 'key is required for press' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'press_key',
              args: {
                key,
                element_id: ref || undefined,
              },
            });
            break;
          }
          case 'hover': {
            const ref = pickTrimmedString(body.ref, body.inputRef);
            if (!ref) {
              writeJson(res, 400, { error: 'ref is required for hover' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'hover',
              args: { element_id: ref },
            });
            break;
          }
          case 'drag': {
            const startRef = typeof body.startRef === 'string' ? body.startRef.trim() : '';
            const endRef = typeof body.endRef === 'string' ? body.endRef.trim() : '';
            if (!startRef || !endRef) {
              writeJson(res, 400, { error: 'startRef and endRef are required for drag' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'drag',
              args: {
                start_element_id: startRef,
                end_element_id: endRef,
              },
            });
            break;
          }
          case 'select': {
            const ref = pickTrimmedString(body.ref, body.inputRef);
            const value = Array.isArray(body.values) ? String(body.values[0] || '') : '';
            if (!ref || !value) {
              writeJson(res, 400, { error: 'ref and at least one value are required for select' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'select_option',
              args: { element_id: ref, text: value },
            });
            break;
          }
          case 'resize': {
            const width = Number(body.width);
            const height = Number(body.height);
            if (!Number.isFinite(width) || !Number.isFinite(height)) {
              writeJson(res, 400, { error: 'width and height are required for resize' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'resize_window',
              args: { width, height },
            });
            break;
          }
          case 'wait': {
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'wait_for',
              args: {
                text: typeof body.text === 'string' ? body.text : undefined,
                selector: typeof body.selector === 'string' ? body.selector : undefined,
                url: typeof body.url === 'string' ? body.url : undefined,
                load_state: typeof body.loadState === 'string' ? body.loadState : undefined,
                fn: typeof body.fn === 'string' ? body.fn : undefined,
                time_ms: typeof body.timeMs === 'number' ? body.timeMs : undefined,
                timeout_ms: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
              },
            });
            break;
          }
          case 'evaluate': {
            const fn = typeof body.fn === 'string' ? body.fn.trim() : '';
            if (!fn) {
              writeJson(res, 400, { error: 'fn is required for evaluate' });
              return true;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'evaluate_script',
              args: { fn },
            });
            break;
          }
          case 'close': {
            if (targetId && Number.isFinite(parseTabTargetId(targetId))) {
              result = await runBridgeAction(ctx, {
                sessionKey,
                session,
                action: 'close_tab',
                args: { tab_id: parseTabTargetId(targetId) },
              });
            } else {
              await runBridgeAction(ctx, {
                sessionKey,
                session,
                action: 'stop_session',
                args: {},
              });
              session.status = 'stopped';
              forgetSessionMapping({
                sessionKey,
                deviceId: session.device_id,
              });
              writeJson(res, 200, {
                ok: true,
                targetId: session.session_id,
                stopped: true,
              });
              return true;
            }
            break;
          }
          case 'native': {
            const nativeAction = typeof body.nativeAction === 'string' ? body.nativeAction.trim() : '';
            const nativeArgs = typeof body.nativeArgs === 'object' && body.nativeArgs !== null ? body.nativeArgs : {};
            if (!nativeAction) {
              writeJson(res, 400, { error: 'nativeAction is required for native bridge actions' });
              return true;
            }
            if (nativeAction === 'content/extract') {
              const extraction = await extractContent(ctx, {
                sessionKey,
                session,
                domainHint: pickTrimmedString(body.domainHint, nativeArgs.domainHint),
              });
              result = {
                ok: true,
                payload: {
                  bridgeAliasedFrom: 'native:content/extract',
                  nativeAction,
                  extraction,
                  page_state: session.last_page_state || null,
                },
              };
              break;
            }
            result = await runBridgeAction(ctx, {
              sessionKey,
              session,
              action: 'native_action',
              args: {
                action: nativeAction,
                params: nativeArgs,
              },
            });
            break;
          }
          default:
            writeUnsupported(writeJson, res, kind);
            return true;
        }

        if (!result?.ok) {
          writeJson(res, 502, {
            error: result?.error || `Bridge action failed for ${kind}`,
            confirmationStatus: session.last_confirmation_status || null,
          });
          return true;
        }

        writeJson(res, 200, {
          ok: true,
          targetId: session.active_target_id || targetId || null,
          url: result.payload?.page_state?.url || session.last_page_state?.url || '',
          confirmationStatus: session.last_confirmation_status || null,
          nativeAction: kind === 'native' ? body.nativeAction || null : undefined,
          result: verbose ? result.payload || null : buildCompactActionPayload(kind, result.payload || {}),
        });
        return true;
      }

      writeNotFound(writeJson, res);
      return true;
    } catch (error) {
      logOpenClawEvent('request_error', {
        openclaw_session_key: sessionKey,
        device_id: deviceId || null,
        error: error instanceof Error ? error.message : String(error),
        error_class: classifyError(error),
      });
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };
}
