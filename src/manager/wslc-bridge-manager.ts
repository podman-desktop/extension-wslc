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
import { type EventEmitter, once } from 'node:events';
import { access } from 'node:fs/promises';
import { request, type RequestOptions } from 'node:http';
import { arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { inject, injectable } from 'inversify';
import { z } from 'zod';
import type { ExtensionContext } from '@podman-desktop/api';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol } from '/@/inject/symbol';

export interface BridgeChildProcess extends EventEmitter {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
}

export interface BridgePingRequest {
  on(event: 'error', listener: (error: Error) => void): this;
  end(): void;
}

export interface BridgePingResponse extends AsyncIterable<unknown> {
  readonly statusCode?: number;
  setEncoding(encoding: BufferEncoding): this;
}

@injectable()
export class WslcBridgeManager {
  protected static readonly READINESS_EVENT_SCHEMA = z.object({
    event: z.literal('ready'),
    protocolVersion: z.literal(1),
    bridgeVersion: z.string(),
    pipe: z.string(),
    guestApiVersion: z.string(),
  });

  #child: BridgeChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #launchController: AbortController | undefined;
  #ready = false;

  constructor(
    @inject(ExtensionContextSymbol) private readonly extensionContext: ExtensionContext,
    @inject(BridgeConfiguration) private readonly configuration: BridgeConfiguration,
  ) {}

  isReady(): boolean {
    return this.#ready && this.#child !== undefined;
  }

  async start(signal: AbortSignal, onUnexpectedExit: (error: Error) => void): Promise<void> {
    if (this.isReady()) {
      return;
    }
    if (!this.#startPromise) {
      const startPromise = this.launch(signal, onUnexpectedExit).finally(() => {
        if (this.#startPromise === startPromise) {
          this.#startPromise = undefined;
        }
      });
      this.#startPromise = startPromise;
    }
    return this.#startPromise;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.configuration.requestTimeoutMs);
    const pingSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      pingSignal.throwIfAborted();
      const response = await new Promise<BridgePingResponse>((resolveResponse, rejectResponse) => {
        const pingRequest = this.createPingRequest(
          { socketPath: this.configuration.pipeName, path: '/_ping', method: 'GET', signal: pingSignal },
          resolveResponse,
        );
        pingRequest.on('error', rejectResponse);
        pingRequest.end();
      });
      let body = '';
      response.setEncoding('utf8');
      for await (const chunk of response) {
        body += String(chunk);
      }
      if (response.statusCode !== 200 || body !== 'OK') {
        throw new Error('WSL Containers bridge Docker API ping failed');
      }
    } catch (error: unknown) {
      if (timeout.aborted) {
        throw new Error('WSL Containers bridge Docker API ping timed out', { cause: error });
      }
      if (signal?.aborted) {
        throw new Error('WSL Containers bridge ping was cancelled', { cause: error });
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#ready = false;
    this.#startPromise = undefined;
    this.#launchController?.abort();
    this.#launchController = undefined;
    const child = this.#child;
    if (!child) {
      return;
    }

    await this.terminate(child);
    if (this.#child === child) {
      this.#child = undefined;
    }
  }

  protected createPingRequest(
    options: RequestOptions,
    onResponse: (response: BridgePingResponse) => void,
  ): BridgePingRequest {
    return request(options, onResponse);
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

  private async launch(signal: AbortSignal, onUnexpectedExit: (error: Error) => void): Promise<void> {
    if (this.#child) {
      await this.stop();
    }

    const launchController = new AbortController();
    this.#launchController = launchController;
    const startupSignal = AbortSignal.any([
      signal,
      launchController.signal,
      AbortSignal.timeout(this.configuration.startupTimeoutMs),
    ]);

    try {
      startupSignal.throwIfAborted();
      const executablePath = this.resolveBridgeExecutable(arch());
      await this.checkExecutable(executablePath);
      startupSignal.throwIfAborted();

      const child = this.spawnBridge(
        executablePath,
        ['serve', '--pipe', this.configuration.pipeName, '--shutdown-on-stdin-eof'],
        { cwd: dirname(executablePath), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.#child = child;
      this.watchChild(child, launchController, onUnexpectedExit);

      await this.waitForReadiness(child, startupSignal);
      startupSignal.throwIfAborted();
      this.#ready = true;
    } catch (error: unknown) {
      const startupFailure = this.describeStartupFailure(startupSignal, error);
      if (this.#launchController === launchController) {
        try {
          await this.stop();
        } catch (stopError: unknown) {
          console.error('WSL Containers bridge cleanup failed after a startup error', stopError);
        }
      }
      throw startupFailure;
    }
  }

  private async checkExecutable(executablePath: string): Promise<void> {
    try {
      await access(executablePath);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`WSL Containers bridge executable is missing: ${executablePath}`, { cause: error });
      }
      throw new Error(`WSL Containers bridge executable is not accessible: ${executablePath}`, { cause: error });
    }
  }

  private watchChild(
    child: BridgeChildProcess,
    launchController: AbortController,
    onUnexpectedExit: (error: Error) => void,
  ): void {
    child.stdin.on('error', (error: Error) => console.debug('WSL Containers bridge stdin closed', error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => console.debug('WSL Containers bridge stderr', chunk));
    child.on('error', (error: Error) => {
      launchController.abort(error);
      if (this.#child === child && this.#ready) {
        this.#ready = false;
        onUnexpectedExit(error);
      }
    });
    child.once('exit', (code: unknown, signalName: unknown) => {
      const status = `code ${String(code)}, signal ${String(signalName)}`;
      launchController.abort(new Error(`WSL Containers bridge exited before readiness (${status})`));
      if (this.#child !== child) {
        return;
      }
      this.#child = undefined;
      if (this.#ready) {
        this.#ready = false;
        onUnexpectedExit(new Error(`WSL Containers bridge exited (${status})`));
      }
    });
  }

  private async waitForReadiness(child: BridgeChildProcess, signal: AbortSignal): Promise<void> {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity, signal });
    try {
      for await (const line of lines) {
        const readiness = this.parseReadinessLine(line);
        if (!readiness) {
          continue;
        }
        if (readiness.pipe !== this.configuration.pipeName) {
          throw new Error(`WSL Containers bridge announced unexpected pipe ${readiness.pipe}`);
        }
        await this.ping(signal);
        return;
      }
    } finally {
      lines.close();
      child.stdout.resume();
    }
    throw new Error('WSL Containers bridge exited before readiness');
  }

  private parseReadinessLine(line: string): z.infer<typeof WslcBridgeManager.READINESS_EVENT_SCHEMA> | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error: unknown) {
      console.debug('WSL Containers bridge emitted a non-JSON readiness line', line, error);
      return undefined;
    }
    return WslcBridgeManager.READINESS_EVENT_SCHEMA.safeParse(parsed).data;
  }

  private describeStartupFailure(signal: AbortSignal, error: unknown): unknown {
    if (!signal.aborted) {
      return error;
    }
    const reason: unknown = signal.reason;
    if (reason instanceof Error && reason.name === 'TimeoutError') {
      return new Error('Timed out waiting for WSL Containers bridge readiness', { cause: reason });
    }
    if (reason instanceof Error && reason.name !== 'AbortError') {
      return reason;
    }
    return new Error('WSL Containers bridge startup was cancelled', { cause: reason });
  }

  private async terminate(child: BridgeChildProcess): Promise<void> {
    if (child.pid === undefined) {
      return;
    }

    try {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(this.configuration.shutdownTimeoutMs) });
      child.stdin.end();
      await exited;
      return;
    } catch (error: unknown) {
      console.debug('WSL Containers bridge did not exit after stdin EOF, killing it', error);
    }

    try {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(this.configuration.shutdownTimeoutMs) });
      child.kill();
      await exited;
    } catch (error: unknown) {
      throw new Error('WSL Containers bridge did not exit after termination was requested', { cause: error });
    }
  }
}
