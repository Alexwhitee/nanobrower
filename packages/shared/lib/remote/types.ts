export type RemoteExecutionMode = 'local' | 'remote';

export type RemoteCommandAction =
  | 'get_page_state'
  | 'get_tabs'
  | 'open_tab'
  | 'focus_tab'
  | 'close_tab'
  | 'click'
  | 'hover'
  | 'drag'
  | 'type'
  | 'press_key'
  | 'select_option'
  | 'navigate'
  | 'go_back'
  | 'go_forward'
  | 'scroll'
  | 'wait_for'
  | 'extract_text'
  | 'evaluate_script'
  | 'console_messages'
  | 'save_pdf'
  | 'arm_file_chooser'
  | 'arm_dialog'
  | 'resize_window'
  | 'screenshot'
  | 'native_action'
  | 'stop_session';

export type RemoteConnectionStatus =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'device_offline';

export interface RemoteViewport {
  width: number;
  height: number;
}

export interface RemotePageElement {
  id: string;
  role: string;
  text: string;
  label: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  value?: string;
  url?: string;
  tag_name?: string;
}

export interface RemoteTabSummary {
  tab_id: number;
  target_id?: string;
  url: string;
  title: string;
  active: boolean;
}

export interface RemoteConsoleMessage {
  type: string;
  text: string;
  location?: string;
  timestamp?: number;
}

export interface RemoteDialogPolicy {
  accept: boolean;
  prompt_text?: string;
}

export interface RemoteFileChooserPolicy {
  paths: string[];
  ref?: string;
  input_ref?: string;
  element?: string;
}

export interface RemoteEvaluateResult {
  value?: unknown;
  json?: string;
}

export interface RemotePdfResult {
  pdf: string;
  file_name?: string;
}

export type RemoteNativeActionName =
  | 'history.go_back'
  | 'history.go_forward'
  | 'scroll.to_text'
  | 'scroll.previous_page'
  | 'scroll.next_page'
  | 'scroll.to_top'
  | 'scroll.to_bottom'
  | 'dropdown.get_options'
  | 'extract.visible_text'
  | 'extract.readability';

export interface RemoteNativeActionArgsMap {
  'history.go_back': Record<string, never>;
  'history.go_forward': Record<string, never>;
  'scroll.to_text': { text: string; nth?: number; element_id?: string };
  'scroll.previous_page': { element_id?: string };
  'scroll.next_page': { element_id?: string };
  'scroll.to_top': { element_id?: string };
  'scroll.to_bottom': { element_id?: string };
  'dropdown.get_options': { element_id: string };
  'extract.visible_text': { element_id?: string };
  'extract.readability': Record<string, never>;
}

export interface RemoteNativeActionResultMap {
  'history.go_back': { message: string };
  'history.go_forward': { message: string };
  'scroll.to_text': { matched: boolean; message: string };
  'scroll.previous_page': { message: string };
  'scroll.next_page': { message: string };
  'scroll.to_top': { message: string };
  'scroll.to_bottom': { message: string };
  'dropdown.get_options': {
    options: Array<{ index: number; text: string; value: string }>;
  };
  'extract.visible_text': { text: string };
  'extract.readability': {
    title: string;
    content: string;
    textContent: string;
    excerpt: string;
    siteName: string;
    byline: string;
  };
}

export interface RemoteActionResultSummary {
  action: RemoteCommandAction | 'confirmation';
  ok: boolean;
  message: string;
}

export interface RemotePageState {
  session_id: string;
  tab_id: number;
  url: string;
  title: string;
  viewport: RemoteViewport;
  page_text_summary: string;
  elements: RemotePageElement[];
  tabs?: RemoteTabSummary[];
  last_action_result: RemoteActionResultSummary | null;
  screenshot_ref: string | null;
}

export interface RemoteCommandArgsMap {
  get_page_state: Record<string, never>;
  get_tabs: Record<string, never>;
  open_tab: { url: string };
  focus_tab: { tab_id: number };
  close_tab: { tab_id: number };
  click: { element_id: string };
  hover: { element_id: string };
  drag: { start_element_id: string; end_element_id: string };
  type: { element_id: string; text: string };
  press_key: { key: string; element_id?: string };
  select_option: { element_id: string; text: string };
  navigate: { url: string; tab_id?: number };
  go_back: Record<string, never>;
  go_forward: Record<string, never>;
  scroll: {
    y_percent?: number;
    element_id?: string;
    direction?: 'top' | 'bottom' | 'previous_page' | 'next_page';
    text?: string;
    nth?: number;
  };
  wait_for: {
    text?: string;
    selector?: string;
    url?: string;
    load_state?: 'domcontentloaded' | 'load' | 'networkidle';
    fn?: string;
    time_ms?: number;
    timeout_ms?: number;
    poll_interval_ms?: number;
  };
  extract_text: { element_id?: string; mode?: 'summary' | 'readability' | 'markdown'; selector?: string };
  evaluate_script: { fn: string };
  console_messages: { level?: string; limit?: number };
  save_pdf: Record<string, never>;
  arm_file_chooser: RemoteFileChooserPolicy;
  arm_dialog: RemoteDialogPolicy;
  resize_window: { width: number; height: number };
  screenshot: { full_page?: boolean; element_id?: string };
  native_action: {
    action: RemoteNativeActionName;
    params?: Partial<Record<string, unknown>>;
  };
  stop_session: Record<string, never>;
}

export interface RemoteCommandPayloadMap {
  get_page_state: { page_state: RemotePageState };
  get_tabs: { tabs: RemoteTabSummary[]; active_tab_id: number | null; page_state?: RemotePageState };
  open_tab: { tab: RemoteTabSummary; tabs: RemoteTabSummary[]; page_state: RemotePageState };
  focus_tab: { tab: RemoteTabSummary; tabs: RemoteTabSummary[]; page_state: RemotePageState };
  close_tab: { tab_id: number; tabs: RemoteTabSummary[]; page_state?: RemotePageState };
  click: { message: string; url?: string; navigated?: boolean; page_state: RemotePageState };
  hover: { message: string; page_state: RemotePageState };
  drag: { message: string; page_state: RemotePageState };
  type: { message: string; value?: string; page_state: RemotePageState };
  press_key: { message: string; key: string; page_state: RemotePageState };
  select_option: { message: string; page_state: RemotePageState };
  navigate: { url: string; navigated: boolean; page_state: RemotePageState };
  go_back: { message: string; page_state: RemotePageState };
  go_forward: { message: string; page_state: RemotePageState };
  scroll: { message: string; page_state: RemotePageState };
  wait_for: { message: string; page_state: RemotePageState };
  extract_text: { text: string; page_state?: RemotePageState; readability?: Record<string, unknown> };
  evaluate_script: { result: RemoteEvaluateResult; page_state: RemotePageState };
  console_messages: { messages: RemoteConsoleMessage[]; page_state?: RemotePageState };
  save_pdf: RemotePdfResult & { page_state?: RemotePageState };
  arm_file_chooser: { armed: true; policy: RemoteFileChooserPolicy };
  arm_dialog: { armed: true; policy: RemoteDialogPolicy };
  resize_window: { width: number; height: number; page_state: RemotePageState };
  screenshot: { screenshot_ref: string | null; screenshot: string | null; image_type?: 'png' | 'jpeg'; page_state: RemotePageState };
  native_action: {
    native_action: RemoteNativeActionName;
    result: RemoteNativeActionResultMap[RemoteNativeActionName] | Record<string, unknown>;
    page_state?: RemotePageState;
  };
  stop_session: { stopped: true };
}

export interface RemoteCommandEnvelope {
  command_id: string;
  session_id: string;
  action: RemoteCommandAction;
  args?: RemoteCommandArgsMap[RemoteCommandAction];
  metadata?: Record<string, unknown>;
}

export interface RemoteCommandResult {
  command_id: string;
  session_id: string;
  ok: boolean;
  payload?: RemoteCommandPayloadMap[RemoteCommandAction] | Record<string, unknown>;
  error?: string;
}

export interface RemoteConfirmationRequest {
  confirmation_id: string;
  session_id: string;
  command_id: string;
  action: RemoteCommandAction;
  title: string;
  message: string;
  confirm_label: string;
  reject_label: string;
  stop_label: string;
}

export interface RemoteConfirmationResponse {
  confirmation_id: string;
  session_id: string;
  command_id: string;
  decision: 'approve' | 'reject' | 'stop';
}

export interface RemoteStatusSnapshot {
  mode: RemoteExecutionMode;
  status: RemoteConnectionStatus;
  device_id: string;
  session_id: string | null;
  bridge_url: string;
  last_error: string | null;
  last_command: RemoteCommandEnvelope | null;
  last_result: RemoteCommandResult | null;
}

export interface RemoteHelloMessage {
  type: 'hello';
  device_id: string;
  access_token?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteHeartbeatMessage {
  type: 'heartbeat';
  device_id: string;
  session_id?: string | null;
}

export interface RemoteCommandResultMessage {
  type: 'command_result';
  device_id: string;
  result: RemoteCommandResult;
}

export interface RemotePageStateEventMessage {
  type: 'page_state_event';
  device_id: string;
  session_id: string;
  page_state: RemotePageState;
}

export interface RemoteUserConfirmationResultMessage {
  type: 'user_confirmation_result';
  device_id: string;
  response: RemoteConfirmationResponse;
}

export interface RemoteBindOkMessage {
  type: 'bind_ok';
  device_id: string;
}

export interface RemoteRunCommandMessage {
  type: 'run_command';
  command: RemoteCommandEnvelope;
}

export interface RemoteRequestConfirmationMessage {
  type: 'request_confirmation';
  confirmation: RemoteConfirmationRequest;
}

export interface RemoteStopSessionMessage {
  type: 'stop_session';
  session_id: string;
}

export type RemoteClientMessage =
  | RemoteHelloMessage
  | RemoteHeartbeatMessage
  | RemoteCommandResultMessage
  | RemotePageStateEventMessage
  | RemoteUserConfirmationResultMessage;

export type RemoteServerMessage =
  | RemoteBindOkMessage
  | RemoteRunCommandMessage
  | RemoteRequestConfirmationMessage
  | RemoteStopSessionMessage;
