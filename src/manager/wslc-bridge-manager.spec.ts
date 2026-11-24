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

import { type SpawnOptionsWithoutStdio, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { request, type RequestOptions } from 'node:http';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { Container, injectable, injectFromBase } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol } from '/@/inject/symbol';
import {
  WslcBridgeManager,
  type BridgeChildProcess,
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
  startupTimeoutMs: 500,
  requestTimeoutMs: 200,
  shutdownTimeoutMs: 50,
  maxConsecutiveStartupFailures: 3,
  refreshIntervalMs: 30_000,
};

class FakePingResponse extends PassThrough implements BridgePingResponse {
  statusCode?: number = 200;
}

class FakePingRequest extends EventEmitter implements BridgePingRequest {
  responded = false;
  readonly endMock = vi.fn((): void => {
    if (pingRequestError) {
      this.emit('error', pingRequestError);
      return;
    }
    this.responded = true;
    this.onResponse(pingResponse);
  });

  constructor(
    options: RequestOptions,
    private readonly onResponse: (response: BridgePingResponse) => void,
  ) {
    super();
    const signal = options.signal;
    const response = pingResponse;
    signal?.addEventListener(
      'abort',
      () => {
        if (response.readableEnded) {
          return;
        }
        const reason: unknown = signal.reason;
        const error = reason instanceof Error ? reason : new Error('ping request aborted');
        this.emit('error', error);
        if (this.responded) {
          response.destroy(error);
        }
      },
      { once: true },
    );
  }

  end(): void {
    this.endMock();
  }
}

class FakeChild extends EventEmitter implements BridgeChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  exitOnStdinEnd = true;
  readonly killMock = vi.fn((): boolean => {
    this.exit(1);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('finish', () => {
      if (this.exitOnStdinEnd) {
        this.exit(0);
      }
    });
  }

  kill(): boolean {
    return this.killMock();
  }

  exit(code: number): void {
    this.emit('exit', code, undefined);
    this.stdout.end();
    this.emit('close', code);
  }
}

let child: FakeChild;
let pingResponse: FakePingResponse;
let pingRequestError: Error | undefined;
let manager: TestWslcBridgeManager;
let unexpectedExit: (error: Error) => void;
let debugMock: (...data: unknown[]) => void;
let errorMock: (...data: unknown[]) => void;

@injectable()
@injectFromBase()
class TestWslcBridgeManager extends WslcBridgeManager {
  readonly spawnRequests: { executablePath: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  readonly pingRequests: RequestOptions[] = [];

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
    options: RequestOptions,
    onResponse: (response: BridgePingResponse) => void,
  ): BridgePingRequest {
    this.pingRequests.push(options);
    return new FakePingRequest(options, onResponse);
  }
}

@injectable()
@injectFromBase()
class NodeWslcBridgeManager extends WslcBridgeManager {
  callSpawnBridge(executablePath: string, args: string[], options: SpawnOptionsWithoutStdio): BridgeChildProcess {
    return this.spawnBridge(executablePath, args, options);
  }

  callCreatePingRequest(
    options: RequestOptions,
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
  pingResponse.end('OK');
}

function resetBridgeFakes(): void {
  child = new FakeChild();
  pingResponse = new FakePingResponse();
}

async function startReadyBridge(): Promise<void> {
  const spawnCount = manager.spawnRequests.length;
  const pingCount = manager.pingRequests.length;
  const startPromise = manager.start(new AbortController().signal, unexpectedExit);
  await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(spawnCount + 1));
  child.stdout.write(readinessRecord());
  await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(pingCount + 1));
  completePing();
  await startPromise;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(arch).mockReturnValue('x64');
  vi.mocked(access).mockResolvedValue(undefined);
  debugMock = vi.fn<(...data: unknown[]) => void>();
  console.debug = debugMock;
  errorMock = vi.fn<(...data: unknown[]) => void>();
  console.error = errorMock;

  resetBridgeFakes();
  pingRequestError = undefined;
  unexpectedExit = vi.fn<(error: Error) => void>();

  const container = new Container();
  container.bind(ExtensionContextSymbol).toConstantValue({ extensionUri: { fsPath: extensionDirectory } });
  container.bind(BridgeConfiguration).toConstantValue(testBridgeConfiguration);
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
    container.bind(BridgeConfiguration).toConstantValue(testBridgeConfiguration);
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
    const options: RequestOptions = { socketPath: testBridgeConfiguration.pipeName, path: '/_ping', method: 'GET' };
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
    expect(access).toHaveBeenCalledWith(executablePath);
    expect(manager.spawnRequests[0]).toEqual({
      executablePath,
      args: ['serve', '--pipe', testBridgeConfiguration.pipeName, '--shutdown-on-stdin-eof'],
      options: { cwd: dirname(executablePath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    });

    const record = readinessRecord();
    child.stdout.write(record.slice(0, 17));
    child.stdout.write(record.slice(17));
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    expect(manager.pingRequests[0]).toEqual(
      expect.objectContaining({ socketPath: testBridgeConfiguration.pipeName, path: '/_ping', method: 'GET' }),
    );
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
  ])('rejects with "$message" when the access check fails with $code', async ({ code, message }) => {
    vi.mocked(access).mockRejectedValue(Object.assign(new Error(code), { code }));

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(message);

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

  test('rejects a ready record that announces an unexpected pipe and shuts the bridge down', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write(readinessRecord({ pipe: String.raw`\\.\pipe\other_engine` }));

    await expect(startPromise).rejects.toThrow('announced unexpected pipe');
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).not.toHaveBeenCalled();
    expect(manager.isReady()).toBe(false);
  });

  test('rejects with the startup error when cleanup cannot confirm termination', async () => {
    child.exitOnStdinEnd = false;
    child.killMock.mockReturnValue(true);
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write(readinessRecord({ pipe: String.raw`\\.\pipe\other_engine` }));

    await expect(startPromise).rejects.toThrow('announced unexpected pipe');
    expect(errorMock).toHaveBeenCalledWith(
      'WSL Containers bridge cleanup failed after a startup error',
      expect.objectContaining({ message: 'WSL Containers bridge did not exit after termination was requested' }),
    );
  });

  test('reaps a retained bridge before starting a new one', async () => {
    await startReadyBridge();
    const retainedChild = child;
    retainedChild.exitOnStdinEnd = false;
    retainedChild.killMock.mockReturnValue(true);
    await expect(manager.stop()).rejects.toThrow('did not exit after termination was requested');

    retainedChild.killMock.mockImplementation(() => {
      retainedChild.exit(1);
      return true;
    });
    resetBridgeFakes();
    await startReadyBridge();

    expect(retainedChild.killMock).toHaveBeenCalledTimes(2);
    expect(manager.spawnRequests).toHaveLength(2);
    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('logs a non-JSON readiness line and keeps waiting for the ready record', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    child.stdout.write('not a readiness record\n');
    await vi.waitFor(() =>
      expect(debugMock).toHaveBeenCalledWith(
        'WSL Containers bridge emitted a non-JSON readiness line',
        'not a readiness record',
        expect.any(SyntaxError),
      ),
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

    child.exit(1);

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
    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'Timed out waiting for WSL Containers bridge readiness',
    );

    expect(child.stdin.writableEnded).toBe(true);
  });

  test('rejects a start that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(manager.start(controller.signal, unexpectedExit)).rejects.toThrow('startup was cancelled');
    expect(manager.spawnRequests).toHaveLength(0);
  });

  test('shuts the bridge down when the start is aborted while the bridge is starting', async () => {
    const controller = new AbortController();
    const startPromise = manager.start(controller.signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    controller.abort();

    await expect(startPromise).rejects.toThrow('startup was cancelled');
    expect(child.stdin.writableEnded).toBe(true);
    expect(manager.isReady()).toBe(false);
  });

  test('keeps the bridge running when the start signal is aborted after readiness', async () => {
    const controller = new AbortController();
    const startPromise = manager.start(controller.signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));
    completePing();
    await startPromise;

    controller.abort();

    expect(child.stdin.writableEnded).toBe(false);
    expect(manager.isReady()).toBe(true);
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
    expect(manager.pingRequests).toHaveLength(0);
  });

  test('resolves when the bridge answers OK', async () => {
    const pingPromise = manager.ping();
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    completePing();

    await expect(pingPromise).resolves.toBeUndefined();
  });

  test('rejects the start when the ping returns an error status', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    pingResponse.statusCode = 500;
    pingResponse.end();

    await expect(startPromise).rejects.toThrow('Docker API ping failed');
  });

  test('rejects the start when the ping response fails', async () => {
    const startPromise = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));
    child.stdout.write(readinessRecord());
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    pingResponse.destroy(new Error('socket error'));

    await expect(startPromise).rejects.toThrow('socket error');
  });

  test('rejects the ping when the request fails', async () => {
    pingRequestError = new Error('connect ENOENT');

    await expect(manager.ping()).rejects.toThrow('connect ENOENT');
  });

  test('rejects the ping when the bridge does not answer before the request timeout', async () => {
    await expect(manager.ping()).rejects.toThrow('Docker API ping timed out');
  });

  test('rejects the ping when its signal is aborted', async () => {
    const controller = new AbortController();
    const pingPromise = manager.ping(controller.signal);
    await vi.waitFor(() => expect(manager.pingRequests).toHaveLength(1));

    controller.abort();

    await expect(pingPromise).rejects.toThrow('ping was cancelled');
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
  test('closes the bridge stdin on stop and ignores the expected exit', async () => {
    await startReadyBridge();

    await manager.stop();

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).not.toHaveBeenCalled();
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('kills the bridge when it does not exit after stdin is closed', async () => {
    await startReadyBridge();
    child.exitOnStdinEnd = false;

    await manager.stop();

    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killMock).toHaveBeenCalledOnce();
    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  test('stops cleanly when no bridge was started', async () => {
    await manager.stop();

    expect(manager.isReady()).toBe(false);
  });

  test('keeps the bridge and rejects the stop when termination is not confirmed', async () => {
    await startReadyBridge();
    child.exitOnStdinEnd = false;
    child.killMock.mockReturnValue(true);

    await expect(manager.stop()).rejects.toThrow('did not exit after termination was requested');
    expect(child.killMock).toHaveBeenCalledOnce();

    await expect(manager.start(new AbortController().signal, unexpectedExit)).rejects.toThrow(
      'did not exit after termination was requested',
    );
    expect(manager.spawnRequests).toHaveLength(1);
  });

  test('cancels a pending launch when stopped so a later start spawns a new bridge', async () => {
    const firstStart = manager.start(new AbortController().signal, unexpectedExit);
    await vi.waitFor(() => expect(manager.spawnRequests).toHaveLength(1));

    await manager.stop();
    await expect(firstStart).rejects.toThrow('startup was cancelled');

    resetBridgeFakes();
    await startReadyBridge();

    expect(manager.spawnRequests).toHaveLength(2);
    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
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
    expect(unexpectedExit).toHaveBeenCalledWith(new Error('WSL Containers bridge exited (code 0, signal undefined)'));
  });

  test('drops readiness on exit before the stdio streams close', async () => {
    await startReadyBridge();
    const exitedChild = child;

    exitedChild.emit('exit', 0, undefined);

    expect(manager.isReady()).toBe(false);
    expect(unexpectedExit).toHaveBeenCalledOnce();

    resetBridgeFakes();
    await startReadyBridge();
    exitedChild.emit('close', 0);

    expect(manager.isReady()).toBe(true);
    expect(unexpectedExit).toHaveBeenCalledOnce();
  });
});
