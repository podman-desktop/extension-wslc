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

import type {
  ContainerProviderConnection,
  Disposable,
  ExtensionContext,
  Provider,
  TelemetryLogger,
} from '@podman-desktop/api';
import { provider } from '@podman-desktop/api';
import { Container } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '/@/inject/symbol';
import { WslcBridgeManager } from './wslc-bridge-manager';
import { WslcProviderManager } from './wslc-provider-manager';

vi.mock(import('./wslc-bridge-manager'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = { logError: vi.fn(), logUsage: vi.fn() } as unknown as TelemetryLogger;
const bridgeConfiguration: BridgeConfiguration = {
  executableName: 'wslc-bridge.exe',
  pipeName: String.raw`\\.\pipe\wslc_test_engine`,
  startupTimeoutMs: 500,
  requestTimeoutMs: 200,
  shutdownTimeoutMs: 50,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};
const connectionDisposable = { dispose: vi.fn() } as unknown as Disposable;
const wslcProvider = {
  updateStatus: vi.fn(),
  registerContainerProviderConnection: vi.fn(),
  dispose: vi.fn(),
} as unknown as Provider;
const bridgeManager = new WslcBridgeManager(extensionContext, bridgeConfiguration);

let manager: WslcProviderManager;
let bridgeReady: boolean;
let unexpectedExit: ((error: Error) => void) | undefined;

async function startProviderAndWaitForConnection(): Promise<ContainerProviderConnection | undefined> {
  await manager.registerContainerProvider();
  await vi.waitFor(() => expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce());
  return vi.mocked(wslcProvider.registerContainerProviderConnection).mock.calls[0]?.[0];
}

function deferPing(): () => void {
  let resolvePing: () => void = () => {};
  vi.mocked(bridgeManager.ping).mockReturnValueOnce(
    new Promise<void>(resolve => {
      resolvePing = resolve;
    }),
  );
  return () => resolvePing();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'trace').mockImplementation(() => {});
  extensionContext.subscriptions.length = 0;

  bridgeReady = false;
  unexpectedExit = undefined;
  vi.mocked(bridgeManager.isReady).mockImplementation(() => bridgeReady);
  vi.mocked(bridgeManager.start).mockImplementation((_signal, onUnexpectedExit) => {
    unexpectedExit = onUnexpectedExit;
    bridgeReady = true;
    return Promise.resolve();
  });
  vi.mocked(bridgeManager.ping).mockResolvedValue();
  vi.mocked(bridgeManager.stop).mockImplementation(() => {
    bridgeReady = false;
    return Promise.resolve();
  });
  vi.mocked(wslcProvider.registerContainerProviderConnection).mockReturnValue(connectionDisposable);
  vi.mocked(provider.createProvider).mockReturnValue(wslcProvider);

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
  container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
  container.bind(BridgeConfiguration).toConstantValue(bridgeConfiguration);
  container.bind(WslcBridgeManager).toConstantValue(bridgeManager);
  container.bind(WslcProviderManager).toSelf();
  manager = container.get(WslcProviderManager);
});

describe('WslcProviderManager', () => {
  test('creates the provider with the expected icon metadata', async () => {
    await startProviderAndWaitForConnection();

    expect(provider.createProvider).toHaveBeenCalledWith({
      name: 'WSL Containers',
      id: 'wslc',
      status: 'installed',
      images: { icon: './icon.png', logo: './icon.png' },
    });
  });

  test('registers a started Docker connection on the Windows named pipe once the bridge is ready', async () => {
    const connection = await startProviderAndWaitForConnection();

    expect(connection?.name).toBe('WSL Containers');
    expect(connection?.type).toBe('docker');
    expect(connection?.endpoint).toEqual({ socketPath: bridgeConfiguration.pipeName });
    expect(connection?.status()).toBe('started');
    expect(bridgeManager.start).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function));
    expect(bridgeManager.ping).toHaveBeenCalledOnce();
    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('ready');
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('bridgeStarted');
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('connectionRegistered');
  });

  test('waits for bridge health ping before registering its connection', async () => {
    const resolvePing = deferPing();

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(bridgeManager.ping).toHaveBeenCalledOnce());
    expect(wslcProvider.registerContainerProviderConnection).not.toHaveBeenCalled();

    resolvePing();
    await vi.waitFor(() => expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce());
  });

  test('does not register a connection when the bridge does not become ready', async () => {
    vi.mocked(bridgeManager.start).mockResolvedValue();

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error'));

    expect(bridgeManager.ping).not.toHaveBeenCalled();
    expect(wslcProvider.registerContainerProviderConnection).not.toHaveBeenCalled();
    expect(telemetryLogger.logError).toHaveBeenCalledWith('bridgeStartupFailed', {
      error: new Error('WSL Containers bridge exited before becoming ready'),
    });
  });

  test('refreshes bridge health without registering a duplicate connection', async () => {
    await startProviderAndWaitForConnection();

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(bridgeManager.ping).toHaveBeenCalledTimes(2);
    expect(bridgeManager.start).toHaveBeenCalledOnce();
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce();
  });

  test('restarts the bridge when the health check fails', async () => {
    await startProviderAndWaitForConnection();
    vi.mocked(bridgeManager.ping).mockRejectedValueOnce(new Error('ping failed'));

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(bridgeManager.stop).toHaveBeenCalledOnce();
    expect(bridgeManager.start).toHaveBeenCalledTimes(2);
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledTimes(2);
  });

  test('cleans up the registered connection after an unexpected bridge exit', async () => {
    await startProviderAndWaitForConnection();

    unexpectedExit?.(new Error('bridge exited'));
    await vi.waitFor(() => expect(telemetryLogger.logUsage).toHaveBeenCalledWith('bridgeExited'));

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(bridgeManager.stop).toHaveBeenCalled();
    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('installed');
    expect(extensionContext.subscriptions).not.toContain(connectionDisposable);
  });

  test('logs a bridge stop failure after an unexpected bridge exit', async () => {
    await startProviderAndWaitForConnection();
    const stopError = new Error('bridge did not exit');
    vi.mocked(bridgeManager.stop).mockRejectedValueOnce(stopError);

    unexpectedExit?.(new Error('bridge exited'));

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        'WSL Containers bridge cleanup failed after an unexpected exit',
        stopError,
      ),
    );
    expect(telemetryLogger.logUsage).not.toHaveBeenCalledWith('bridgeExited');
  });

  test('does not overlap concurrent refreshes', async () => {
    await startProviderAndWaitForConnection();
    const resolvePing = deferPing();

    const firstRefresh = manager.refresh();
    const overlappingRefresh = manager.refresh();
    resolvePing();
    await Promise.all([firstRefresh, overlappingRefresh]);

    expect(bridgeManager.ping).toHaveBeenCalledTimes(2);
  });

  test('polls again after the refresh interval', async () => {
    await startProviderAndWaitForConnection();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);

    await vi.waitFor(() => expect(bridgeManager.ping).toHaveBeenCalledTimes(2));
  });

  test('bounds consecutive bridge startup retries', async () => {
    vi.mocked(bridgeManager.start).mockRejectedValue(new Error('bridge startup failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(bridgeManager.start).toHaveBeenCalledTimes(1));
    for (let attempt = 2; attempt <= bridgeConfiguration.maxConsecutiveStartupFailures; attempt += 1) {
      await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);
      await vi.waitFor(() => expect(bridgeManager.start).toHaveBeenCalledTimes(attempt));
    }
    await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);

    expect(bridgeManager.start).toHaveBeenCalledTimes(bridgeConfiguration.maxConsecutiveStartupFailures);
    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error');
  });

  test('stops the bridge and disposes the connection on deactivation', async () => {
    await startProviderAndWaitForConnection();

    await manager.deactivate();

    expect(connectionDisposable.dispose).toHaveBeenCalledOnce();
    expect(bridgeManager.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
