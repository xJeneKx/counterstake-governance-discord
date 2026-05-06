const mutex = require('ocore/mutex');
const { ethers } = require("ethers");

const sleep = require('../../utils/sleep')
const Web3_addresses = require('../../db/Web3_addresses');
const V1EventDedupe = require('../../db/V1EventDedupe');
const { getAbiByType } = require('../abi/getAbiByType');
const { getAddressTransactions } = require('../api/getAddressTransactions');
const {
	extractContractCallCandidatesFromMoralisTransaction,
	selectFirstSuccessfulInternalTransaction,
} = require('../api/moralis');
const { eventsForV1 } = require('../eventsForV1');
const DataFetcher = require('./DataFetcher');
const Formatter = require('./Formatter');
const Discord = require("./Discord");

const EMPTY_RESULT_CURSOR_LAG_BLOCKS = 1000;

function getEmptyResultCursorBlock(lastBlock, latestBlock) {
	if (lastBlock === undefined || lastBlock === null || latestBlock === undefined || latestBlock === null)
		return null;
	if (!Number.isFinite(Number(lastBlock)) || !Number.isFinite(Number(latestBlock)))
		return null;

	const safeBlock = Math.max(0, Number(latestBlock) - EMPTY_RESULT_CURSOR_LAG_BLOCKS);
	if (safeBlock <= Number(lastBlock))
		return null;

	return safeBlock;
}

function getContractPollingKey(contract) {
	return [
		(contract?.address || '').toLowerCase(),
		contract?.type || '',
		contract?.name || '',
	].join(':');
}

function dedupeContractsForV1Polling(contracts = []) {
	const seen = new Set();
	return contracts.filter((contract) => {
		const key = getContractPollingKey(contract);
		if (seen.has(key))
			return false;

		seen.add(key);
		return true;
	});
}

function getLastFullyProcessedBlock(transactions, processedCount) {
	if (!processedCount)
		return null;

	let lastFullyProcessedBlock = null;
	let index = 0;

	while (index < processedCount) {
		const blockNumber = Number(transactions[index]?.block_number);
		if (!Number.isFinite(blockNumber))
			return lastFullyProcessedBlock;

		let nextIndex = index + 1;
		while (nextIndex < transactions.length && Number(transactions[nextIndex]?.block_number) === blockNumber)
			nextIndex++;

		if (nextIndex > processedCount)
			return lastFullyProcessedBlock;

		lastFullyProcessedBlock = blockNumber;
		index = nextIndex;
	}

	return lastFullyProcessedBlock;
}

class ContractRunnerForV1 {
	#contracts = {};
	#providers = {};
	#intervalInMinutes;
	#intervalInitialized = false;

	constructor(intervalInMinutes = 30) {
		this.#intervalInMinutes = intervalInMinutes;
	}

	static #getNameAndDataFromInput(input, type, { quiet = false } = {}) {
		const metaForDecode = eventsForV1[type];
		if (!metaForDecode) {
			if (!quiet)
				console.log('type not found', type, input);
			return { name: null, data: null };
		}

		if (!input || typeof input !== 'string') {
			if (!quiet)
				console.log('input not found', type, input);
			return { name: null, data: null };
		}

		const event = metaForDecode.events.find(v => input.startsWith(v.sighash));
		if (!event) {
			if (!quiet)
				console.log('event not found', type, input);
			return { name: null, data: null };
		}

		const data = metaForDecode.iface.decodeFunctionData(event.name, input);
		return {
			name: event.name,
			data,
		}
	}

	setProvider(name, provider) {
		this.#providers[name] = provider;
	}

	setContracts(network, contracts) {
		this.#contracts[network] = dedupeContractsForV1Polling(contracts);
		this.#delayedExec();
	}

	#scheduleExec() {
		this.#exec().catch((error) => {
			console.error('[ContractRunnerForV1] scheduled execution failed', error);
		});
	}

	async #delayedExec(timeInSeconds = 30) {
		const unlock = await mutex.lockOrSkip('ContractManagerOfV1.delayedExec');
		if (!unlock) {
			return;
		}

		await sleep(timeInSeconds);
		this.#scheduleExec();

		if (!this.#intervalInitialized) {
			setInterval(() => {
				this.#scheduleExec();
			}, this.#intervalInMinutes * 60 * 1000);
			this.#intervalInitialized = true;
		}

		unlock();
	}

	async #getTransactions(chain, address, lastBlock, r = 0) {
		try {
			return await getAddressTransactions(chain, address, lastBlock);
		} catch (e) {
			console.log('getTransactions error:', e);
			if (!r || r <= 2) {
				console.log('repeat getTransactions', chain, address, lastBlock, r);
				await sleep(2);
				return this.#getTransactions(chain, address, lastBlock, !r ? 1 : ++r);
			}
			throw e;
		}
	}

	#getContractCallCandidates(transaction, contract) {
		return extractContractCallCandidatesFromMoralisTransaction(transaction, contract.address)
			.map((candidate) => {
				const { name, data } = ContractRunnerForV1.#getNameAndDataFromInput(candidate.input, contract.type, { quiet: true });
				if (!name)
					return null;

				return {
					...candidate,
					decoded_name: name,
					decoded_data: data,
				};
			})
			.filter(Boolean);
	}

	async #prepareEventFromInput(network, candidate, contract) {
		const { from_address, hash, decoded_name: name, decoded_data: data } = candidate;
		const { type, name: contract_name, address, meta } = contract;

		if (!name) return;

		let event = {
			aa_address: address,
			trigger_address: from_address,
			trigger_unit: hash,
			name: contract_name,
		}

		if (name.startsWith('deposit')) {
			const transfer = selectFirstSuccessfulInternalTransaction(candidate.parent_transaction?.internal_transactions);
			if (!transfer) {
				console.log('transactions not found(deposit)', meta.network, hash);
				return 'err';
			}

			event.type = 'deposit';
			event.amount = transfer.value.toString();

			return event;
		}

		if (name.startsWith("withdraw")) {
			const transfer = selectFirstSuccessfulInternalTransaction(candidate.parent_transaction?.internal_transactions);
			if (!transfer) {
				console.log('transactions not found(withdraw)', meta.network, hash);
				return 'err';
			}

			event.type = 'withdraw';
			event.amount = transfer.value.toString();

			return event;
		}

		if (name === "voteAndDeposit" || name === "vote") {
			const governance = new ethers.Contract(meta.governance_address, getAbiByType('governance'), this.#providers[network]);
			const balance = await governance.balances(from_address);

			const c = new ethers.Contract(address, getAbiByType(type), this.#providers[network]);
			const {
				leader_value,
				leader_support,
				support,
				value,
			} = type === 'UintArray' ? await DataFetcher.fetchVotedArrayData(c, data) : await DataFetcher.fetchVotedData(c, data);

			event.type = "added_support";
			event.added_support = balance.toString();
			event.leader_support = leader_support.toString();
			event.leader_value = Formatter.format(contract_name, leader_value, meta);
			event.value = Formatter.format(contract_name, value, meta);
			event.support = support.toString();

			return event;
		}

		if (name === 'unvote') {
			const c = new ethers.Contract(address, getAbiByType(type), this.#providers[network]);
			const {
				leader_value,
				leader_support,
			} = type === 'UintArray' ? await DataFetcher.fetchVotedArrayData(c) : await DataFetcher.fetchVotedData(c);
			event.type = 'removed_support';
			event.leader_support = leader_support.toString();
			event.leader_value = Formatter.format(contract_name, leader_value, meta);

			return event;
		}
	}

	async #exec() {
		const unlock = await mutex.lockOrSkip('ContractManagerOfV1.exec');
		if (!unlock) {
			return;
		}

		try {
			console.log('exec start', (new Date()).toISOString());
			for (let network in this.#contracts) {
				const c = this.#contracts[network];
				if (!c || !c.length) continue;
				let latestBlockForEmptyResult = null;

				for (let i = 0; i < c.length; i++) {
					const contract = c[i];
					const meta = contract.meta;
					const lastBlock = await Web3_addresses.getLastBlockByAddress(network, contract.address);

					console.log('contract v1: ', contract.address);
					const transactions = await this.#getTransactions(network, contract.address, lastBlock);
					console.log('transactions:', transactions.length);

					if (!transactions.length) {
						if (latestBlockForEmptyResult === null && this.#providers[network]) {
							try {
								latestBlockForEmptyResult = await this.#providers[network].getBlockNumber();
							} catch (e) {
								console.error('failed to get latest block for empty v1 result', network, e);
								latestBlockForEmptyResult = undefined;
							}
						}

						const emptyResultCursorBlock = getEmptyResultCursorBlock(lastBlock, latestBlockForEmptyResult);
						if (emptyResultCursorBlock !== null) {
							console.log('set last checked block', emptyResultCursorBlock);
							await Web3_addresses.setLastBlockByAddress(network, contract.address, emptyResultCursorBlock);
						} else {
							console.log('number of the last block has not been changed');
						}
					} else {
						let processedCount = 0;
						for (let j = 0; j < transactions.length; j++) {
							const transaction = transactions[j];
							const candidates = this.#getContractCallCandidates(transaction, contract);
							let failed = false;

							for (let k = 0; k < candidates.length; k++) {
								const candidate = candidates[k];
								const event = await this.#prepareEventFromInput(network, candidate, contract);
								console.log('event:', event, candidate.hash, candidate.candidate_key);
								if (!event) continue;
								if (event === 'err') {
									failed = true;
									break;
								}

								const accepted = await V1EventDedupe.claim(
									meta.network,
									contract.address,
									candidate.hash,
									candidate.candidate_key,
									event.type
								);
								if (!accepted) {
									console.log('skip duplicate v1 event', contract.address, candidate.hash, candidate.candidate_key);
									continue;
								}

								Discord.announceEvent(meta, event);
							}

							if (failed) {
								break;
							}

							processedCount++;
						}

						const lastFullyProcessedBlock = getLastFullyProcessedBlock(transactions, processedCount);
						if (lastFullyProcessedBlock !== null) {
							console.log('set new last block', Number(lastFullyProcessedBlock) + 1);
							await Web3_addresses.setLastBlockByAddress(network, contract.address, Number(lastFullyProcessedBlock) + 1);
						} else {
							console.log('number of the last block has not been changed');
						}
					}
					console.log('contract v1 done');
					await sleep(2);
				}
			}
			console.log('exec done', (new Date()).toISOString());
		} finally {
			unlock();
		}
	}
}


module.exports = ContractRunnerForV1;
