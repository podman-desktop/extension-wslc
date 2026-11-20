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

import assert from 'node:assert/strict';
import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { Container, injectable, injectFromBase } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BridgeConfigurationSymbol, type BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol } from '/@/inject/symbol';
import {
  WslcBridgeManager,
  type BridgeChildProcess,
  type BridgePingOptions,
  type BridgePingRequest,
  type BridgePingResponse,
} from './wslc-bridge-manager';

vi.mock(import('node:child_process'));
vi.mock(import('node:fs/promises'));
vi.mock(import('node:http'));
vi.mock(import('node:os'));

const extensionDirectory = resolve('extension');

const testBridgeConfiguration: BridgeConfiguration = {
  executableName: 'wslc-bridge.exe',
  pipeName: String.raw`\\.\pipe\wslc_test_engine`,
  startupTimeoutMs: 5_000,
  requestTimeoutMs: 1_000,
  shutdownTimeoutMs: 100,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};

class FakePingResponse extends EventEmitter implements BridgePingResponse {
  statusCode?: number = 200;

  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }
}

class FakePingRequest extends EventEmitter implements BridgePingRequest {
  onEnd?: () => void;
  readonly endMock = vi.fn((): void => this.onEnd?.());
  readonly destroyMock = vi.fn((error: Error): void => {
    this.emit('error', error);
  });

  end(): void {
    this.endMock();
  }

  destroy(error: Error): void {
    this.destroyMock(error);
  }
}

class FakeChild extends EventEmitter implements BridgeChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  readonly killMock = vi.fn((): boolean => {
    this.exit(1);
    return true;
  });

  constructor() {
    super();
    this.stdin.once('finish', () => {
      queueMicrotask(() => this.exit(0));
    });
  }

  kill(): boolean {
    return this.killMock();
  }

  exit(code: number): void {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

let child: FakeChild;
let pingRequest: FakePingRequest;
let pingResponse: FakePingResponse;
let manager: TestWslcBridgeManager;
let unexpectedExit: (error: Error) => void;
let debugMock: (...data: unknown[]) => void;
let errorMock: (...data: unknown[]) => void;

@injectable()
@injectFromBase()
class TestWslcBridgeManager extends WslcBridgeManager {
  static readonly readinessLineLimit = WslcBridgeManager.MAX_READINESS_LINE_BYTES;

  readonly spawnRequests: { executablePath: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  readonly pingRequests: BridgePingOptions[] = [];

  resolveExecutable(architecture: string): string {
    return this.resolveBridgeExecutable(architecture);
  }

  protected override spawnBridge(
    executablePath: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ): BridgeChildProcess {
    this.spawnRequests.push({ executablePath, args, options });
    return child;
  }

  protected override createPingRequest(
    options: BridgePingOptions,
    onResponse: (response: BridgePingResponse) => void,
  ): BridgePingRequest {
    this.pingRequests.push(options);
    pingRequest.onEnd = () => onResponse(pingResponse);
    return pingRequest;
  }
}

@injectable()
@injectFromBase()
class NodeWslcBridgeManager extends WslcBridgeManager {
  callSpawnBridge(executablePath: string, args: string[], options: SpawnOptionsWithoutStdio): BridgeChildProcess {
    return this.spawnBridge(executablePath, args, options);
  }

  callCreatePingRequest(
    options: BridgePingOptions,
    onResponse: (response: BridgePingResponse) => void,
  ): BridgePingRequest {
    return this.createPingRequest(options, onResponse);
  }
}

function readinessRecord(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    event: 'ready',
    protocolVersion: 1,
    bridgeVersion: 'test-bridge-version',
    pipe: testBridgeConfiguration.pipeName,
    guestApiVersion: '1.0.0',
    ...overrides,
  })}\r\n`;
}

function completePing(): void {
  pingResponse.emit('data', 'OK');
  pingResponse.emit('end');
}

async function startReadyBridge(): Promise<void> {
  const startPromise = manager.start(new AbortController().signal, unexpectedExit);
  await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
  child.stdout.write(readinessRecord());
  await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
  completePing();
  await startPromise;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.mocked(arch).mockReturnValue('x64');
  vi.mocked(access).mockResolvedValue(undefined);
  debugMock = vi.fn<(...data: unknown[]) => void>();
  console.debug = debugMock;
  errorMock = vi.fn<(...data: unknown[]) => void>();
  console.error = errorMock;

  child = new FakeChild();
  pingRequest = new FakePingRequest();
  pingResponse = new FakePingResponse();
  unexpectedExit = vi.fn<(error: Error) => void>();

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue({ extensionUri: { fsPath: extensionDirectory } });
  container.bind(BridgeConfigurationSymbol).toConstantValue(testBridgeConfiguration);
  container.bind(TestWslcBridgeManager).toSelf();
  manager = container.get(TestWslcBridgeManager);
});

describe('WslcBridgeManager.resolveBridgeExecutable', () => {
  test('resolves x64 to the win32-x64 bridge executable', () => {
    expect(manager.resolveExecutable('x64')).toBe(
      resolve(extensionDirectory, 'dist', 'bin', 'win32-x64', testBridgeConfiguration.executableName),
    );
  });

  test('resolves arm64 to the win32-arm64 bridge executable', () => {
    expect(manager.resolveExecutable('arm64')).toBe(
      resolve(extensionDirectory, 'dist', 'bin', 'win32-arm64', testBridgeConfiguration.executableName),
    );
  });

  test('rejects unsupported architectures', () => {
    expect(() => manager.resolveExecutable('ia32')).toThrow('Unsupported Windows bridge architecture: ia32');
  });
});

describe('WslcBridgeManager node process and HTTP calls', () => {
  let nodeManager: NodeWslcBridgeManager;

  beforeEach(() => {
    const container = new Container();
    container.bind(ExtensionContextSymbol).toConstantValue({ extensionUri: { fsPath: extensionDirectory } });
    container.bind(BridgeConfigurationSymbol).toConstantValue(testBridgeConfiguration);
    container.bind(NodeWslcBridgeManager).toSelf();
    nodeManager = container.get(NodeWslcBridgeManager);
  });

  test('spawns the bridge through node:child_process', () => {
    const options: SpawnOptionsWithoutStdio = {
      cwd: extensionDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    nodeManager.callSpawnBridge('bridge.exe', ['serve'], options);

    expect(spawn).toHaveBeenCalledWith('bridge.exe', ['serve'], options);
  });

  test('sends the ping through node:http', () => {
    const options: BridgePingOptions = { socketPath: testBridgeConfiguration.pipeName, path: '/_ping', method: 'GET' };
    const onResponse = vi.fn<(response: BridgePingResponse) => void>();

    nodeManager.callCreatePingRequest(options, onResponse);

    expect(request).toHaveBeenCalledWith(options, onResponse);
  });
});

describe('WslcBridgeManager.start', () => {
  test('coalesces concurrent starts into one bridge process', async () => {
    const signal = new AbortController().signal;
    const firstStart = manager.start(signal, unexpectedExit);
    const secondStart = manager.start(signal, unexpectedExit);

    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    completePing();
    await Promise.all([firstStart, secondStart]);

    expect(manager.spawnRequests).toHaveLength(1);
    expect(manager.isReady()).toBe(true);
  });

  test('spawns the bridge and becomes ready after a complete ready record and named-pipe ping', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    const executablePath = resolve(
      extensionDirectory,
      'dist',
      'bin',
      'win32-x64',
      testBridgeConfiguration.executableName,
    );
    expect(manager.spawnRequests[0]).toEqual({
      executablePath,
      args: ['serve', '--pipe', testBridgeConfiguration.pipeName, '--shutdown-on-stdin-eof'],
      options: { cwd: dirname(executablePath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    });
    expect(child.stderr.readableFlowing).toBe(true);

    const record = readinessRecord();
    child.stdout.write(record.slice(0, 17));
    child.stdout.write(record.slice(17));
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    expect(manager.pingRequests[0]).toEqual({
      socketPath: testBridgeConfiguration.pipeName,
      path: '/_ping',
      method: 'GET',
    });
    completePing();
    await startPromise;

    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('forwards bridge stderr to the extension log', async () => {
    await startReadyBridge();

    child.stderr.write('bridge failure\n');

    expect(debugMock).toHaveBeenCalledWith('WSL Containers bridge stderr', 'bridge failure\n');
  });

  test('rejects unsupported host architecture before spawning', async () => {
    vi.mocked(arch).mockReturnValue('ia32');

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'Unsupported Windows bridge architecture: ia32',
    );

    expect(manager.spawnRequests).toHaveLength(0);
  });

  test.each([
    { code: 'ENOENT', message: 'WSL Containers bridge executable is missing' },
    { code: 'EACCES', message: 'WSL Containers bridge executable is not accessible' },
  ])('reports an $code access failure of the packaged executable before spawning', async ({ code, message }) => {
    const accessError = Object.assign(new Error('access failed'), { code });
    vi.mocked(access).mockRejectedValue(accessError);

    const error = await manager.start(new AbortController().signal, unexpectedExit).catch((reason: unknown) => reason);
    assert(error instanceof Error);

    expect(error.message).toContain(message);
    expect(error.cause).toBe(accessError);
    expect(manager.spawnRequests).toHaveLength(0);
  });

  test('accepts a ready bridge without requiring an exact bridge version', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord({ bridgeVersion: 'newer-bridge-build' }));
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    completePing();
    await startPromise;

    expect(manager.isReady()).toBe(true);
  });

  test('rejects a ready record that announces an unexpected pipe', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write(readinessRecord({ pipe: String.raw`\\.\pipe\other_engine` }));

    await expect(startPromise).rejects.toThrow('announced unexpected pipe');
    expect(manager.isReady()).toBe(false);
  });

  test('rejects with the startup error when cleanup cannot confirm termination', async () => {
    vi.useFakeTimers();
    child.stdin.removeAllListeners('finish');
    child.killMock.mockReturnValue(true);
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    const rejection = expect(startPromise).rejects.toThrow('announced unexpected pipe');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.spawnRequests).toHaveLength(1);

    child.stdout.write(readinessRecord({ pipe: String.raw`\\.\pipe\other_engine` }));
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs * 2);

    await rejection;
    expect(errorMock).toHaveBeenCalledWith(
      'WSL Containers bridge cleanup failed after a startup error',
      new Error('WSL Containers bridge did not exit after termination was requested'),
    );
  });

  test('reaps a retained bridge before starting a new one', async () => {
    await startReadyBridge();
    const retainedChild = child;
    retainedChild.stdin.removeAllListeners('finish');
    retainedChild.killMock.mockReturnValue(true);
    vi.useFakeTimers();
    const stopRejection = expect(manager.stop()).rejects.toThrow('did not exit after termination was requested');
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs * 2);
    await stopRejection;
    vi.useRealTimers();

    retainedChild.killMock.mockImplementation(() => {
      retainedChild.exit(1);
      return true;
    });
    child = new FakeChild();
    pingRequest = new FakePingRequest();
    pingResponse = new FakePingResponse();
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(2));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(2));
    completePing();
    await startPromise;

    expect(retainedChild.killMock).toHaveBeenCalledTimes(2);
    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('rejects a readiness line longer than the maximum size', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write(`${'x'.repeat(TestWslcBridgeManager.readinessLineLimit + 1)}\n`);

    await expect(startPromise).rejects.toThrow(
      `readiness line exceeded ${String(TestWslcBridgeManager.readinessLineLimit)} bytes`,
    );
  });

  test('rejects a partial readiness line longer than the maximum size', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write('x'.repeat(TestWslcBridgeManager.readinessLineLimit + 1));

    await expect(startPromise).rejects.toThrow(
      `readiness line exceeded ${String(TestWslcBridgeManager.readinessLineLimit)} bytes`,
    );
  });

  test('logs a non-JSON readiness line and keeps waiting for the ready record', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write('not a readiness record\n');
    expect(debugMock).toHaveBeenCalledWith(
      'WSL Containers bridge emitted a non-JSON readiness line',
      'not a readiness record',
      expect.any(SyntaxError),
    );

    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    completePing();
    await startPromise;

    expect(manager.isReady()).toBe(true);
  });

  test('rejects when the bridge exits before readiness', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.exit(1);

    await expect(startPromise).rejects.toThrow('exited before readiness');
  });

  test('rejects when the bridge exits while the readiness ping is pending', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    child.emit('exit', 1);
    completePing();

    await expect(startPromise).rejects.toThrow('exited before readiness');
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('rejects when the bridge fails to spawn', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.emit('error', new Error('spawn failed'));

    await expect(startPromise).rejects.toThrow('spawn failed');
  });

  test('rejects when the bridge does not become ready before the startup timeout', async () => {
    vi.useFakeTimers();
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    const rejection = expect(startPromise).rejects.toThrow('Timed out waiting for WSL Containers bridge readiness');

    await vi.advanceTimersByTimeAsync(0);
    expect(manager.spawnRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.startupTimeoutMs);

    await rejection;
  });

  test('rejects a start that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(manager.start(controller.signal, unexpectedExit)).rejects.toThrow('startup was cancelled');
    expect(manager.spawnRequests).toHaveLength(0);
  });

  test('rejects a start aborted while the bridge is starting', async () => {
    const controller = new AbortController();
    const startPromise = manager.start(controller.signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    controller.abort();

    await expect(startPromise).rejects.toThrow('startup was cancelled');
    expect(manager.isReady()).toBe(false);
  });

  test('does not spawn another bridge when the bridge is already ready', async () => {
    await startReadyBridge();

    await manager.start(new AbortController().signal, unexpectedExit);

    expect(manager.spawnRequests).toHaveLength(1);
  });
});

describe('WslcBridgeManager.ping', () => {
  test('rejects a ping started on an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(manager.ping(controller.signal)).rejects.toThrow('ping was cancelled');
  });

  test('rejects the start when the ping returns an error status', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    pingResponse.statusCode = 500;
    pingResponse.emit('end');

    await expect(startPromise).rejects.toThrow('Docker API ping failed');
  });

  test('rejects the start when the ping response fails', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    pingResponse.emit('error', new Error('socket error'));

    await expect(startPromise).rejects.toThrow('socket error');
  });

  test('rejects the start when the ping times out', async () => {
    vi.useFakeTimers();
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    const rejection = expect(startPromise).rejects.toThrow('Docker API ping timed out');

    await vi.advanceTimersByTimeAsync(0);
    expect(manager.spawnRequests).toHaveLength(1);
    child.stdout.write(readinessRecord());
    expect(manager.pingRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.requestTimeoutMs);

    await rejection;
  });

  test('rejects the ping when the request fails', async () => {
    pingRequest.endMock.mockImplementation(() => {
      pingRequest.emit('error', new Error('connect ENOENT'));
    });

    await expect(manager.ping()).rejects.toThrow('connect ENOENT');
  });

  test('settles a timed out ping even when destroying the request emits no error', async () => {
    vi.useFakeTimers();
    pingRequest.destroyMock.mockReturnValue(undefined);
    const pingPromise = manager.ping();
    const rejection = expect(pingPromise).rejects.toThrow('Docker API ping timed out');

    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.requestTimeoutMs);

    await rejection;
    expect(pingRequest.destroyMock).toHaveBeenCalledWith(new Error('WSL Containers bridge Docker API ping timed out'));
  });

  test('settles an aborted ping even when destroying the request emits no error', async () => {
    pingRequest.destroyMock.mockReturnValue(undefined);
    const controller = new AbortController();
    const pingPromise = manager.ping(controller.signal);

    controller.abort();

    await expect(pingPromise).rejects.toThrow('ping was cancelled');
    expect(pingRequest.destroyMock).toHaveBeenCalledWith(new Error('WSL Containers bridge ping was cancelled'));
  });

  test('cancels the start when the signal is aborted during the ping', async () => {
    const controller = new AbortController();
    const startPromise = manager.start(controller.signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    controller.abort();

    await expect(startPromise).rejects.toThrow('startup was cancelled');
  });
});

describe('WslcBridgeManager.stop', () => {
  test('closes stdin on stop and ignores the expected process close', async () => {
    await startReadyBridge();

    await manager.stop();

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).not.toHaveBeenCalled();
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('stops cleanly when no bridge was started', async () => {
    await manager.stop();

    expect(manager.isReady()).toBe(false);
  });

  test('kills the owned bridge if graceful stdin shutdown times out', async () => {
    await startReadyBridge();
    child.stdin.removeAllListeners('finish');
    vi.useFakeTimers();

    const stopPromise = manager.stop();
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs);
    await stopPromise;

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).toHaveBeenCalledOnce();
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('keeps the bridge and rejects the stop when termination is not confirmed', async () => {
    await startReadyBridge();
    child.stdin.removeAllListeners('finish');
    child.killMock.mockReturnValue(true);
    vi.useFakeTimers();

    const stopRejection = expect(manager.stop()).rejects.toThrow('did not exit after termination was requested');
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs * 2);
    await stopRejection;
    expect(child.killMock).toHaveBeenCalledOnce();

    const startRejection = expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'did not exit after termination was requested',
    );
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs * 2);
    await startRejection;
    expect(manager.spawnRequests).toHaveLength(1);
  });

  test('retires a pending launch when stopped so a later start spawns a new bridge', async () => {
    let resolveAccess: (() => void) | undefined;
    vi.mocked(access).mockImplementation(
      () =>
        new Promise<void>(resolveAccessPromise => {
          resolveAccess = resolveAccessPromise;
        }),
    );
    const firstStart = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(resolveAccess).toBeDefined());

    await manager.stop();
    assert(resolveAccess);
    resolveAccess();

    await expect(firstStart).rejects.toThrow('startup was cancelled');

    vi.mocked(access).mockResolvedValue(undefined);
    await startReadyBridge();

    expect(manager.spawnRequests).toHaveLength(1);
    expect(manager.isReady()).toBe(true);
  });

  test('cancels a launch waiting for readiness when stopped', async () => {
    vi.useFakeTimers();
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    const rejection = expect(startPromise).rejects.toThrow('startup was cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.spawnRequests).toHaveLength(1);

    await manager.stop();

    await rejection;
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).not.toHaveBeenCalled();
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('lets stop own the cleanup of a retired launch that does not exit', async () => {
    vi.useFakeTimers();
    child.stdin.removeAllListeners('finish');
    child.killMock.mockReturnValue(true);
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    const startRejection = expect(startPromise).rejects.toThrow('startup was cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.spawnRequests).toHaveLength(1);

    const stopRejection = expect(manager.stop()).rejects.toThrow('did not exit after termination was requested');
    await startRejection;
    await vi.advanceTimersByTimeAsync(testBridgeConfiguration.shutdownTimeoutMs * 2);
    await stopRejection;

    expect(child.killMock).toHaveBeenCalledOnce();
  });

  test('reports an unexpected process error once', async () => {
    await startReadyBridge();

    child.emit('error', new Error('process error'));
    child.exit(1);

    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });

  test('reports an unexpected exit after the bridge is ready', async () => {
    await startReadyBridge();

    child.exit(0);

    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });

  test('drops readiness on exit before the stdio streams close', async () => {
    await startReadyBridge();
    const exitedChild = child;

    exitedChild.emit('exit', 0);

    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).toHaveBeenCalledOnce();

    child = new FakeChild();
    pingRequest = new FakePingRequest();
    pingResponse = new FakePingResponse();
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(2));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(2));
    completePing();
    await startPromise;
    exitedChild.emit('close', 0);

    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });
});
