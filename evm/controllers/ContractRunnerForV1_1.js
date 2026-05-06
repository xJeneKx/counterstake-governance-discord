const conf = require('ocore/conf');
const mutex = require('ocore/mutex');
const { ethers } = require("ethers");

const V1_1 = require('../../db/V1_1');
const { getAbiByType } = require('../abi/getAbiByType');
const governanceHandlers = require('../eventHandlers/governance');
const uintHandlers = require('../eventHandlers/uint');
const uintArrayHandlers = require('../eventHandlers/uintArray');
const addressHandlers = require('../eventHandlers/address');
const { withBoundedRetry } = require('../utils/boundedRetry');

const REPLAY_INTERVAL = 12 * 60 * 60 * 1000;
const MAX_LOG_RANGE_BLOCKS = 5000;
const KAVA_MAX_LOG_RANGE_BLOCKS = 1000;
const KAVA_RPC_TIMEOUT_MS = 60 * 1000;

function isBlockRangeTooLargeError(error) {
	const codes = [
		error?.code,
		error?.error?.code,
	];
	const message = [
		error?.error?.message,
		error?.shortMessage,
		error?.message,
		error,
	]
		.filter(Boolean)
		.join(' ');

	return codes.includes(-32062)
		|| codes.includes(35)
		|| /block range (is )?too large/i.test(message)
		|| /exceed(?:ed|s)? maximum block range/i.test(message)
		|| /ranges? over \d+ blocks? (?:are|is) not supported/i.test(message);
}

class ContractRunnerForV1_1 {
	#contracts = {};
	#providers = {};
	#bootstrapBlocks = {};
	#intervalInitialized = {};
	#pendingReplay = {};

	setProvider(network, provider) {
		this.#providers[network] = provider;
	}

	setContracts(network, contracts) {
		this.#contracts[network] = contracts || [];
		if (!this.#contracts[network].length) {
			return;
		}

		if (!this.#intervalInitialized[network]) {
			setInterval(this.#exec.bind(this, network), REPLAY_INTERVAL);
			this.#intervalInitialized[network] = true;
		}

		this.#exec(network);
	}

	async #exec(network) {
		const unlock = await mutex.lockOrSkip(`ContractRunnerForV1_1.${network}`);
		if (!unlock) {
			this.#pendingReplay[network] = true;
			return;
		}

		let fatalError = null;
		let replayAgain = false;
		try {
			const provider = this.#providers[network];
			const contracts = this.#contracts[network];
			if (provider && contracts && contracts.length) {
				const latestHead = await this.#withNetworkRetry(network, `${network}:getBlockNumber`, () => provider.getBlockNumber());
				for (let i = 0; i < contracts.length; i++) {
					await this.#replayContract(network, provider, contracts[i], latestHead);
				}
			}
		} catch (e) {
			if (isBlockRangeTooLargeError(e)) {
				console.error(`ContractRunnerForV1_1[${network}] retryable replay error:`, e);
			} else {
				console.error(`ContractRunnerForV1_1[${network}] failed:`, e);
				fatalError = e;
			}
		} finally {
			replayAgain = this.#pendingReplay[network];
			this.#pendingReplay[network] = false;
			unlock();
		}

		if (fatalError) {
			throw fatalError;
		}

		if (replayAgain) {
			this.#exec(network);
		}
	}

	async #replayContract(network, provider, contract, latestHead) {
		const cursor = await V1_1.getCursor(network, contract.address);
		const fromBlock = cursor === null
			? await this.#getBootstrapBlock(network, provider, latestHead)
			: cursor + 1;

		if (fromBlock > latestHead) {
			return;
		}

		const c = new ethers.Contract(contract.address, getAbiByType(contract.type), provider);
		const specs = this.#getReplaySpecs(contract, provider);
		const entries = [];

		for (let i = 0; i < specs.length; i++) {
			const spec = specs[i];
			const logs = await this.#queryFilterInChunks(network, c, spec.eventName, fromBlock, latestHead);
			for (let j = 0; j < logs.length; j++) {
				entries.push({
					log: logs[j],
					handle: spec.handle,
				});
			}
		}

		entries.sort((a, b) => {
			if (a.log.blockNumber !== b.log.blockNumber) {
				return a.log.blockNumber - b.log.blockNumber;
			}
			return a.log.index - b.log.index;
		});

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			await entry.handle(entry.log);
		}

		await V1_1.setCursor(network, contract.address, latestHead);
		await V1_1.deleteEventDedupeUpToBlock(network, contract.address, latestHead);
	}

	async #queryFilterInChunks(network, contract, eventName, fromBlock, toBlock) {
		if (fromBlock > toBlock) {
			return [];
		}

		const maxRangeBlocks = this.#getMaxLogRangeBlocks(network);
		if (toBlock - fromBlock + 1 > maxRangeBlocks) {
			const logs = [];
			for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += maxRangeBlocks) {
				const chunkTo = Math.min(chunkFrom + maxRangeBlocks - 1, toBlock);
				logs.push(...await this.#queryFilterInChunks(network, contract, eventName, chunkFrom, chunkTo));
			}
			return logs;
		}

		try {
			return await this.#withNetworkRetry(
				network,
				`${contract.target || contract.address}:${eventName}:${fromBlock}-${toBlock}`,
				() => contract.queryFilter(eventName, fromBlock, toBlock)
			);
		} catch (e) {
			if (!isBlockRangeTooLargeError(e) || fromBlock >= toBlock) {
				throw e;
			}

			const middleBlock = Math.floor((fromBlock + toBlock) / 2);
			const leftLogs = await this.#queryFilterInChunks(network, contract, eventName, fromBlock, middleBlock);
			const rightLogs = await this.#queryFilterInChunks(network, contract, eventName, middleBlock + 1, toBlock);
			return leftLogs.concat(rightLogs);
		}
	}

	#getMaxLogRangeBlocks(network) {
		return network === 'Kava' ? KAVA_MAX_LOG_RANGE_BLOCKS : MAX_LOG_RANGE_BLOCKS;
	}

	#withNetworkRetry(network, label, operation) {
		const options = network === 'Kava'
			? { timeoutMs: KAVA_RPC_TIMEOUT_MS }
			: undefined;
		return withBoundedRetry(label, operation, options);
	}

	#getReplaySpecs(contract, provider) {
		switch (contract.type) {
			case 'governance':
				return [
					{
						eventName: 'Deposit',
						handle: async (log) => governanceHandlers.deposit(contract, ...log.args, log),
					},
					{
						eventName: 'Withdrawal',
						handle: async (log) => governanceHandlers.withdrawal(contract, ...log.args, log),
					},
				];

			case 'Uint':
				return [
					{
						eventName: 'Commit',
						handle: async (log) => uintHandlers.commit(contract, ...log.args, log),
					},
					{
						eventName: 'Vote',
						handle: async (log) => uintHandlers.vote(contract, ...log.args, log),
					},
					{
						eventName: 'Unvote',
						handle: async (log) => uintHandlers.unvote(contract, provider, ...log.args, log),
					},
				];

			case 'UintArray':
				return [
					{
						eventName: 'Commit',
						handle: async (log) => uintArrayHandlers.commit(contract, ...log.args, log),
					},
					{
						eventName: 'Vote',
						handle: async (log) => uintArrayHandlers.vote(contract, ...log.args, log),
					},
					{
						eventName: 'Unvote',
						handle: async (log) => uintArrayHandlers.unvote(contract, provider, ...log.args, log),
					},
				];

			case 'address':
				return [
					{
						eventName: 'Commit',
						handle: async (log) => addressHandlers.commit(contract, ...log.args, log),
					},
					{
						eventName: 'Vote',
						handle: async (log) => addressHandlers.vote(contract, ...log.args, log),
					},
					{
						eventName: 'Unvote',
						handle: async (log) => addressHandlers.unvote(contract, provider, ...log.args, log),
					},
				];
		}

		throw new Error(`Unknown v1_1 contract type ${contract.type}`);
	}

	async #getBootstrapBlock(network, provider, latestHead) {
		if (typeof this.#bootstrapBlocks[network] === 'number') {
			return this.#bootstrapBlocks[network];
		}

		const replayFromDate = conf.v1_1_replay_from_date;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(replayFromDate || '')) {
			throw new Error(`Bad v1_1_replay_from_date: ${replayFromDate}`);
		}

		const targetTimestamp = Math.floor(Date.parse(`${replayFromDate}T00:00:00Z`) / 1000);
		const latestBlock = await this.#withNetworkRetry(network, `${network}:getBlock:${latestHead}`, () => provider.getBlock(latestHead));
		if (latestBlock.timestamp <= targetTimestamp) {
			this.#bootstrapBlocks[network] = latestHead;
			return latestHead;
		}

		let left = 0;
		let right = latestHead;
		let result = latestHead;
		while (left <= right) {
			const middle = Math.floor((left + right) / 2);
			const block = await this.#withNetworkRetry(network, `${network}:getBlock:${middle}`, () => provider.getBlock(middle));
			if (block.timestamp >= targetTimestamp) {
				result = middle;
				right = middle - 1;
			} else {
				left = middle + 1;
			}
		}

		this.#bootstrapBlocks[network] = result;
		return result;
	}
}

module.exports = ContractRunnerForV1_1;
