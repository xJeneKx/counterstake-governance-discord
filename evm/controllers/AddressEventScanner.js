const { eventsForV1 } = require('../eventsForV1');
const conf = require('ocore/conf');
const mutex = require('ocore/mutex');
const Web3AddressCursors = require('../../db/Web3AddressCursors');
const EventPublisher = require('./EventPublisher');
const { getTargetAddressScanCalls } = require('../api/getAddressScanCalls');
const crashOnError = require('../../utils/crashOnError');
const { watchForDeadlock } = require('../../utils/deadlockMonitor');
const { ethers } = require('ethers');
const { getAbiByType } = require('../abi/getAbiByType');
const DataFetcher = require('./DataFetcher');
const Formatter = require('./Formatter');
const { parseVoteLogFromReceipt } = require('./VoteReceiptParser');

const EMPTY_SCAN_LAG_BLOCKS = 1000;
const SCAN_LOCK = 'AddressEventScanner.scanAllNetworks';
const RECEIPT_EVENT_AA_VERSIONS = ['v1.1', 'v1.2'];

watchForDeadlock(SCAN_LOCK);

function getValidScanStartDate(value) {
	const date = new Date(value);
	if (!value || Number.isNaN(date.getTime())) {
		throw Error('scan_start_date is required and must be a valid date');
	}
	return date;
}

function getScanIntervalInHours(value) {
	const normalized = typeof value === 'string'
		? value.trim().replace(/^["'](.+)["']$/, '$1')
		: value;
	const interval = Number(normalized);
	if (Number.isFinite(interval) && interval > 0) {
		return interval;
	}
	console.warn('invalid address_scan_interval_hours, using default 12 hours', value);
	return 12;
}

function normalizeEventTimestamp(value) {
	if (value === null || value === undefined || value === '') return null;

	if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))) {
		const numericTimestamp = Number(value);
		if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) return null;
		return Math.floor(numericTimestamp > 1e12 ? numericTimestamp / 1000 : numericTimestamp);
	}

	const dateTimestamp = Date.parse(value);
	if (Number.isNaN(dateTimestamp)) return null;
	return Math.floor(dateTimestamp / 1000);
}

class AddressEventScanner {
	#contracts = {};
	#providers = {};
	#intervalInHours;
	#intervalInitialized = false;
	#scanStartDate;
	#startupScannedNetworks = new Set();
	#startupScanPromises = {};
	#headBlockCache = {};

	constructor() {
		this.#intervalInHours = getScanIntervalInHours(conf.address_scan_interval_hours || 12);
		this.#scanStartDate = getValidScanStartDate(conf.scan_start_date);
	}

	setProvider(network, provider) {
		this.#providers[network] = provider;
	}

	setContracts(network, contracts) {
		this.#contracts[network] = contracts || [];
	}

	startInterval() {
		if (!this.#intervalInitialized) {
			setInterval(() => {
				this.scanAllNetworks().catch(e => crashOnError('address event scan interval failed', e));
			}, this.#intervalInHours * 60 * 60 * 1000);
			this.#intervalInitialized = true;
		}
	}

	static #findEventFromInput(input, type) {
		const metaForDecode = eventsForV1[type];
		if (!metaForDecode) {
			console.log('type not found', type, input);
			return { metaForDecode: null, event: null };
		}

		const event = metaForDecode.events.find(v => input && input.startsWith(v.sighash));
		if (!event) {
			console.log('event not found', type, input);
			return { metaForDecode, event: null };
		}

		return { metaForDecode, event };
	}

	static #getNameAndDataFromInput(input, type) {
		const { metaForDecode, event } = AddressEventScanner.#findEventFromInput(input, type);
		if (!event) return { name: null, data: null };

		const data = metaForDecode.iface.decodeFunctionData(event.name, input);
		return {
			name: event.name,
			data,
		};
	}

	async #prepareEventFromInput(network, call, contract) {
		const { input, from_address, hash } = call;
		const { type, name: contractName, address, meta } = contract;
		if (!hash) {
			console.log('transaction hash not found for scanned call', meta.network, call.block_number, call.transaction_index);
			return 'err';
		}

		const { name, data } = AddressEventScanner.#getNameAndDataFromInput(input, type);
		if (!name) return null;

		const event = {
			aa_address: address,
			trigger_address: from_address,
			trigger_unit: hash,
			name: contractName,
		};
		const timestamp = normalizeEventTimestamp(call.timestamp);
		if (timestamp) {
			event.timestamp = timestamp;
		}

		if (name.startsWith('deposit')) {
			const internal = call.internal_transactions[0];
			if (!internal) {
				console.log('internal transaction not found(deposit)', meta.network, hash);
				return 'err';
			}
			event.type = 'deposit';
			event.amount = internal.value.toString();
			return event;
		}

		if (name.startsWith('withdraw')) {
			const internal = call.internal_transactions[0];
			if (!internal) {
				console.log('internal transaction not found(withdraw)', meta.network, hash);
				return 'err';
			}
			event.type = 'withdraw';
			event.amount = internal.value.toString();
			return event;
		}

		if (name === 'voteAndDeposit' || name === 'vote') {
			event.type = 'added_support';
			if (RECEIPT_EVENT_AA_VERSIONS.includes(meta.aa_version)) {
				const receipt = await this.#providers[network].getTransactionReceipt(hash);
				const voteLog = parseVoteLogFromReceipt(receipt, contract, { who: from_address, value: data.value });
				if (!voteLog) {
					console.log('vote event log not found', meta.network, hash);
					return 'err';
				}
				event.added_support = voteLog.votes.toString();
				event.leader_support = voteLog.leader_total_votes.toString();
				event.leader_value = Formatter.format(contractName, voteLog.leader, meta);
				event.value = Formatter.format(contractName, voteLog.value, meta);
				event.support = voteLog.total_votes.toString();
			} else {
				const governance = new ethers.Contract(meta.governance_address, getAbiByType('governance'), this.#providers[network]);
				const balance = await governance.balances(from_address);

				const c = new ethers.Contract(address, getAbiByType(type), this.#providers[network]);
				const {
					leader_value,
					leader_support,
					support,
					value,
				} = type === 'UintArray' ? await DataFetcher.fetchVotedArrayData(c, data) : await DataFetcher.fetchVotedData(c, data);

				event.added_support = balance.toString();
				event.leader_support = leader_support.toString();
				event.leader_value = Formatter.format(contractName, leader_value, meta);
				event.value = Formatter.format(contractName, value, meta);
				event.support = support.toString();
			}

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
			event.leader_value = Formatter.format(contractName, leader_value, meta);

			return event;
		}

		return null;
	}

	async #getLaggedHeadCursor(network, currentCursor) {
		const provider = this.#providers[network];
		if (!provider || typeof provider.getBlockNumber !== 'function') {
			return 0;
		}
		if (!this.#headBlockCache[network]) {
			this.#headBlockCache[network] = await provider.getBlockNumber();
		}
		const headBlock = this.#headBlockCache[network];
		const cursor = Math.max(0, Number(headBlock) - EMPTY_SCAN_LAG_BLOCKS);
		if (!Number.isFinite(cursor) || cursor <= Number(currentCursor || 0)) {
			return 0;
		}
		return cursor;
	}

	async #getTargetCalls(network, contract, fromBlock, hasCursor) {
		return getTargetAddressScanCalls(network, contract.address, fromBlock, {
			fromDate: hasCursor ? null : this.#scanStartDate.toISOString(),
			provider: this.#providers[network],
		});
	}

	#selectCallsToPublish(targetCalls, hasCursor) {
		const callsToPublish = [];
		let cursorBlock = 0;
		let firstInvalidTimestampBlock = null;
		for (const call of targetCalls) {
			if (hasCursor) {
				callsToPublish.push(call);
				continue;
			}
			const timestamp = normalizeEventTimestamp(call.timestamp);
			if (!timestamp) {
				const blockNumber = Number(call.block_number);
				if (Number.isFinite(blockNumber)) {
					firstInvalidTimestampBlock = firstInvalidTimestampBlock === null
						? blockNumber
						: Math.min(firstInvalidTimestampBlock, blockNumber);
				}
				continue;
			}
			if (timestamp > Math.floor(this.#scanStartDate.getTime() / 1000)) {
				callsToPublish.push(call);
			} else {
				cursorBlock = Math.max(cursorBlock, Number(call.block_number));
			}
		}
		return { callsToPublish, cursorBlock, firstInvalidTimestampBlock };
	}

	async #publishCalls(network, contract, callsToPublish, cursorBlock) {
		let failedBlock = null;
		for (const call of callsToPublish) {
			const event = await this.#prepareEventFromInput(network, call, contract);
			if (!event) {
				cursorBlock = Math.max(cursorBlock, Number(call.block_number));
				continue;
			}
			if (event === 'err') {
				failedBlock = Number(call.block_number);
				break;
			}
			await EventPublisher.publish(contract.meta, event, 'scan');
			cursorBlock = Math.max(cursorBlock, Number(call.block_number));
		}
		return { cursorBlock, failedBlock };
	}

	async #saveScanCursor(network, contract, currentCursor, cursorBlock, callsToPublish, firstUnsafeBlock) {
		if (firstUnsafeBlock !== null) {
			const safeCursorBlock = Math.min(cursorBlock, firstUnsafeBlock - 1);
			if (safeCursorBlock > 0) {
				await Web3AddressCursors.setLastBlock(network, contract.address, safeCursorBlock + 1);
			}
			return;
		}

		if (!cursorBlock && !callsToPublish.length) {
			const laggedHeadCursor = await this.#getLaggedHeadCursor(network, currentCursor);
			if (laggedHeadCursor) {
				await Web3AddressCursors.setLastBlock(network, contract.address, laggedHeadCursor);
			}
			return;
		}

		if (cursorBlock) {
			await Web3AddressCursors.setLastBlock(network, contract.address, cursorBlock + 1);
		}
	}

	async #scanContract(network, contract) {
		const currentCursor = await Web3AddressCursors.getLastBlock(network, contract.address);
		const hasCursor = currentCursor !== null && currentCursor !== undefined;
		const fromBlock = hasCursor ? currentCursor : 0;
		const targetCalls = await this.#getTargetCalls(network, contract, fromBlock, hasCursor);
		const {
			callsToPublish,
			cursorBlock: bootstrapCursorBlock,
			firstInvalidTimestampBlock,
		} = this.#selectCallsToPublish(targetCalls, hasCursor);
		const { cursorBlock, failedBlock } = await this.#publishCalls(network, contract, callsToPublish, bootstrapCursorBlock);
		const unsafeBlocks = [firstInvalidTimestampBlock, failedBlock].filter(v => v !== null && Number.isFinite(v));
		const firstUnsafeBlock = unsafeBlocks.length ? Math.min(...unsafeBlocks) : null;
		await this.#saveScanCursor(network, contract, currentCursor, cursorBlock, callsToPublish, firstUnsafeBlock);
	}

	async scanAllNetworks() {
		const unlock = await mutex.lockOrSkip(SCAN_LOCK);
		if (!unlock) return;

		try {
			this.#headBlockCache = {};
			console.log('address event scan start', (new Date()).toISOString());
			for (const network of Object.keys(this.#contracts)) {
				const contracts = this.#contracts[network];
				if (!contracts || !contracts.length) continue;
				for (const contract of contracts) {
					await this.#scanContract(network, contract);
				}
			}
			console.log('address event scan done', (new Date()).toISOString());
		} finally {
			unlock();
		}
	}

	async #scanNetwork(network) {
		const unlock = await mutex.lock(SCAN_LOCK);

		try {
			delete this.#headBlockCache[network];
			console.log('address event scan network start', network, (new Date()).toISOString());
			const contracts = this.#contracts[network];
			if (!contracts || !contracts.length) return;
			for (const contract of contracts) {
				await this.#scanContract(network, contract);
			}
			console.log('address event scan network done', network, (new Date()).toISOString());
		} finally {
			unlock();
		}
	}

	async scanNetworkOnce(network) {
		if (this.#startupScannedNetworks.has(network)) return true;
		if (this.#startupScanPromises[network]) return this.#startupScanPromises[network];

		this.#startupScanPromises[network] = (async () => {
			if (this.#startupScannedNetworks.has(network)) return true;
			const contracts = this.#contracts[network];
			if (!contracts || !contracts.length) return false;
			await this.#scanNetwork(network);
			this.#startupScannedNetworks.add(network);
			return true;
		})();

		try {
			return await this.#startupScanPromises[network];
		} finally {
			delete this.#startupScanPromises[network];
		}
	}
}

module.exports = AddressEventScanner;
