import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export type RemoteExecutionMode = 'local' | 'remote';

export interface RemoteSettingsConfig {
  executionMode: RemoteExecutionMode;
  bridgeUrl: string;
  deviceId: string;
  accessToken: string;
  autoConnect: boolean;
}

export type RemoteSettingsStorage = BaseStorage<RemoteSettingsConfig> & {
  updateSettings: (settings: Partial<RemoteSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<RemoteSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

function createDeviceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `dev_${uuid}`;
  }

  return `dev_${Math.random().toString(36).slice(2, 10)}`;
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettingsConfig = {
  executionMode: 'remote',
  bridgeUrl: 'ws://127.0.0.1:8787/ws',
  deviceId: '',
  accessToken: '',
  autoConnect: true,
};

const storage = createStorage<RemoteSettingsConfig>('remote-settings', DEFAULT_REMOTE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const remoteSettingsStore: RemoteSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<RemoteSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_REMOTE_SETTINGS;
    await storage.set({
      ...currentSettings,
      ...settings,
    });
  },
  async getSettings() {
    const settings = await storage.get();
    const mergedSettings = {
      ...DEFAULT_REMOTE_SETTINGS,
      ...settings,
    };

    if (!mergedSettings.deviceId) {
      const deviceId = createDeviceId();
      const updatedSettings = { ...mergedSettings, deviceId };
      await storage.set(updatedSettings);
      return updatedSettings;
    }

    return mergedSettings;
  },
  async resetToDefaults() {
    await storage.set({
      ...DEFAULT_REMOTE_SETTINGS,
      deviceId: createDeviceId(),
    });
  },
};
