const { eventsForV1 } = require('../eventsForV1');
const conf = require('ocore/conf');
const mutex = require('ocore/mutex');
const Web3AddressCursors = require('../../db/Web3AddressCursors');
const EventPublisher = require('./EventPublisher');
const {
	getEventLogScanEventsByContract,
	isEventLogScanSupported,
} = require('../api/eventLogScanEvents');
const {
	getSqdTargetCallsByContract,
	isSqdScanSupported,
} = require('../api/sqdScanCalls');
const {
	getSqdLogScanEventsByContract,
	isSqdLogScanSupported,
} = require('../api/sqdLogScanEvents');
const crashOnError = require('../../utils/crashOnError');
const { ethers } = require('ethers');
const { getAbiByType } = require('../abi/getAbiByType');
const DataFetcher = require('./DataFetcher');
const Formatter = require('./Formatter');

const EMPTY_SCAN_LAG_BLOCKS = 1000;
const SCAN_LOCK_PREFIX = 'AddressEventScanner.scanNetwork';

function getScanLock(network) {
	return `${SCAN_LOCK_PREFIX}.${network}`;
}

function getDecodedAmount(data) {
	if (!data) return null;
	if (data.amount !== undefined) return data.amount;
	if (data.length) return data[data.length - 1];
	return null;
}

function getFirstInternalAmount(call) {
	const internal = Array.isArray(call.internal_transactions)
		? call.internal_transactions.find(row => row && row.value !== undefined && row.value !== null)
		: null;
	return internal ? internal.value : null;
}

function getDecodedFrom(data) {
	if (!data) return null;
	return data.from || data[0] || null;
}

function getBlockCallOptions(call) {
	const blockTag = Number(call.block_number);
	return Number.isFinite(blockTag) && blockTag >= 0 ? { blockTag } : undefined;
}

function isHistoricalStateUnavailableError(error) {
	const message = [
		error?.message,
		error?.shortMessage,
		error?.info?.error?.message,
		error?.error?.message,
	].filter(Boolean).join(' ').toLowerCase();
	return message.includes('historical state')
		|| message.includes('missing trie node');
}

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
			const decodedFrom = getDecodedFrom(data);
			const decodedAmount = getDecodedAmount(data);
			if (name.includes('address') && decodedFrom) {
				event.trigger_address = decodedFrom;
			}
			event.type = 'deposit';
			event.amount = decodedAmount?.toString();
			if (!event.amount) {
				console.log('deposit amount not found', meta.network, hash);
				return 'err';
			}
			return event;
		}

		if (name.startsWith('withdraw')) {
			const decodedAmount = getDecodedAmount(data);
			const legacyInternalAmount = meta.aa_version === 'v1' && name === 'withdraw()'
				? getFirstInternalAmount(call)
				: null;
			event.type = 'withdraw';
			event.amount = (decodedAmount ?? legacyInternalAmount)?.toString();
			if (!event.amount) {
				console.log('withdraw amount not found', meta.network, hash);
				return 'err';
			}
			return event;
		}

		if (name === 'voteAndDeposit' || name === 'vote') {
			event.type = 'added_support';
			const callOptions = getBlockCallOptions(call);
			const governance = new ethers.Contract(meta.governance_address, getAbiByType('governance'), this.#providers[network]);
			const c = new ethers.Contract(address, getAbiByType(type), this.#providers[network]);
			const getState = async (options) => {
				const balance = options
					? await governance.balances(from_address, options)
					: await governance.balances(from_address);

				const votedData = type === 'UintArray'
					? await DataFetcher.fetchVotedArrayData(c, data, options)
					: await DataFetcher.fetchVotedData(c, data, options);
				return { balance, ...votedData };
			};
			let state;
			try {
				state = await getState(callOptions);
			} catch (e) {
				if (!callOptions || !isHistoricalStateUnavailableError(e)) {
					throw e;
				}
				console.warn('historical EVM state unavailable, falling back to latest state', meta.network, hash, callOptions.blockTag);
				state = await getState();
			}

			event.added_support = state.balance.toString();
			event.leader_support = state.leader_support.toString();
			event.leader_value = Formatter.format(contractName, state.leader_value, meta);
			event.value = Formatter.format(contractName, state.value, meta);
			event.support = state.support.toString();

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

	#selectCallsToPublish(targetCalls, hasCursor) {
		const callsToPublish = [];
		let cursorBlock = Number(targetCalls.safeCursorBlock) || 0;
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

	async #publishEvents(contract, events) {
		for (const event of events) {
			await EventPublisher.publish(contract.meta, event, 'scan');
		}
	}

	async #saveScanCursor(network, contract, currentCursor, cursorBlock, callsToPublish, firstUnsafeBlock) {
		if (firstUnsafeBlock !== null) {
			const safeCursorBlock = Math.min(cursorBlock, firstUnsafeBlock - 1);
			if (safeCursorBlock > 0) {
				await Web3AddressCursors.setLastBlock(network, contract.address, safeCursorBlock + 1);
				return;
			}
			const currentBlock = Number(currentCursor || 0);
			if (firstUnsafeBlock > currentBlock) {
				await Web3AddressCursors.setLastBlock(network, contract.address, firstUnsafeBlock);
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

	async #scanSqdV1Contracts(network, contracts) {
		const sqdTimestampBlockCache = new Map();
		const groups = new Map();

		for (const contract of contracts) {
			const currentCursor = await Web3AddressCursors.getLastBlock(network, contract.address);
			const hasCursor = currentCursor !== null && currentCursor !== undefined;
			const fromBlock = hasCursor ? currentCursor : 0;
			const key = `${hasCursor ? 'cursor' : 'date'}:${fromBlock}`;
			if (!groups.has(key)) {
				groups.set(key, { contracts: [], currentCursors: new Map(), fromBlock, hasCursor });
			}
			const group = groups.get(key);
			group.contracts.push(contract);
			group.currentCursors.set(contract.address.toLowerCase(), currentCursor);
		}

		for (const group of groups.values()) {
			let fromBlock = group.fromBlock;
			let hasCursor = group.hasCursor;
			let chunkIndex = 1;
			for (;;) {
				const toBlock = await this.#getLaggedHeadCursor(network, fromBlock);
				if (!toBlock) break;
				console.log('address event scan sqd chunk start', network, chunkIndex, `${fromBlock}-${toBlock}`, group.contracts.length, 'contracts');
				const { callsByAddress, safeCursorBlock } = await getSqdTargetCallsByContract(network, group.contracts, fromBlock, {
					fromDate: hasCursor ? null : this.#scanStartDate.toISOString(),
					provider: this.#providers[network],
					toBlock,
					sqdTimestampBlockCache,
				});
				const totalCalls = [...callsByAddress.values()].reduce((sum, calls) => sum + calls.length, 0);
				let canContinue = true;
				for (const contract of group.contracts) {
					const contractAddress = contract.address.toLowerCase();
					const currentCursor = group.currentCursors.get(contractAddress);
					const targetCalls = callsByAddress.get(contractAddress) || [];
					targetCalls.safeCursorBlock = safeCursorBlock;
					const {
						callsToPublish,
						cursorBlock: bootstrapCursorBlock,
						firstInvalidTimestampBlock,
					} = this.#selectCallsToPublish(targetCalls, hasCursor);
					const { cursorBlock, failedBlock } = await this.#publishCalls(network, contract, callsToPublish, bootstrapCursorBlock);
					const unsafeBlocks = [firstInvalidTimestampBlock, failedBlock].filter(v => v !== null && Number.isFinite(v));
					const firstUnsafeBlock = unsafeBlocks.length ? Math.min(...unsafeBlocks) : null;
					await this.#saveScanCursor(network, contract, currentCursor, cursorBlock, callsToPublish, firstUnsafeBlock);
					if (firstUnsafeBlock !== null) canContinue = false;
					else group.currentCursors.set(contractAddress, cursorBlock ? cursorBlock + 1 : currentCursor);
				}
				console.log('address event scan sqd chunk done', network, `${fromBlock}-${safeCursorBlock}`, group.contracts.length, 'contracts', totalCalls, 'calls');
				const nextBlock = Number(safeCursorBlock) + 1;
				if (!canContinue || !Number.isFinite(nextBlock) || nextBlock <= fromBlock) break;
				fromBlock = nextBlock;
				hasCursor = true;
				chunkIndex += 1;
			}
		}
	}

	async #scanEventSourceContracts(network, contracts, sourceName, getEvents) {
		const eventLogTimestampBlockCache = new Map();
		const groups = new Map();

		for (const contract of contracts) {
			const currentCursor = await Web3AddressCursors.getLastBlock(network, contract.address);
			const hasCursor = currentCursor !== null && currentCursor !== undefined;
			const fromBlock = hasCursor ? currentCursor : 0;
			const key = `${hasCursor ? 'cursor' : 'date'}:${fromBlock}`;
			if (!groups.has(key)) {
				groups.set(key, { contracts: [], currentCursors: new Map(), fromBlock, hasCursor });
			}
			const group = groups.get(key);
			group.contracts.push(contract);
			group.currentCursors.set(contract.address.toLowerCase(), currentCursor);
		}

		for (const group of groups.values()) {
			let fromBlock = group.fromBlock;
			let hasCursor = group.hasCursor;
			let chunkIndex = 1;
			for (;;) {
				const toBlock = await this.#getLaggedHeadCursor(network, fromBlock);
				if (!toBlock) break;
				console.log(`address event scan ${sourceName} chunk start`, network, chunkIndex, `${fromBlock}-${toBlock}`, group.contracts.length, 'contracts');
				const { eventsByAddress, cursorBlock } = await getEvents(group.contracts, fromBlock, {
					fromDate: hasCursor ? null : this.#scanStartDate.toISOString(),
					toBlock,
					eventLogTimestampBlockCache,
				});
				const totalEvents = [...eventsByAddress.values()].reduce((sum, events) => sum + events.length, 0);
				for (const contract of group.contracts) {
					const contractAddress = contract.address.toLowerCase();
					const currentCursor = group.currentCursors.get(contractAddress);
					const events = eventsByAddress.get(contractAddress) || [];
					await this.#publishEvents(contract, events);
					await this.#saveScanCursor(network, contract, currentCursor, cursorBlock, events, null);
					group.currentCursors.set(contractAddress, cursorBlock ? cursorBlock + 1 : currentCursor);
				}
				console.log(`address event scan ${sourceName} chunk done`, network, `${fromBlock}-${cursorBlock}`, group.contracts.length, 'contracts', totalEvents, 'events');
				const nextBlock = Number(cursorBlock) + 1;
				if (!Number.isFinite(nextBlock) || nextBlock <= fromBlock) break;
				fromBlock = nextBlock;
				hasCursor = true;
				chunkIndex += 1;
			}
		}
	}

	async #scanEventLogContracts(network, contracts) {
		await this.#scanEventSourceContracts(network, contracts, 'logs', (groupContracts, fromBlock, options) => (
			getEventLogScanEventsByContract(groupContracts, this.#providers[network], fromBlock, {
				...options,
				network,
			})
		));
	}

	async #scanSqdLogContracts(network, contracts) {
		await this.#scanEventSourceContracts(network, contracts, 'sqd logs', (groupContracts, fromBlock, options) => (
			getSqdLogScanEventsByContract(network, groupContracts, this.#providers[network], fromBlock, options)
		));
	}

	async #scanContracts(network, contracts) {
		const sqdLogContracts = contracts.filter(contract => isSqdLogScanSupported(network, contract));
		if (sqdLogContracts.length) {
			await this.#scanSqdLogContracts(network, sqdLogContracts);
		}
		const eventLogContracts = contracts.filter(contract => isEventLogScanSupported(contract) && !isSqdLogScanSupported(network, contract));
		if (eventLogContracts.length) {
			await this.#scanEventLogContracts(network, eventLogContracts);
		}
		const sqdContracts = contracts.filter(contract => !isEventLogScanSupported(contract) && isSqdScanSupported(network, contract));
		if (sqdContracts.length) {
			await this.#scanSqdV1Contracts(network, sqdContracts);
		}
		const unsupportedContracts = contracts.filter(contract => !isSqdLogScanSupported(network, contract) && !isEventLogScanSupported(contract) && !isSqdScanSupported(network, contract));
		if (unsupportedContracts.length) {
			const details = unsupportedContracts
				.map(contract => `${contract.meta?.network || network}:${contract.meta?.aa_version}:${contract.type}:${contract.address}`)
				.join(', ');
			throw Error(`unsupported EVM scanner contract route: ${details}`);
		}
	}

	async scanAllNetworks() {
		console.log('address event scan start', (new Date()).toISOString());
		const networks = Object.keys(this.#contracts)
			.filter(network => this.#contracts[network]?.length);
		await Promise.all(networks.map(network => this.#scanNetwork(network, { skipIfLocked: true })));
		console.log('address event scan done', (new Date()).toISOString());
	}

	async #scanNetwork(network, options = {}) {
		const lockKey = getScanLock(network);
		const unlock = options.skipIfLocked
			? await mutex.lockOrSkip(lockKey)
			: await mutex.lock(lockKey);
		if (!unlock) {
			console.log('address event scan network skipped, already running', network);
			return false;
		}

		try {
			delete this.#headBlockCache[network];
			console.log('address event scan network start', network, (new Date()).toISOString());
			const contracts = this.#contracts[network];
			if (!contracts || !contracts.length) return false;
			await this.#scanContracts(network, contracts);
			console.log('address event scan network done', network, (new Date()).toISOString());
			return true;
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
