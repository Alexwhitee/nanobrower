import type { RemoteStatusSnapshot } from '@extension/shared';
import type { RemoteSettingsConfig } from '@extension/storage';

interface RemoteControlPanelProps {
  settings: RemoteSettingsConfig;
  status: RemoteStatusSnapshot | null;
  isDarkMode?: boolean;
  onUpdateSetting: <K extends keyof RemoteSettingsConfig>(key: K, value: RemoteSettingsConfig[K]) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

const statusLabelMap: Record<string, string> = {
  disabled: 'Disabled',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
  device_offline: 'Device offline',
};

export default function RemoteControlPanel({
  settings,
  status,
  isDarkMode = false,
  onUpdateSetting,
  onConnect,
  onDisconnect,
}: RemoteControlPanelProps) {
  const connected = status?.status === 'connected';

  return (
    <div
      className={`mx-2 mt-2 rounded-xl border p-3 shadow-sm ${isDarkMode ? 'border-slate-700 bg-slate-800/95 text-slate-100' : 'border-sky-100 bg-white/90 text-slate-800'}`}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Remote Executor Mode</div>
          <div className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            OpenClaw / Bridge controls this browser locally.
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => onUpdateSetting('executionMode', 'remote')}
            className={`rounded-md px-2 py-1 ${settings.executionMode === 'remote' ? 'bg-sky-600 text-white' : isDarkMode ? 'bg-slate-700' : 'bg-slate-100'}`}>
            Remote
          </button>
          <button
            type="button"
            onClick={() => onUpdateSetting('executionMode', 'local')}
            className={`rounded-md px-2 py-1 ${settings.executionMode === 'local' ? 'bg-sky-600 text-white' : isDarkMode ? 'bg-slate-700' : 'bg-slate-100'}`}>
            Local
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <label className="block text-xs">
          <span className={`mb-1 block ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>Bridge WebSocket URL</span>
          <input
            value={settings.bridgeUrl}
            onChange={e => onUpdateSetting('bridgeUrl', e.target.value)}
            className={`w-full rounded-md border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
          />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className={`mb-1 block ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>Device ID</span>
            <input
              value={settings.deviceId}
              onChange={e => onUpdateSetting('deviceId', e.target.value)}
              className={`w-full rounded-md border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
            />
          </label>

          <label className="block text-xs">
            <span className={`mb-1 block ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>Access Token</span>
            <input
              type="password"
              value={settings.accessToken}
              onChange={e => onUpdateSetting('accessToken', e.target.value)}
              className={`w-full rounded-md border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'}`}
              placeholder="Optional"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.autoConnect}
            onChange={e => onUpdateSetting('autoConnect', e.target.checked)}
          />
          <span className={isDarkMode ? 'text-slate-300' : 'text-slate-600'}>Auto connect on startup</span>
        </label>

        <div
          className={`rounded-lg border px-3 py-2 text-xs ${isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
          <div className="flex items-center justify-between">
            <span>Status</span>
            <span className={`rounded-full px-2 py-0.5 ${connected ? 'bg-emerald-600 text-white' : isDarkMode ? 'bg-slate-700 text-slate-200' : 'bg-slate-200 text-slate-700'}`}>
              {statusLabelMap[status?.status || 'disconnected']}
            </span>
          </div>
          <div className="mt-2">Session: {status?.session_id || '-'}</div>
          <div className="mt-1 break-all">Last error: {status?.last_error || '-'}</div>
          <div className="mt-1 break-all">Last command: {status?.last_command?.action || '-'}</div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onConnect}
            disabled={settings.executionMode !== 'remote'}
            className={`rounded-md px-3 py-2 text-sm font-medium ${settings.executionMode !== 'remote' ? 'cursor-not-allowed opacity-50' : ''} ${isDarkMode ? 'bg-sky-600 text-white hover:bg-sky-500' : 'bg-sky-500 text-white hover:bg-sky-600'}`}>
            Connect
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            className={`rounded-md px-3 py-2 text-sm font-medium ${isDarkMode ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-slate-200 text-slate-800 hover:bg-slate-300'}`}>
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
