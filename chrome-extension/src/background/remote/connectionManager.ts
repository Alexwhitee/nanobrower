import { remoteSettingsStore, type RemoteSettingsConfig } from '@extension/storage';
import type {
  RemoteClientMessage,
  RemoteCommandEnvelope,
  RemoteCommandResult,
  RemoteConfirmationRequest,
  RemoteConfirmationResponse,
  RemoteHelloMessage,
  RemotePageState,
  RemoteServerMessage,
  RemoteStatusSnapshot,
} from '@extension/shared';
import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import { RemoteCommandExecutor } from './commandExecutor';

const logger = createLogger('RemoteConnectionManager');
const HEARTBEAT_INTERVAL_MS = 20000;
const RECONNECT_DELAY_MS = 3000;
const CONFIRMATION_TIMEOUT_MS = 60000;

interface RemoteConnectionManagerOptions {
  browserContext: BrowserContext;
  notifyUI: (message: Record<string, unknown>) => void;
}

export class RemoteConnectionManager {
  private readonly browserContext: BrowserContext;
  private readonly notifyUI: RemoteConnectionManagerOptions['notifyUI'];
  private readonly executor: RemoteCommandExecutor;
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private settings: RemoteSettingsConfig | null = null;
  private readonly pendingConfirmations = new Map<
    string,
    {
      resolve: (decision: RemoteConfirmationResponse['decision']) => void;
      timeoutId: number;
    }
  >();
  private status: RemoteStatusSnapshot = {
    mode: 'remote',
    status: 'disconnected',
    device_id: '',
    session_id: null,
    bridge_url: '',
    last_error: null,
    last_command: null,
    last_result: null,
  };

  constructor(options: RemoteConnectionManagerOptions) {
    this.browserContext = options.browserContext;
    this.notifyUI = options.notifyUI;
    this.executor = new RemoteCommandExecutor(this.browserContext, {
      requestConfirmation: this.requestConfirmation.bind(this),
    });

    remoteSettingsStore.subscribe(() => {
      void this.refreshFromSettings();
    });
  }

  async initialize(): Promise<void> {
    await this.refreshFromSettings();
  }

  getStatus(): RemoteStatusSnapshot {
    return this.status;
  }

  async refreshFromSettings(): Promise<void> {
    this.settings = await remoteSettingsStore.getSettings();
    this.status = {
      ...this.status,
      mode: this.settings.executionMode,
      device_id: this.settings.deviceId,
      bridge_url: this.settings.bridgeUrl,
    };
    this.emitStatus();

    if (this.settings.executionMode !== 'remote' || !this.settings.autoConnect || !this.settings.bridgeUrl) {
      this.stop('disabled');
      return;
    }

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      this.connect();
    }
  }

  async connectNow(): Promise<void> {
    if (!this.settings) {
      this.settings = await remoteSettingsStore.getSettings();
    }
    this.connect(true);
  }

  disconnect(): void {
    this.stop('disconnected');
  }

  resolveConfirmation(response: RemoteConfirmationResponse): void {
    const pending = this.pendingConfirmations.get(response.confirmation_id);
    if (!pending) {
      return;
    }

    try {
      this.send({
        type: 'user_confirmation_result',
        device_id: this.status.device_id,
        response,
      });
    } catch (error) {
      logger.warning('Failed to forward confirmation result to bridge', error);
    }

    clearTimeout(pending.timeoutId);
    this.pendingConfirmations.delete(response.confirmation_id);
    pending.resolve(response.decision);
  }

  private emitStatus(extra: Record<string, unknown> = {}): void {
    this.notifyUI({
      type: 'remote_status',
      data: {
        ...this.status,
        ...extra,
      },
    });
  }

  private connect(force = false): void {
    if (!this.settings) {
      return;
    }
    if (!force && this.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.socket.readyState)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.status = {
      ...this.status,
      status: 'connecting',
      last_error: null,
    };
    this.emitStatus();

    try {
      this.socket = new WebSocket(this.settings.bridgeUrl);
      this.socket.onopen = () => {
        this.status = {
          ...this.status,
          status: 'connected',
          last_error: null,
        };
        this.emitStatus();
        this.sendHello();
        this.startHeartbeat();
      };

      this.socket.onmessage = event => {
        const payload = typeof event.data === 'string' ? event.data : String(event.data);
        void this.handleMessage(payload);
      };

      this.socket.onerror = () => {
        this.status = {
          ...this.status,
          status: 'error',
          last_error: 'WebSocket connection error',
        };
        this.emitStatus();
      };

      this.socket.onclose = () => {
        this.stopHeartbeat();
        this.socket = null;

        if (this.settings?.executionMode === 'remote' && this.settings.autoConnect) {
          this.status = {
            ...this.status,
            status: 'disconnected',
          };
          this.emitStatus();
          this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS) as unknown as number;
        }
      };
    } catch (error) {
      this.status = {
        ...this.status,
        status: 'error',
        last_error: error instanceof Error ? error.message : String(error),
      };
      this.emitStatus();
    }
  }

  private stop(nextStatus: RemoteStatusSnapshot['status']): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
    this.status = {
      ...this.status,
      status: nextStatus,
      session_id: null,
    };
    this.emitStatus();
  }

  private send(message: RemoteClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Remote bridge socket is not connected');
    }

    this.socket.send(JSON.stringify(message));
  }

  private sendHello(): void {
    if (!this.settings) {
      return;
    }
    const hello: RemoteHelloMessage = {
      type: 'hello',
      device_id: this.settings.deviceId,
      access_token: this.settings.accessToken || undefined,
      metadata: {
        version: chrome.runtime.getManifest().version,
        browser: navigator.userAgent,
      },
    };
    this.send(hello);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.settings) {
        return;
      }
      try {
        this.send({
          type: 'heartbeat',
          device_id: this.settings.deviceId,
          session_id: this.status.session_id,
        });
      } catch (error) {
        logger.error('Failed to send heartbeat', error);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as RemoteServerMessage;
    switch (message.type) {
      case 'bind_ok':
        this.status = {
          ...this.status,
          device_id: message.device_id,
          status: 'connected',
        };
        this.emitStatus();
        break;
      case 'run_command':
        await this.handleCommand(message.command);
        break;
      case 'request_confirmation':
        this.notifyUI({
          type: 'remote_confirmation_request',
          data: message.confirmation,
        });
        break;
      case 'stop_session':
        this.status = {
          ...this.status,
          session_id: null,
        };
        this.emitStatus();
        break;
      default:
        logger.warning('Unknown remote server message', message);
    }
  }

  private async handleCommand(command: RemoteCommandEnvelope): Promise<void> {
    this.status = {
      ...this.status,
      session_id: command.session_id,
      last_command: command,
    };
    this.emitStatus();
    this.notifyUI({
      type: 'remote_command_event',
      data: command,
    });

    const result = await this.executor.execute(command);
    this.status = {
      ...this.status,
      last_result: result,
      last_error: result.ok ? null : result.error || 'Remote command failed',
    };
    this.emitStatus();

    try {
      this.send({
        type: 'command_result',
        device_id: this.status.device_id,
        result,
      });

      const pageState = result.payload?.page_state as RemotePageState | undefined;
      if (pageState) {
        this.send({
          type: 'page_state_event',
          device_id: this.status.device_id,
          session_id: command.session_id,
          page_state: pageState,
        });
      }
    } catch (error) {
      logger.error('Failed to forward remote command result to bridge', error);
    }

    this.notifyUI({
      type: 'remote_command_result',
      data: result,
    });
  }

  private requestConfirmation(request: RemoteConfirmationRequest): Promise<RemoteConfirmationResponse['decision']> {
    this.notifyUI({
      type: 'remote_confirmation_request',
      data: request,
    });

    return new Promise(resolve => {
      const timeoutId = setTimeout(() => {
        this.pendingConfirmations.delete(request.confirmation_id);
        resolve('reject');
      }, CONFIRMATION_TIMEOUT_MS) as unknown as number;

      this.pendingConfirmations.set(request.confirmation_id, {
        resolve,
        timeoutId,
      });
    });
  }
}
