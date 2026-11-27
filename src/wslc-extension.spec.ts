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
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InversifyBinding } from '/@/inject/inversify-binding';
import { WslcExtension } from './wslc-extension';

vi.mock(import('/@/inject/inversify-binding'));

let extensionContext: ExtensionContext;
let telemetryLogger: TelemetryLogger;

beforeEach(() => {
  vi.resetAllMocks();
  console.log = vi.fn();
  console.warn = vi.fn();
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
});

describe('WslcExtension', () => {
  test('initializes bindings and reports activation on Windows', async () => {
    const extension = new WslcExtension(extensionContext);

    await extension.activate();

    expect(InversifyBinding).toHaveBeenCalledWith(extensionContext, telemetryLogger);
    expect(InversifyBinding.prototype.init).toHaveBeenCalledOnce();
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
  });

  test('disposes bindings when the extension is deactivated', async () => {
    const extension = new WslcExtension(extensionContext);
    await extension.activate();

    await extension.deactivate();

    expect(InversifyBinding.prototype.dispose).toHaveBeenCalledOnce();
  });

  test('does nothing when deactivated without activation', async () => {
    const extension = new WslcExtension(extensionContext);

    await expect(extension.deactivate()).resolves.toBeUndefined();

    expect(InversifyBinding.prototype.dispose).not.toHaveBeenCalled();
  });
});
