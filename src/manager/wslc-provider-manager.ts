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

@injectable()
export class WslcProviderManager {
  static readonly PROVIDER_ID = 'wslc';

  #wslcProvider: Provider | undefined;
  #connectionDisposable: Disposable | undefined;
  #connectionStatus: ProviderConnectionStatus = 'stopped';

  constructor(
    @inject(ExtensionContextSymbol) private readonly extensionContext: ExtensionContext,
    @inject(TelemetryLoggerSymbol) private readonly telemetryLogger: TelemetryLogger,
    @inject(BridgeConfiguration) private readonly configuration: BridgeConfiguration,
  ) {}

  registerContainerProvider(): Promise<void> {
    if (this.#wslcProvider) {
      return Promise.resolve();
    }

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
    return this.registerConnection();
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
    await this.cleanupConnection();
    this.#wslcProvider = undefined;
  }

  private registerConnection(): Promise<void> {
    if (!this.#wslcProvider || this.#connectionDisposable) {
      return Promise.resolve();
    }

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
}
