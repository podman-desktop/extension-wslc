/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type { Disposable, ExtensionContext, Provider, TelemetryLogger } from '@podman-desktop/api';
import { provider } from '@podman-desktop/api';
import { Container } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '/@/inject/symbol';
import { WslcProviderManager } from './wslc-provider-manager';

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = { logError: vi.fn(), logUsage: vi.fn() } as unknown as TelemetryLogger;
const bridgeConfiguration: BridgeConfiguration = {
  pipeName: String.raw`\\.\pipe\wslc_test_engine`,
};
const connectionDisposable = { dispose: vi.fn() } as unknown as Disposable;
const wslcProvider = {
  updateStatus: vi.fn(),
  registerContainerProviderConnection: vi.fn(),
  dispose: vi.fn(),
} as unknown as Provider;

let manager: WslcProviderManager;

beforeEach(() => {
  vi.resetAllMocks();
  extensionContext.subscriptions.length = 0;
  vi.mocked(wslcProvider.registerContainerProviderConnection).mockReturnValue(connectionDisposable);
  vi.mocked(provider.createProvider).mockReturnValue(wslcProvider);

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
  container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
  container.bind(BridgeConfiguration).toConstantValue(bridgeConfiguration);
  container.bind(WslcProviderManager).toSelf();
  manager = container.get(WslcProviderManager);
});

describe('WslcProviderManager', () => {
  test('creates the provider with the expected icon metadata', async () => {
    await manager.registerContainerProvider();

    expect(provider.createProvider).toHaveBeenCalledWith({
      name: 'WSL Containers',
      id: 'wslc',
      status: 'installed',
      images: { icon: './icon.png', logo: './icon.png' },
    });
    expect(extensionContext.subscriptions).toContain(wslcProvider);
  });

  test('registers a stopped Docker connection on the Windows named pipe', async () => {
    await manager.registerContainerProvider();

    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce();
    const connection = vi.mocked(wslcProvider.registerContainerProviderConnection).mock.calls[0]?.[0];
    expect(connection?.name).toBe('WSL Containers');
    expect(connection?.type).toBe('docker');
    expect(connection?.endpoint).toEqual({ socketPath: bridgeConfiguration.pipeName });
    expect(connection?.status()).toBe('stopped');
    expect(extensionContext.subscriptions).toContain(connectionDisposable);
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('connectionRegistered');
  });

  test('registers the provider and its connection only once', async () => {
    await manager.registerContainerProvider();
    await manager.registerContainerProvider();

    expect(provider.createProvider).toHaveBeenCalledOnce();
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce();
  });

  test('disposes the connection on deactivation', async () => {
    await manager.registerContainerProvider();

    await manager.deactivate();

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(extensionContext.subscriptions).not.toContain(connectionDisposable);
  });

  test('registers the provider again after deactivation', async () => {
    await manager.registerContainerProvider();
    await manager.deactivate();

    await manager.registerContainerProvider();

    expect(provider.createProvider).toHaveBeenCalledTimes(2);
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledTimes(2);
  });
});
