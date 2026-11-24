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
  Logger,
  Provider,
  RunError,
  RunResult,
  TelemetryLogger,
} from '@podman-desktop/api';
import { process as podmanProcess, provider } from '@podman-desktop/api';
import { Container } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '/@/inject/symbol';
import { WslVersionService } from './wsl-version-service';
import { WslcBridgeManager } from './wslc-bridge-manager';
import { WslcProviderManager } from './wslc-provider-manager';

vi.mock(import('./wslc-bridge-manager'));

const extensionContext = { subscriptions: [] } as unknown as ExtensionContext;
const telemetryLogger = { logError: vi.fn(), logUsage: vi.fn() } as unknown as TelemetryLogger;
const logger = { log: vi.fn() } as unknown as Logger;
const bridgeConfiguration: BridgeConfiguration = {
  executableName: 'wslc-bridge.exe',
  pipeName: String.raw`\\.\pipe\wslc_test_engine`,
  startupTimeoutMs: 500,
  requestTimeoutMs: 200,
  shutdownTimeoutMs: 50,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};
const installationDisposable = { dispose: vi.fn() } as unknown as Disposable;
const updateDisposable = { dispose: vi.fn() } as unknown as Disposable;
const connectionDisposable = { dispose: vi.fn() } as unknown as Disposable;
const wslcProvider = {
  updateStatus: vi.fn(),
  updateVersion: vi.fn(),
  registerInstallation: vi.fn(),
  registerUpdate: vi.fn(),
  registerContainerProviderConnection: vi.fn(),
  dispose: vi.fn(),
} as unknown as Provider;
const bridgeManager = new WslcBridgeManager(extensionContext, bridgeConfiguration);
const wslcVersionResult: RunResult = { command: 'wslc.exe version', stdout: 'wslc 0.1.0', stderr: '' };
const oldWslVersionResult: RunResult = { command: 'wsl --version', stdout: 'WSL version: 2.9.2.0', stderr: '' };

let manager: WslcProviderManager;
let bridgeReady: boolean;
let unexpectedExit: ((error: Error) => void) | undefined;

function createRunError(message: string): RunError {
  return Object.assign(new Error(message), {
    exitCode: 1,
    command: 'wslc.exe version',
    stdout: '',
    stderr: message,
    cancelled: false,
    killed: false,
  });
}

async function waitForExecCalls(count: number): Promise<void> {
  await vi.waitFor(() => expect(podmanProcess.exec).toHaveBeenCalledTimes(count));
}

async function startProviderAndWaitForConnection(): Promise<ContainerProviderConnection | undefined> {
  await manager.registerContainerProvider();
  await waitForExecCalls(3);
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
  vi.mocked(wslcProvider.registerInstallation).mockReturnValue(installationDisposable);
  vi.mocked(wslcProvider.registerUpdate).mockReturnValue(updateDisposable);
  vi.mocked(wslcProvider.registerContainerProviderConnection).mockReturnValue(connectionDisposable);
  vi.mocked(provider.createProvider).mockReturnValue(wslcProvider);
  vi.mocked(podmanProcess.exec).mockImplementation((command, args) => {
    if (command === 'wsl' && args?.[0] === '--version') {
      return Promise.resolve({ command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' });
    }
    return Promise.resolve(wslcVersionResult);
  });

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue(extensionContext);
  container.bind(TelemetryLoggerSymbol).toConstantValue(telemetryLogger);
  container.bind(BridgeConfiguration).toConstantValue(bridgeConfiguration);
  container.bind(WslcBridgeManager).toConstantValue(bridgeManager);
  container.bind(WslVersionService).toSelf();
  container.bind(WslcProviderManager).toSelf();
  manager = container.get(WslcProviderManager);
});

describe('WslcProviderManager', () => {
  test('creates the provider with the expected icon metadata', async () => {
    await startProviderAndWaitForConnection();

    expect(provider.createProvider).toHaveBeenCalledWith({
      name: 'WSL Containers',
      id: 'wslc',
      status: 'unknown',
      images: { icon: './icon.png', logo: './icon.png' },
    });
  });

  test('probes WSLC, the WSL version, and runtime containers during startup', async () => {
    await startProviderAndWaitForConnection();

    expect(podmanProcess.exec).toHaveBeenNthCalledWith(1, 'wslc.exe', ['version']);
    expect(podmanProcess.exec).toHaveBeenNthCalledWith(2, 'wsl', ['--version'], { encoding: 'utf16le' });
    expect(podmanProcess.exec).toHaveBeenNthCalledWith(3, 'wslc.exe', ['container', 'list']);
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('runtimeDetected', { version: 'wslc 0.1.0' });
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
  });

  test('waits for bridge health ping before registering its connection', async () => {
    const resolvePing = deferPing();

    await manager.registerContainerProvider();
    await waitForExecCalls(3);
    await vi.waitFor(() => expect(bridgeManager.ping).toHaveBeenCalledOnce());
    expect(wslcProvider.registerContainerProviderConnection).not.toHaveBeenCalled();

    resolvePing();
    await vi.waitFor(() => expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce());
  });

  test('does not register a connection when the bridge does not become ready', async () => {
    vi.mocked(bridgeManager.start).mockResolvedValue();

    await manager.registerContainerProvider();
    await waitForExecCalls(3);
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error'));

    expect(bridgeManager.ping).not.toHaveBeenCalled();
    expect(wslcProvider.registerContainerProviderConnection).not.toHaveBeenCalled();
  });

  test('marks WSLC not installed only when the executable is missing', async () => {
    vi.mocked(podmanProcess.exec).mockRejectedValueOnce(createRunError('spawn wslc.exe ENOENT'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.registerInstallation).toHaveBeenCalledOnce());

    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('not-installed');
    expect(wslcProvider.updateVersion).toHaveBeenCalledOnce();
    expect(podmanProcess.exec).toHaveBeenCalledOnce();
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('runs wsl --update from the installation action and refreshes provider status', async () => {
    vi.mocked(podmanProcess.exec).mockRejectedValueOnce(createRunError('wslc.exe was not found'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.registerInstallation).toHaveBeenCalledOnce());
    const installation = vi.mocked(wslcProvider.registerInstallation).mock.calls[0]?.[0];
    const installPromise = installation?.install(logger);
    await waitForExecCalls(5);
    await installPromise;

    expect(podmanProcess.exec).toHaveBeenCalledWith('wsl', ['--update'], { encoding: 'utf16le' });
    expect(installationDisposable.dispose).toHaveBeenCalledOnce();
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce();
  });

  test('sets provider error for an arbitrary WSLC command failure without registering installation', async () => {
    vi.mocked(podmanProcess.exec).mockRejectedValueOnce(
      createRunError('wslc.exe version exited with code 1: access denied'),
    );

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error'));

    expect(wslcProvider.registerInstallation).not.toHaveBeenCalled();
    expect(wslcProvider.updateStatus).not.toHaveBeenCalledWith('not-installed');
    expect(bridgeManager.stop).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Error checking WSL Containers version', expect.any(Error));
  });

  test('sets provider error for empty or malformed successful version output', async () => {
    vi.mocked(podmanProcess.exec).mockResolvedValueOnce({
      command: 'wslc.exe version',
      stdout: 'not a version',
      stderr: '',
    });

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error'));

    expect(wslcProvider.registerInstallation).not.toHaveBeenCalled();
    expect(wslcProvider.updateStatus).not.toHaveBeenCalledWith('not-installed');
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('leaves Install registered when the WSL update command fails', async () => {
    vi.mocked(podmanProcess.exec)
      .mockRejectedValueOnce(createRunError('wslc not found'))
      .mockRejectedValueOnce(new Error('update failed'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.registerInstallation).toHaveBeenCalledOnce());
    const installation = vi.mocked(wslcProvider.registerInstallation).mock.calls[0]?.[0];

    await expect(installation?.install(logger)).rejects.toThrow('update failed');

    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('not-installed');
    expect(wslcProvider.registerInstallation).toHaveBeenCalledOnce();
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('keeps WSLC installed and registers an update for an older WSL version', async () => {
    vi.mocked(podmanProcess.exec).mockResolvedValueOnce(wslcVersionResult).mockResolvedValueOnce(oldWslVersionResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.registerUpdate).toHaveBeenCalledOnce());

    expect(vi.mocked(wslcProvider.registerUpdate).mock.calls[0]?.[0].version).toBe('2.9.3');
    expect(wslcProvider.updateStatus).toHaveBeenCalledWith('installed');
    expect(wslcProvider.registerInstallation).not.toHaveBeenCalled();
    expect(podmanProcess.exec).toHaveBeenCalledTimes(2);
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('runs wsl --update from the update action and refreshes provider status', async () => {
    vi.mocked(podmanProcess.exec).mockResolvedValueOnce(wslcVersionResult).mockResolvedValueOnce(oldWslVersionResult);

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.registerUpdate).toHaveBeenCalledOnce());
    const update = vi.mocked(wslcProvider.registerUpdate).mock.calls[0]?.[0];
    const updatePromise = update?.update(logger);
    await waitForExecCalls(6);
    await updatePromise;

    expect(podmanProcess.exec).toHaveBeenCalledWith('wsl', ['--update'], { encoding: 'utf16le' });
    expect(podmanProcess.exec).toHaveBeenCalledWith('wslc.exe', ['container', 'list']);
    expect(wslcProvider.registerContainerProviderConnection).toHaveBeenCalledOnce();
  });

  test('does not start a bridge when WSL version output cannot be parsed', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce(wslcVersionResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'unrecognized output', stderr: '' });

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('error'));

    expect(podmanProcess.exec).toHaveBeenCalledTimes(2);
    expect(wslcProvider.registerUpdate).not.toHaveBeenCalled();
    expect(bridgeManager.start).not.toHaveBeenCalled();
  });

  test('marks runtime stopped when the container-list probe fails', async () => {
    vi.mocked(podmanProcess.exec)
      .mockResolvedValueOnce(wslcVersionResult)
      .mockResolvedValueOnce({ command: 'wsl --version', stdout: 'WSL version: 2.9.3.0', stderr: '' })
      .mockRejectedValueOnce(new Error('runtime stopped'));

    await manager.registerContainerProvider();
    await vi.waitFor(() => expect(wslcProvider.updateStatus).toHaveBeenCalledWith('stopped'));

    expect(bridgeManager.start).not.toHaveBeenCalled();
    expect(wslcProvider.registerContainerProviderConnection).not.toHaveBeenCalled();
  });

  test('refreshes bridge health without registering a duplicate connection', async () => {
    await startProviderAndWaitForConnection();

    await manager.updateContainerSystemStatus(wslcProvider);

    expect(bridgeManager.ping).toHaveBeenCalledTimes(2);
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
    let resolveVersion: (result: RunResult) => void = () => {};
    vi.mocked(podmanProcess.exec).mockReturnValueOnce(
      new Promise<RunResult>(resolve => {
        resolveVersion = resolve;
      }),
    );

    const firstRefresh = manager.refresh();
    await waitForExecCalls(4);
    const overlappingRefresh = manager.refresh();
    expect(podmanProcess.exec).toHaveBeenCalledTimes(4);
    resolveVersion(wslcVersionResult);
    await Promise.all([firstRefresh, overlappingRefresh]);

    expect(podmanProcess.exec).toHaveBeenCalledTimes(6);
  });

  test('polls again after the refresh interval', async () => {
    await startProviderAndWaitForConnection();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(bridgeConfiguration.refreshIntervalMs);

    await waitForExecCalls(6);
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
