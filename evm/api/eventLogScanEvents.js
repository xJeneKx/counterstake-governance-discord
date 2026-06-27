const { ethers } = require('ethers');
const { getAbiByType } = require('../abi/getAbiByType');
const DataFetcher = require('../controllers/DataFetcher');
const Formatter = require('../controllers/Formatter');
const sleep = require('../../utils/sleep');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;
const LOG_SCAN_BLOCK_RANGE = 10000;
const SUPPORTED_AA_VERSIONS = ['v1.1', 'v1.2', 'v1.3'];
const EVENT_NAMES_BY_TYPE = {
	governance: ['Deposit', 'Withdrawal'],
	Uint: ['Vote', 'Unvote'],
	UintArray: ['Vote', 'Unvote'],
	address: ['Vote', 'Unvote'],
};

function isEventLogScanSupported(contract) {
	return SUPPORTED_AA_VERSIONS.includes(contract?.meta?.aa_version)
		&& !!EVENT_NAMES_BY_TYPE[contract?.type];
}

function getUnixTimestamp(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	const timestamp = Math.floor(date.getTime() / 1000);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function getErrorMessage(e) {
	return e?.message || e?.code || String(e);
}

async function requestWithRetry(fn, logContext) {
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (e) {
			const status = e.response?.status;
			if (status >= 400 && status < 500 && status !== 429) {
				throw e;
			}
			if (attempt >= DEFAULT_MAX_RETRIES) {
				console.log(`${logContext} failed after ${attempt + 1} attempts`, getErrorMessage(e));
				throw e;
			}
			attempt += 1;
			console.log(`${logContext} retry`, attempt, getErrorMessage(e));
			await sleep(DEFAULT_RETRY_DELAY_MS / 1000);
		}
	}
}

async function getBlockTimestamp(provider, blockNumber, cache) {
	if (!cache.has(blockNumber)) {
		cache.set(blockNumber, requestWithRetry(() => provider.getBlock(blockNumber).then(block => {
			if (!block || !Number.isFinite(Number(block.timestamp))) {
				throw Error(`failed to load block timestamp ${blockNumber}`);
			}
			return Number(block.timestamp);
		}), `event log block timestamp ${blockNumber}`));
	}
	return cache.get(blockNumber);
}

async function getBlockForTimestamp(provider, timestamp) {
	const head = await requestWithRetry(
		() => provider.getBlockNumber(),
		'event log head block'
	);
	let low = 0;
	let high = head;
	const cache = new Map();
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const blockTimestamp = await getBlockTimestamp(provider, mid, cache);
		if (blockTimestamp >= timestamp) high = mid;
		else low = mid + 1;
	}
	return low;
}

async function getStartBlock(provider, fromBlock, options) {
	const timestamp = getUnixTimestamp(options.fromDate);
	if (!timestamp) return fromBlock || 0;
	const cache = options.eventLogTimestampBlockCache || new Map();
	const key = String(timestamp);
	if (!cache.has(key)) cache.set(key, getBlockForTimestamp(provider, timestamp));
	return cache.get(key);
}

function getLogTopics(type, iface) {
	const names = EVENT_NAMES_BY_TYPE[type];
	return names.map(name => iface.getEvent(name).topicHash);
}

function getEventInterface(type) {
	const names = EVENT_NAMES_BY_TYPE[type];
	if (!names) throw Error(`unsupported event log scan contract type ${type}`);
	const abi = getAbiByType(type).filter(fragment => names.some(name => fragment.startsWith(`event ${name}(`)));
	if (abi.length !== names.length) throw Error(`event log ABI mismatch for ${type}`);
	return new ethers.Interface(abi);
}

function getValueForFormat(contract, value) {
	if (contract.type === 'UintArray') return Array.from(value || []).map(v => Number(v));
	return value;
}

async function getTimestamp(log, provider, cache) {
	return getBlockTimestamp(provider, log.blockNumber, cache);
}

function getBaseEvent(contract, log, timestamp) {
	return {
		aa_address: contract.address,
		trigger_unit: log.transactionHash,
		timestamp,
		name: contract.name,
	};
}

async function parseGovernanceLog(contract, parsed, log, provider, blockCache) {
	const event = getBaseEvent(contract, log, await getTimestamp(log, provider, blockCache));
	event.trigger_address = parsed.args.who;
	if (parsed.name === 'Deposit') {
		event.type = 'deposit';
		event.amount = parsed.args.amount.toString();
		return event;
	}
	if (parsed.name === 'Withdrawal') {
		event.type = 'withdraw';
		event.amount = parsed.args.amount.toString();
		return event;
	}
	return null;
}

async function parseVotedValueLog(contract, parsed, log, provider, blockCache) {
	const { type, name, meta } = contract;
	const event = getBaseEvent(contract, log, await getTimestamp(log, provider, blockCache));
	event.trigger_address = parsed.args.who;

	if (parsed.name === 'Vote') {
		event.type = 'added_support';
		event.added_support = parsed.args.votes.toString();
		event.leader_support = parsed.args.leader_total_votes.toString();
		event.leader_value = Formatter.format(name, getValueForFormat(contract, parsed.args.leader), meta);
		event.value = Formatter.format(name, getValueForFormat(contract, parsed.args.value), meta);
		event.support = parsed.args.total_votes.toString();
		return event;
	}

	if (parsed.name === 'Unvote') {
		const c = new ethers.Contract(contract.address, getAbiByType(type), provider);
		const callOptions = { blockTag: log.blockNumber };
		const state = await requestWithRetry(() => (
			type === 'UintArray'
				? DataFetcher.fetchVotedArrayData(c, null, callOptions)
				: DataFetcher.fetchVotedData(c, null, callOptions)
		), `event log state ${meta.network} ${contract.address} ${log.blockNumber}`);
		event.type = 'removed_support';
		event.leader_support = state.leader_support.toString();
		event.leader_value = Formatter.format(name, state.leader_value, meta);
		return event;
	}

	return null;
}

async function getEventLogScanEventsByContract(contracts, provider, fromBlock, options = {}) {
	const eventsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), []]));
	const startBlock = await getStartBlock(provider, fromBlock, options);
	const maxToBlock = Number(options.toBlock);
	if (Number.isFinite(maxToBlock) && startBlock > maxToBlock) {
		return { eventsByAddress, cursorBlock: 0 };
	}

	const toBlock = Number.isFinite(maxToBlock)
		? Math.min(maxToBlock, startBlock + LOG_SCAN_BLOCK_RANGE - 1)
		: startBlock + LOG_SCAN_BLOCK_RANGE - 1;
	const interfacesByType = new Map([...new Set(contracts.map(contract => contract.type))]
		.map(type => [type, getEventInterface(type)]));
	const contractsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), contract]));
	const topics = [...new Set(contracts.flatMap(contract => getLogTopics(contract.type, interfacesByType.get(contract.type))))];
	const logs = await requestWithRetry(() => provider.getLogs({
		address: contracts.map(contract => contract.address),
		fromBlock: startBlock,
		toBlock,
		topics: [topics],
	}), `event logs ${contracts[0]?.meta?.network} ${contracts.length} contracts ${startBlock}-${toBlock}`);
	const blockCache = new Map();

	for (const log of logs) {
		const contract = contractsByAddress.get(String(log.address || '').toLowerCase());
		if (!contract) continue;
		const iface = interfacesByType.get(contract.type);
		let parsed;
		try {
			parsed = iface.parseLog(log);
		} catch (e) {
			continue;
		}
		const event = contract.type === 'governance'
			? await parseGovernanceLog(contract, parsed, log, provider, blockCache)
			: await parseVotedValueLog(contract, parsed, log, provider, blockCache);
		if (event) eventsByAddress.get(contract.address.toLowerCase()).push(event);
	}

	return { eventsByAddress, cursorBlock: toBlock };
}

module.exports = {
	getEventLogScanEventsByContract,
	isEventLogScanSupported,
};
