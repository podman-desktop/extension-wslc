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

import { env, type ExtensionContext } from '@podman-desktop/api';
import { InversifyBinding } from '/@/inject/inversify-binding';
import { WslcProviderManager } from '/@/manager/wslc-provider-manager';

export class WslcExtension {
  readonly #extensionContext: ExtensionContext;
  #inversifyBinding: InversifyBinding | undefined;
  #providerManager: WslcProviderManager | undefined;

  constructor(extensionContext: ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  async activate(): Promise<void> {
    if (!env.isWindows) {
      console.warn('WSL Containers extension not started: can only be activated on Windows');
      return;
    }

    const telemetryLogger = env.createTelemetryLogger();
    this.#extensionContext.subscriptions.push(telemetryLogger);
    this.#inversifyBinding = new InversifyBinding(this.#extensionContext, telemetryLogger);
    const container = await this.#inversifyBinding.init();
    this.#providerManager = await container.getAsync(WslcProviderManager);
    await this.#providerManager.registerContainerProvider();

    console.log('WSL Containers extension activated on Windows');
    telemetryLogger.logUsage('activated');
  }

  async deactivate(): Promise<void> {
    await this.#providerManager?.deactivate();
    this.#providerManager = undefined;
    await this.#inversifyBinding?.dispose();
    this.#inversifyBinding = undefined;
  }
}
