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

import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Platform directory under dist/bin -> pinned bridge release tag
import bridgeVersions from '../bridge-versions.json';

// Fix __dirname and __filename in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const binDir = join(__dirname, '..', 'dist', 'bin');

class Downloader {
  protected static readonly REPOSITORY = 'redhat-developer/wslc-bridge';

  // Windows executable the bridge release publishes for each platform directory
  protected static readonly ASSETS: Readonly<Record<string, string>> = {
    'win32-x64': 'wslc-bridge-windows-amd64.exe',
    'win32-arm64': 'wslc-bridge-windows-arm64.exe',
  };

  protected static readonly EXECUTABLE = 'wslc-bridge.exe';

  private async downloadFile(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${url} (${res.status})`);
    }

    await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }

  public async download(platform: string, version: string, outputDirectory: string): Promise<void> {
    const asset = Downloader.ASSETS[platform];
    if (!asset) {
      throw new Error(`Unsupported bridge platform ${platform}`);
    }

    const downloadUrl = `https://github.com/${Downloader.REPOSITORY}/releases/download/${version}/${asset}`;

    if (!fs.existsSync(outputDirectory)) {
      await fs.promises.mkdir(outputDirectory, { recursive: true });
    }

    console.log(`Downloading ${asset} from ${downloadUrl}...`);
    await this.downloadFile(downloadUrl, join(outputDirectory, Downloader.EXECUTABLE));
  }
}

(async () => {
  const downloader = new Downloader();
  for (const [platform, version] of Object.entries(bridgeVersions)) {
    await downloader.download(platform, version, join(binDir, platform));
  }
  console.log('✅ Download complete');
})().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
