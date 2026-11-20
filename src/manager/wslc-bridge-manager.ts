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

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { access } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { inject, injectable } from 'inversify';
import type { ExtensionContext } from '@podman-desktop/api';
import { BridgeConfigurationSymbol, type BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol } from '/@/inject/symbol';

interface BridgeReadinessEvent {
  event: 'ready';
  protocolVersion: 1;
  bridgeVersion: string;
  pipe: string;
  guestApiVersion: string;
}

export interface BridgeChildProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: unknown, signal: unknown) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'exit', listener: (code: unknown, signal: unknown) => void): this;
}

export interface BridgePingOptions {
  socketPath: string;
  path: string;
  method: string;
}

export interface BridgePingRequest {
  end(): void;
  destroy(error: Error): void;
  once(event: 'error', listener: (error: Error) => void): this;
}

export interface BridgePingResponse {
  readonly statusCode?: number;
  setEncoding(encoding: BufferEncoding): void;
  on(event: 'data', listener: (chunk: string) => void): this;
  once(event: 'end', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

@injectable()
export class WslcBridgeManager {
  protected static readonly MAX_READINESS_LINE_BYTES = 2_048;

  #child: BridgeChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #ready = false;
  #stopping = false;
  #generation = 0;
  #unexpectedExit: ((error: Error) => void) | undefined;
  #launchController: AbortController | undefined;
  readonly #exitedChildren = new WeakSet<BridgeChildProcess>();

  constructor(
    @inject(ExtensionContextSymbol) private readonly extensionContext: ExtensionContext,
    @inject(BridgeConfigurationSymbol) private readonly configuration: BridgeConfiguration,
  ) {}

  isReady(): boolean {
    return this.#ready && this.#child !== undefined;
  }

  async start(signal: AbortSignal, onUnexpectedExit: (error: Error) => void): Promise<void> {
    if (this.#stopPromise) {
      await this.#stopPromise;
    }
    if (this.isReady()) {
      return;
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }
    if (this.#child) {
      await this.stop();
      return this.start(signal, onUnexpectedExit);
    }

    this.#stopping = false;
    this.#unexpectedExit = onUnexpectedExit;
    const generation = ++this.#generation;
    const launchController = new AbortController();
    this.#launchController = launchController;
    const startPromise = this.startBridge(AbortSignal.any([signal, launchController.signal]), generation).finally(
      () => {
        if (this.#startPromise === startPromise) {
          this.#startPromise = undefined;
        }
      },
    );
    this.#startPromise = startPromise;
    return startPromise;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('WSL Containers bridge ping was cancelled');
    }

    await new Promise<void>((resolvePing, rejectPing) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const request = this.createPingRequest(
        { socketPath: this.configuration.pipeName, path: '/_ping', method: 'GET' },
        response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.once('end', () => {
            if (response.statusCode === 200 && body === 'OK') {
              finish(resolvePing);
              return;
            }
            finish(() => rejectPing(new Error('WSL Containers bridge Docker API ping failed')));
          });
          response.once('error', (error: Error) => finish(() => rejectPing(error)));
        },
      );
      const cancel = (error: Error): void => {
        finish(() => rejectPing(error));
        request.destroy(error);
      };
      const onAbort = (): void => cancel(new Error('WSL Containers bridge ping was cancelled'));
      const timeout = setTimeout(
        () => cancel(new Error('WSL Containers bridge Docker API ping timed out')),
        this.configuration.requestTimeoutMs,
      );

      request.once('error', (error: Error) => finish(() => rejectPing(error)));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.end();
    });
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }
    const stopPromise = this.stopBridge().finally(() => {
      if (this.#stopPromise === stopPromise) {
        this.#stopPromise = undefined;
      }
    });
    this.#stopPromise = stopPromise;
    return stopPromise;
  }

  protected createPingRequest(
    options: BridgePingOptions,
    onResponse: (response: BridgePingResponse) => void,
  ): BridgePingRequest {
    return httpRequest(options, onResponse);
  }

  protected spawnBridge(executablePath: string, args: string[], options: SpawnOptionsWithoutStdio): BridgeChildProcess {
    return spawn(executablePath, args, options);
  }

  protected resolveBridgeExecutable(architecture: string): string {
    let platformDirectory: string;
    switch (architecture) {
      case 'x64':
        platformDirectory = 'win32-x64';
        break;
      case 'arm64':
        platformDirectory = 'win32-arm64';
        break;
      default:
        throw new Error(`Unsupported Windows bridge architecture: ${architecture}`);
    }

    return resolve(
      this.extensionContext.extensionUri.fsPath,
      'dist',
      'bin',
      platformDirectory,
      this.configuration.executableName,
    );
  }

  protected isReadinessEvent(value: unknown): value is BridgeReadinessEvent {
    if (typeof value !== 'object' || !value) {
      return false;
    }

    return (
      'event' in value &&
      value.event === 'ready' &&
      'protocolVersion' in value &&
      value.protocolVersion === 1 &&
      'bridgeVersion' in value &&
      typeof value.bridgeVersion === 'string' &&
      'pipe' in value &&
      typeof value.pipe === 'string' &&
      'guestApiVersion' in value &&
      typeof value.guestApiVersion === 'string'
    );
  }

  private async startBridge(signal: AbortSignal, generation: number): Promise<void> {
    if (signal.aborted) {
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const executablePath = this.resolveBridgeExecutable(arch());
    try {
      await access(executablePath);
    } catch (error: unknown) {
      throw new Error(this.describeAccessFailure(executablePath, error), { cause: error });
    }
    if (signal.aborted || this.#stopping || this.#generation !== generation) {
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const child = this.spawnBridge(
      executablePath,
      ['serve', '--pipe', this.configuration.pipeName, '--shutdown-on-stdin-eof'],
      {
        cwd: dirname(executablePath),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.#child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => console.debug('WSL Containers bridge stderr', chunk));
    child.on('error', (error: Error) => this.handleProcessError(child, generation, error));
    child.once('exit', (code, signalName) => {
      this.#exitedChildren.add(child);
      const error = new Error(`WSL Containers bridge exited (code ${String(code)}, signal ${String(signalName)})`);
      this.handleProcessExit(child, generation, error);
    });

    try {
      await this.waitForReadiness(child, signal);
      if (
        this.#child !== child ||
        this.#exitedChildren.has(child) ||
        this.#generation !== generation ||
        this.#stopping ||
        signal.aborted
      ) {
        throw new Error('WSL Containers bridge exited before startup completed');
      }
      this.#ready = true;
    } catch (error: unknown) {
      if (this.#generation === generation) {
        try {
          await this.stop();
        } catch (stopError: unknown) {
          console.error('WSL Containers bridge cleanup failed after a startup error', stopError);
        }
      }
      throw error;
    }
  }

  private describeAccessFailure(executablePath: string, error: unknown): string {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return `WSL Containers bridge executable is missing: ${executablePath}`;
    }
    return `WSL Containers bridge executable is not accessible: ${executablePath}`;
  }

  private async waitForReadiness(child: BridgeChildProcess, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolveReady, rejectNotReady) => {
      let partialLine = Buffer.alloc(0);
      let settled = false;
      let checkingPing = false;

      const cleanup = (): void => {
        clearTimeout(startupTimer);
        child.stdout.removeListener('data', onStdout);
        child.removeListener('error', onChildError);
        child.removeListener('exit', onChildExit);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onReadinessLine = (line: Buffer): void => {
        const normalizedLine = line.at(-1) === 13 ? line.subarray(0, -1) : line;
        const text = normalizedLine.toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error: unknown) {
          console.debug('WSL Containers bridge emitted a non-JSON readiness line', text, error);
          return;
        }
        if (!this.isReadinessEvent(parsed) || checkingPing) {
          return;
        }
        if (parsed.pipe !== this.configuration.pipeName) {
          finish(() => rejectNotReady(new Error(`WSL Containers bridge announced unexpected pipe ${parsed.pipe}`)));
          return;
        }
        checkingPing = true;
        confirmReadiness().catch((error: unknown) =>
          finish(() => rejectNotReady(error instanceof Error ? error : new Error('WSL Containers bridge ping failed'))),
        );
      };
      const confirmReadiness = async (): Promise<void> => {
        await this.ping(signal);
        finish(resolveReady);
      };
      const onStdout = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let remaining = Buffer.concat([partialLine, bytes]);
        let newlineIndex = remaining.indexOf(10);
        while (newlineIndex !== -1) {
          const line = remaining.subarray(0, newlineIndex);
          if (line.length > WslcBridgeManager.MAX_READINESS_LINE_BYTES) {
            finish(() =>
              rejectNotReady(
                new Error(
                  `WSL Containers bridge readiness line exceeded ${String(WslcBridgeManager.MAX_READINESS_LINE_BYTES)} bytes`,
                ),
              ),
            );
            return;
          }
          onReadinessLine(line);
          if (settled) {
            return;
          }
          remaining = remaining.subarray(newlineIndex + 1);
          newlineIndex = remaining.indexOf(10);
        }

        if (remaining.length > WslcBridgeManager.MAX_READINESS_LINE_BYTES) {
          finish(() =>
            rejectNotReady(
              new Error(
                `WSL Containers bridge readiness line exceeded ${String(WslcBridgeManager.MAX_READINESS_LINE_BYTES)} bytes`,
              ),
            ),
          );
          return;
        }
        partialLine = remaining;
      };
      const onChildError = (error: Error): void => finish(() => rejectNotReady(error));
      const onChildExit = (code: unknown): void =>
        finish(() => rejectNotReady(new Error(`WSL Containers bridge exited before readiness (code ${String(code)})`)));
      const onAbort = (): void =>
        finish(() => rejectNotReady(new Error('WSL Containers bridge startup was cancelled')));
      const startupTimer = setTimeout(
        () => finish(() => rejectNotReady(new Error('Timed out waiting for WSL Containers bridge readiness'))),
        this.configuration.startupTimeoutMs,
      );

      child.stdout.on('data', onStdout);
      child.once('error', onChildError);
      child.once('exit', onChildExit);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async stopBridge(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    if (this.#startPromise) {
      this.#generation += 1;
      this.#startPromise = undefined;
      this.#launchController?.abort();
    }
    this.#launchController = undefined;
    const child = this.#child;
    if (!child) {
      return;
    }

    if (!(await this.reapChild(child))) {
      throw new Error('WSL Containers bridge did not exit after termination was requested');
    }
    if (this.#child === child) {
      this.#child = undefined;
    }
  }

  private async reapChild(child: BridgeChildProcess): Promise<boolean> {
    if (child.pid === undefined || this.#exitedChildren.has(child)) {
      return true;
    }

    const exitPromise = this.waitForExit(child, this.configuration.shutdownTimeoutMs);
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    if (await exitPromise) {
      return true;
    }

    child.kill();
    return this.waitForExit(child, this.configuration.shutdownTimeoutMs);
  }

  private async waitForExit(child: BridgeChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.#exitedChildren.has(child)) {
      return true;
    }

    return new Promise<boolean>(resolveExited => {
      const onExit = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const finish = (exited: boolean): void => {
        clearTimeout(timeout);
        child.removeListener('exit', onExit);
        resolveExited(exited);
      };
      child.once('exit', onExit);
    });
  }

  private handleProcessError(child: BridgeChildProcess, generation: number, error: Error): void {
    if (this.#child !== child || this.#generation !== generation) {
      return;
    }

    const wasReady = this.#ready;
    this.#ready = false;
    if (wasReady && !this.#stopping) {
      this.#unexpectedExit?.(error);
    }
  }

  private handleProcessExit(child: BridgeChildProcess, generation: number, error: Error): void {
    if (this.#child !== child || this.#generation !== generation) {
      return;
    }

    const wasReady = this.#ready;
    this.#ready = false;
    this.#child = undefined;
    if (wasReady && !this.#stopping) {
      this.#unexpectedExit?.(error);
    }
  }
}
