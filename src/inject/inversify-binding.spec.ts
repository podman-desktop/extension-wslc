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
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InversifyBinding } from './inversify-binding';
import { ExtensionContextSymbol, TelemetryLoggerSymbol } from './symbol';

let extensionContext: ExtensionContext;
let telemetryLogger: TelemetryLogger;
let binding: InversifyBinding;

beforeEach(() => {
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
  binding = new InversifyBinding(extensionContext, telemetryLogger);
});

describe('InversifyBinding', () => {
  test('binds the extension context and telemetry logger', async () => {
    const container = await binding.init();

    expect(container.get(ExtensionContextSymbol)).toBe(extensionContext);
    expect(container.get(TelemetryLoggerSymbol)).toBe(telemetryLogger);
  });

  test('removes container bindings when disposed', async () => {
    const container = await binding.init();

    await binding.dispose();

    expect(container.isBound(ExtensionContextSymbol)).toBeFalsy();
    expect(container.isBound(TelemetryLoggerSymbol)).toBeFalsy();
  });

  test('resolves safely when disposed more than once', async () => {
    await binding.init();
    await binding.dispose();

    await expect(binding.dispose()).resolves.toBeUndefined();
  });
});
