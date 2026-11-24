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

import {
  type ContainerProviderConnection,
  type Disposable,
  type ExtensionContext,
  type Provider,
  type ProviderConnectionStatus,
  provider,
  type TelemetryLogger,
} from '@podman-desktop/api';
import { inject, injectable } from 'inversify';
import { BridgeConfiguration } from '/@/config/bridge-config';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from '/@/inject/symbol';
import { WslcBridgeManager } from './wslc-bridge-manager';

@injectable()
export class WslcProviderManager {
  static readonly PROVIDER_ID = 'wslc';

  #wslcProvider: Provider | undefined;
  #connectionDisposable: Disposable | undefined;
  #connectionStatus: ProviderConnectionStatus = 'stopped';
  #refreshTimer: NodeJS.Timeout | undefined;
  #refreshPromise: Promise<void> | undefined;
  #stopMonitoringStatus = false;
  #abortController: AbortController | undefined;
  #bridgeStartupFailures = 0;

  constructor(
    @inject(ExtensionContextSymbol) private readonly extensionContext: ExtensionContext,
    @inject(TelemetryLoggerSymbol) private readonly telemetryLogger: TelemetryLogger,
    @inject(BridgeConfiguration) private readonly configuration: BridgeConfiguration,
    @inject(WslcBridgeManager) private readonly wslcBridgeManager: WslcBridgeManager,
  ) {}

  registerContainerProvider(): Promise<void> {
    if (this.#wslcProvider) {
      return Promise.resolve();
    }

    this.#stopMonitoringStatus = false;
    this.#abortController = new AbortController();
    this.#bridgeStartupFailures = 0;
    const wslcProvider = provider.createProvider({
      name: 'WSL Containers',
      id: WslcProviderManager.PROVIDER_ID,
      status: 'installed',
      images: {
        icon: './icon.png',
        logo: './icon.png',
      },
    });
    this.#wslcProvider = wslcProvider;
    this.extensionContext.subscriptions.push(wslcProvider);

    this.monitorContainerSystemStatus(wslcProvider).catch((error: unknown) => {
      console.error('Error monitoring WSL Containers runtime', error);
    });
    return Promise.resolve();
  }

  async updateContainerSystemStatus(wslcProvider: Provider): Promise<void> {
    if (this.#stopMonitoringStatus) {
      return;
    }

    if (this.#connectionDisposable && this.wslcBridgeManager.isReady()) {
      try {
        await this.wslcBridgeManager.ping();
        wslcProvider.updateStatus('ready');
        return;
      } catch (error: unknown) {
        await this.cleanupConnection();
        await this.stopBridge();
        console.warn('WSL Containers bridge health check failed', error);
      }
    }

    if (this.#bridgeStartupFailures >= this.configuration.maxConsecutiveStartupFailures) {
      wslcProvider.updateStatus('error');
      return;
    }

    try {
      await this.ensureBridge();
      this.#bridgeStartupFailures = 0;
      if (!this.#stopMonitoringStatus) {
        wslcProvider.updateStatus('ready');
      }
    } catch (error: unknown) {
      await this.cleanupConnection();
      await this.stopBridge();
      this.#bridgeStartupFailures += 1;
      if (!this.#stopMonitoringStatus) {
        wslcProvider.updateStatus('error');
        this.telemetryLogger.logError('bridgeStartupFailed', { error });
        console.error('WSL Containers bridge could not be started', error);
      }
    }
  }

  async monitorContainerSystemStatus(wslcProvider: Provider): Promise<void> {
    if (this.#stopMonitoringStatus) {
      return;
    }

    try {
      await this.refresh(wslcProvider);
    } catch (error: unknown) {
      console.trace('Error updating WSL Containers runtime status', error);
    }

    if (this.#stopMonitoringStatus) {
      return;
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      this.monitorContainerSystemStatus(wslcProvider).catch((error: unknown) => {
        console.error('Error monitoring WSL Containers runtime', error);
      });
    }, this.configuration.refreshIntervalMs);
  }

  async refresh(wslcProvider = this.#wslcProvider): Promise<void> {
    if (this.#stopMonitoringStatus || !wslcProvider) {
      return;
    }
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }

    const refreshPromise = this.updateContainerSystemStatus(wslcProvider).finally(() => {
      if (this.#refreshPromise === refreshPromise) {
        this.#refreshPromise = undefined;
      }
    });
    this.#refreshPromise = refreshPromise;
    return refreshPromise;
  }

  cleanupConnection(): Promise<void> {
    this.#connectionStatus = 'stopped';
    const connectionDisposable = this.#connectionDisposable;
    connectionDisposable?.dispose();
    if (connectionDisposable) {
      const index = this.extensionContext.subscriptions.indexOf(connectionDisposable);
      if (index >= 0) {
        this.extensionContext.subscriptions.splice(index, 1);
      }
    }
    this.#connectionDisposable = undefined;
    return Promise.resolve();
  }

  async deactivate(): Promise<void> {
    this.#stopMonitoringStatus = true;
    this.#abortController?.abort();
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    await this.#refreshPromise;
    await this.cleanupConnection();
    await this.stopBridge();
    this.#wslcProvider = undefined;
    this.#abortController = undefined;
  }

  private async ensureBridge(): Promise<void> {
    const abortController = this.#abortController;
    if (!abortController || abortController.signal.aborted) {
      throw new Error('WSL Containers bridge startup was cancelled');
    }

    const wasReady = this.wslcBridgeManager.isReady();
    await this.wslcBridgeManager.start(abortController.signal, error => this.handleBridgeExit(error));
    if (!this.wslcBridgeManager.isReady()) {
      throw new Error('WSL Containers bridge exited before becoming ready');
    }
    if (!wasReady) {
      this.telemetryLogger.logUsage('bridgeStarted');
    }

    await this.wslcBridgeManager.ping();
    if (!this.wslcBridgeManager.isReady() || this.#stopMonitoringStatus || abortController.signal.aborted) {
      throw new Error('WSL Containers bridge stopped before connection registration');
    }
    await this.registerConnection();
  }

  private handleBridgeExit(error: Error): void {
    this.cleanupAfterBridgeExit(error).catch((cleanupError: unknown) => {
      console.error('WSL Containers bridge cleanup failed after an unexpected exit', cleanupError);
    });
  }

  private async cleanupAfterBridgeExit(error: Error): Promise<void> {
    await this.cleanupConnection();
    await this.stopBridge();
    this.telemetryLogger.logUsage('bridgeExited');
    this.#bridgeStartupFailures += 1;
    if (!this.#stopMonitoringStatus) {
      this.#wslcProvider?.updateStatus(
        this.#bridgeStartupFailures >= this.configuration.maxConsecutiveStartupFailures ? 'error' : 'installed',
      );
      console.error('WSL Containers bridge process exited unexpectedly', error);
    }
  }

  private registerConnection(): Promise<void> {
    if (!this.#wslcProvider || this.#connectionDisposable || this.#stopMonitoringStatus) {
      return Promise.resolve();
    }

    this.#connectionStatus = 'started';
    const connection: ContainerProviderConnection = {
      name: 'WSL Containers',
      type: 'docker',
      status: (): ProviderConnectionStatus => this.#connectionStatus,
      endpoint: {
        socketPath: this.configuration.pipeName,
      },
    };
    this.#connectionDisposable = this.#wslcProvider.registerContainerProviderConnection(connection);
    this.extensionContext.subscriptions.push(this.#connectionDisposable);
    this.telemetryLogger.logUsage('connectionRegistered');
    return Promise.resolve();
  }

  private async stopBridge(): Promise<void> {
    await this.wslcBridgeManager.stop();
  }
}
