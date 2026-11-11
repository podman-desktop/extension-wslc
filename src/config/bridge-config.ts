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

export const BridgeConfigurationSymbol = Symbol.for('BridgeConfiguration');

export interface BridgeConfiguration {
  readonly executableName: string;
  readonly pipeName: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

const WSLC_BRIDGE_PIPE_NAME = String.raw`\\.\pipe\wslc_engine`;
const WSLC_BRIDGE_EXECUTABLE_NAME = 'wslc-bridge.exe';

export const bridgeConfiguration: BridgeConfiguration = {
  executableName: WSLC_BRIDGE_EXECUTABLE_NAME,
  pipeName: WSLC_BRIDGE_PIPE_NAME,
  startupTimeoutMs: 180_000,
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 10_000,
};
