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

import type { ExtensionContext } from '@podman-desktop/api';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { activate, deactivate } from './extension';
import { WslcExtension } from './wslc-extension';

vi.mock(import('./wslc-extension'));

let extensionContext: ExtensionContext;

beforeEach(async () => {
  await deactivate();
  vi.resetAllMocks();
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
});

describe('main lifecycle', () => {
  test('creates and activates the extension', async () => {
    await activate(extensionContext);

    expect(WslcExtension).toHaveBeenCalledWith(extensionContext);
    expect(WslcExtension.prototype.activate).toHaveBeenCalledOnce();
  });

  test('reuses the same extension instance on repeated activation', async () => {
    await activate(extensionContext);
    await activate(extensionContext);

    expect(WslcExtension).toHaveBeenCalledOnce();
    expect(WslcExtension.prototype.activate).toHaveBeenCalledTimes(2);
  });

  test('does nothing when deactivated before activation', async () => {
    await deactivate();

    expect(WslcExtension.prototype.deactivate).not.toHaveBeenCalled();
  });

  test('creates a new extension instance after deactivation', async () => {
    await activate(extensionContext);
    await deactivate();
    await activate(extensionContext);

    expect(WslcExtension.prototype.deactivate).toHaveBeenCalledOnce();
    expect(WslcExtension).toHaveBeenCalledTimes(2);
  });
});
