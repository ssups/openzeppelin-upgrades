import path from 'path';
import { promises as fs, constants as fsConstants } from 'fs';

import { getVersionId } from './version';
import { Manifest, Deployment } from './manifest';

interface EthereumProvider {
  send(method: 'eth_chainId', params?: []): Promise<string>;
  send(method: 'eth_getCode', params: [string, string?]): Promise<string>;
  send(method: string, params?: unknown[]): Promise<unknown>;
}

export async function fetchOrDeploy(
  version: string,
  provider: EthereumProvider,
  deploy: () => Promise<Deployment>,
): Promise<string> {
  const manifest = new Manifest(await getChainId(provider));

  const fetched = await manifest.getDeployment(version);

  if (fetched) {
    const { address } = fetched;
    const code = await provider.send('eth_getCode', [address]);
    // TODO: fail if code is missing in non-dev chains?
    if (code !== '0x') {
      return address;
    }
  }

  const deployed = await deploy();
  await manifest.storeDeployment(version, deployed);
  return deployed.address;
}

async function getChainId(provider: EthereumProvider): Promise<string> {
  return provider.send('eth_chainId');
}