import { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { ethers, ContractFactory, Contract, Signer } from 'ethers';

import { getAdminAddress, getCode, isEmptySlot } from '@openzeppelin/upgrades-core';

import {
  UpgradeProxyOptions,
  deployProxyImpl,
  getITransparentUpgradeableProxyFactory,
  getProxyAdminFactory,
  getContractAddress,
  ContractAddressOrInstance,
  getSigner,
} from './utils';
import { disableDefender } from './defender/utils';
import { attach } from './utils/ethers';

export type UpgradeFunction = (
  proxy: ContractAddressOrInstance,
  ImplFactory: ContractFactory,
  opts?: UpgradeProxyOptions,
) => Promise<Contract>;

export function makeUpgradeProxy(hre: HardhatRuntimeEnvironment, defenderModule: boolean): UpgradeFunction {
  return async function upgradeProxy(proxy, ImplFactory, opts: UpgradeProxyOptions = {}) {
    disableDefender(hre, defenderModule, opts, upgradeProxy.name);

    const proxyAddress = await getContractAddress(proxy);

    const { impl: nextImpl } = await deployProxyImpl(hre, ImplFactory, opts, proxyAddress);
    // upgrade kind is inferred above
    const upgradeTo = await getUpgrader(proxyAddress, opts, getSigner(ImplFactory.runner));
    const call = encodeCall(ImplFactory, opts.call);
    const upgradeTx = await upgradeTo(nextImpl, call);

    const inst = attach(ImplFactory, proxyAddress);

    // as is -> inst.deployTransaction = upgradeTx;
    // inst(instance of ethers.Contract) dose not have property named deployTransaction but deploymentTransaction
    // and it is a function which returns ethers.ContractTransactionResponse | null , not ethers.TransactionResponse itself
    // it shoud be correted like below
    // @ts-ignore
    inst.deploymentTransaction = () => upgradeTx || null;

    // Additionally, upgradeTx is not tx about deployment (also each type is different)
    // I think it's better way to not override deploymentTrnasaction with upgradeTx and just block until upgradeTx to be resolved like below code
    await upgradeTx.wait();

    return inst;
  };

  type Upgrader = (nextImpl: string, call?: string) => Promise<ethers.TransactionResponse>;

  async function getUpgrader(proxyAddress: string, opts: UpgradeProxyOptions, signer?: Signer): Promise<Upgrader> {
    const { provider } = hre.network;

    const adminAddress = await getAdminAddress(provider, proxyAddress);
    const adminBytecode = await getCode(provider, adminAddress);

    const overrides = opts.txOverrides ? [opts.txOverrides] : [];

    if (isEmptySlot(adminAddress) || adminBytecode === '0x') {
      // No admin contract: use ITransparentUpgradeableProxyFactory to get proxiable interface
      const ITransparentUpgradeableProxyFactory = await getITransparentUpgradeableProxyFactory(hre, signer);
      const proxy = attach(ITransparentUpgradeableProxyFactory, proxyAddress);

      return (nextImpl, call) =>
        call ? proxy.upgradeToAndCall(nextImpl, call, ...overrides) : proxy.upgradeTo(nextImpl, ...overrides);
    } else {
      // Admin contract: redirect upgrade call through it
      const AdminFactory = await getProxyAdminFactory(hre, signer);
      const admin = attach(AdminFactory, adminAddress);

      return (nextImpl, call) =>
        call
          ? admin.upgradeAndCall(proxyAddress, nextImpl, call, ...overrides)
          : admin.upgrade(proxyAddress, nextImpl, ...overrides);
    }
  }
}

function encodeCall(factory: ContractFactory, call: UpgradeProxyOptions['call']): string | undefined {
  if (!call) {
    return undefined;
  }

  if (typeof call === 'string') {
    call = { fn: call };
  }

  return factory.interface.encodeFunctionData(call.fn, call.args ?? []);
}
