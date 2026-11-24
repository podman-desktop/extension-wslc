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

import type { ExtensionContext, TelemetryLogger } from '@podman-desktop/api';
import { env } from '@podman-desktop/api';
import { Container } from 'inversify';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeConfiguration } from '/@/config/bridge-config';
import { InversifyBinding } from '/@/inject/inversify-binding';
import { WslcBridgeManager } from '/@/manager/wslc-bridge-manager';
import { WslcProviderManager } from '/@/manager/wslc-provider-manager';
import { WslcExtension } from './wslc-extension';

vi.mock(import('/@/inject/inversify-binding'));
vi.mock(import('/@/manager/wslc-provider-manager'));

let extensionContext: ExtensionContext;
let telemetryLogger: TelemetryLogger;
let providerManager: WslcProviderManager;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockReturnValue();
  vi.spyOn(console, 'warn').mockReturnValue();
  extensionContext = {
    subscriptions: [],
    storagePath: '/storage',
    extensionUri: {
      scheme: 'file',
      authority: '',
      path: '/extension',
      fsPath: '/extension',
      query: '',
      fragment: '',
      with: vi.fn(),
      toString: vi.fn(),
    },
    secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() },
  };
  telemetryLogger = {
    onDidChangeEnableStates: vi.fn(),
    isUsageEnabled: true,
    isErrorsEnabled: true,
    logUsage: vi.fn(),
    logError: vi.fn(),
    dispose: vi.fn(),
  };
  vi.mocked(env).isWindows = true;
  vi.mocked(env.createTelemetryLogger).mockReturnValue(telemetryLogger);
  providerManager = new WslcProviderManager(
    extensionContext,
    telemetryLogger,
    bridgeConfiguration,
    new WslcBridgeManager(extensionContext, bridgeConfiguration),
  );
  const container = new Container();
  container.bind(WslcProviderManager).toConstantValue(providerManager);
  vi.mocked(InversifyBinding.prototype.init).mockResolvedValue(container);
});

describe('WslcExtension', () => {
  test('registers the provider and reports activation on Windows', async () => {
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(InversifyBinding).toHaveBeenCalledWith(extensionContext, telemetryLogger);
    expect(providerManager.registerContainerProvider).toHaveBeenCalledOnce();
    expect(telemetryLogger.logUsage).toHaveBeenCalledWith('activated');
  });

  test('registers the telemetry logger for disposal on Windows', async () => {
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(extensionContext.subscriptions).toContain(telemetryLogger);
  });

  test('only warns off Windows', async () => {
    vi.mocked(env).isWindows = false;
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(console.warn).toHaveBeenCalledWith('WSL Containers extension not started: can only be activated on Windows');
    expect(env.createTelemetryLogger).not.toHaveBeenCalled();
    expect(InversifyBinding).not.toHaveBeenCalled();
    expect(providerManager.registerContainerProvider).not.toHaveBeenCalled();
  });

  test('deactivates the provider manager and disposes bindings when the extension is deactivated', async () => {
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await extension.deactivate();

    expect(providerManager.deactivate).toHaveBeenCalledOnce();
    expect(InversifyBinding.prototype.dispose).toHaveBeenCalledOnce();
  });

  test('does nothing when deactivated without activation', async () => {
    const extension = new WslcExtension(extensionContext);

    await expect(extension.deactivate()).resolves.toBeUndefined();

    expect(InversifyBinding.prototype.dispose).not.toHaveBeenCalled();
  });
});
