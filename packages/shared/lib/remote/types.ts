export type RemoteExecutionMode = 'local' | 'remote';

export type RemoteCommandAction =
  | 'get_page_state'
  | 'click'
  | 'type'
  | 'select_option'
  | 'navigate'
  | 'scroll'
  | 'wait_for'
  | 'extract_text'
  | 'screenshot'
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
  tag_name?: string;
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
  last_action_result: RemoteActionResultSummary | null;
  screenshot_ref: string | null;
}

export interface RemoteCommandEnvelope {
  command_id: string;
  session_id: string;
  action: RemoteCommandAction;
  args?: Record<string, unknown>;
}

export interface RemoteCommandResult {
  command_id: string;
  session_id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
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

export type RemoteServerMessage = RemoteBindOkMessage | RemoteRunCommandMessage | RemoteRequestConfirmationMessage | RemoteStopSessionMessage;
