const axios = require('axios');
const { ethers } = require('ethers');
const { getAbiByType } = require('../abi/getAbiByType');
const DataFetcher = require('../controllers/DataFetcher');
const Formatter = require('../controllers/Formatter');
const sleep = require('../../utils/sleep');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const SQD_LOG_SCAN_BLOCK_RANGE = 50000;
const SQD_PORTAL_BASE_URL = 'https://portal.sqd.dev/datasets';
const DATASETS = {
	Ethereum: 'ethereum-mainnet',
	BSC: 'binance-mainnet',
	Polygon: 'polygon-mainnet',
};
const SUPPORTED_AA_VERSIONS = ['v1.1', 'v1.2', 'v1.3'];
const EVENT_NAMES_BY_TYPE = {
	governance: ['Deposit', 'Withdrawal'],
	Uint: ['Vote', 'Unvote'],
	UintArray: ['Vote', 'Unvote'],
	address: ['Vote', 'Unvote'],
};

function isSqdLogScanSupported(network, contract) {
	return !process.env.testnet
		&& !!DATASETS[network]
		&& SUPPORTED_AA_VERSIONS.includes(contract?.meta?.aa_version)
		&& !!EVENT_NAMES_BY_TYPE[contract?.type];
}

function getErrorMessage(e) {
	return e?.message || e?.code || String(e);
}

function getUnixTimestamp(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	const timestamp = Math.floor(date.getTime() / 1000);
	return Number.isFinite(timestamp) ? timestamp : null;
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

async function getBlockTimestamp(provider, blockNumber) {
	return requestWithRetry(async () => {
		const block = await provider.getBlock(blockNumber);
		if (!block || !Number.isFinite(Number(block.timestamp))) {
			throw Error(`failed to load SQD log block timestamp ${blockNumber}`);
		}
		return Number(block.timestamp);
	}, `SQD log block timestamp ${blockNumber}`);
}

async function getBlockForTimestamp(provider, timestamp) {
	if (!provider || typeof provider.getBlockNumber !== 'function' || typeof provider.getBlock !== 'function') {
		throw Error('SQD log scan needs provider.getBlockNumber/getBlock to resolve scan_start_date');
	}
	const head = await requestWithRetry(
		() => provider.getBlockNumber(),
		'SQD log head block'
	);
	let low = 0;
	let high = head;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const blockTimestamp = await getBlockTimestamp(provider, mid);
		if (blockTimestamp >= timestamp) high = mid;
		else low = mid + 1;
	}
	return low;
}

async function getStartBlock(network, fromBlock, options) {
	const timestamp = getUnixTimestamp(options.fromDate);
	if (!timestamp) return fromBlock || 0;
	const cache = options.sqdLogTimestampBlockCache || options.eventLogTimestampBlockCache || new Map();
	const key = `${network}:${timestamp}`;
	if (!cache.has(key)) {
		cache.set(key, getBlockForTimestamp(options.provider, timestamp));
	}
	return cache.get(key);
}

function parseSqdBlocks(data) {
	const text = typeof data === 'string' ? data : String(data || '');
	return text.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function getEventInterface(type) {
	const names = EVENT_NAMES_BY_TYPE[type];
	if (!names) throw Error(`unsupported SQD log scan contract type ${type}`);
	const abi = getAbiByType(type).filter(fragment => names.some(name => fragment.startsWith(`event ${name}(`)));
	if (abi.length !== names.length) throw Error(`SQD log ABI mismatch for ${type}`);
	return new ethers.Interface(abi);
}

function getLogTopics(type, iface) {
	return EVENT_NAMES_BY_TYPE[type].map(name => iface.getEvent(name).topicHash);
}

function getSqdLogsRequestBody(contracts, fromBlock, toBlock) {
	const interfacesByType = new Map([...new Set(contracts.map(contract => contract.type))]
		.map(type => [type, getEventInterface(type)]));
	const topics = [...new Set(contracts.flatMap(contract => getLogTopics(contract.type, interfacesByType.get(contract.type))))];
	if (!topics.length) throw Error('no event topics for SQD log scan');
	return {
		type: 'evm',
		fromBlock,
		toBlock,
		fields: {
			block: {
				number: true,
				timestamp: true,
			},
			transaction: {
				hash: true,
				transactionIndex: true,
			},
			log: {
				address: true,
				topics: true,
				data: true,
				logIndex: true,
				transactionIndex: true,
			},
		},
		logs: [{
			address: contracts.map(contract => contract.address),
			topic0: topics,
			transaction: true,
		}],
	};
}

function getValueForFormat(contract, value) {
	if (contract.type === 'UintArray') return Array.from(value || []).map(v => Number(v));
	return value;
}

function getBaseEvent(contract, block, transaction) {
	if (!transaction?.hash) {
		throw Error(`SQD log transaction hash not found ${contract.meta.network} ${contract.address} ${block.header.number}`);
	}
	const timestamp = getUnixTimestamp(block.header.timestamp);
	if (!timestamp) {
		throw Error(`SQD log timestamp not found ${contract.meta.network} ${contract.address} ${block.header.number}`);
	}
	return {
		aa_address: contract.address,
		trigger_unit: transaction.hash,
		timestamp,
		name: contract.name,
	};
}

function parseGovernanceLog(contract, parsed, block, transaction) {
	const event = getBaseEvent(contract, block, transaction);
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

async function parseVotedValueLog(contract, parsed, block, transaction, provider) {
	const { type, name, meta } = contract;
	const event = getBaseEvent(contract, block, transaction);
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
		const callOptions = { blockTag: Number(block.header.number) };
		const state = await requestWithRetry(() => (
			type === 'UintArray'
				? DataFetcher.fetchVotedArrayData(c, null, callOptions)
				: DataFetcher.fetchVotedData(c, null, callOptions)
		), `SQD log state ${meta.network} ${contract.address} ${block.header.number}`);
		event.type = 'removed_support';
		event.leader_support = state.leader_support.toString();
		event.leader_value = Formatter.format(name, state.leader_value, meta);
		return event;
	}

	return null;
}

function getTransactionByIndex(block) {
	const transactions = new Map();
	for (const tx of block.transactions || []) {
		transactions.set(Number(tx.transactionIndex), tx);
	}
	return transactions;
}

async function getSqdLogScanEventsByContract(network, contracts, provider, fromBlock, options = {}) {
	const dataset = DATASETS[network];
	if (!dataset) throw Error(`SQD log scan dataset not found for ${network}`);
	const eventsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), []]));
	const startBlock = await getStartBlock(network, fromBlock, { ...options, provider });
	const maxToBlock = Number(options.toBlock);
	if (Number.isFinite(maxToBlock) && startBlock > maxToBlock) {
		return { eventsByAddress, cursorBlock: 0 };
	}
	const toBlock = Number.isFinite(maxToBlock)
		? Math.min(maxToBlock, startBlock + SQD_LOG_SCAN_BLOCK_RANGE - 1)
		: startBlock + SQD_LOG_SCAN_BLOCK_RANGE - 1;

	const body = getSqdLogsRequestBody(contracts, startBlock, toBlock);
	const response = await requestWithRetry(
		() => axios.post(`${SQD_PORTAL_BASE_URL}/${dataset}/stream`, body, {
			headers: { 'Content-Type': 'application/json' },
			responseType: 'text',
			timeout: DEFAULT_REQUEST_TIMEOUT_MS,
		}),
		`SQD event logs ${network} ${contracts.length} contracts ${startBlock}-${toBlock}`
	);
	const blocks = parseSqdBlocks(response.data);
	const contractsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), contract]));
	const interfacesByType = new Map([...new Set(contracts.map(contract => contract.type))]
		.map(type => [type, getEventInterface(type)]));

	for (const block of blocks) {
		const transactions = getTransactionByIndex(block);
		for (const log of block.logs || []) {
			const contract = contractsByAddress.get(String(log.address || '').toLowerCase());
			if (!contract) continue;
			const iface = interfacesByType.get(contract.type);
			let parsed;
			try {
				parsed = iface.parseLog(log);
			} catch (e) {
				continue;
			}
			const transaction = transactions.get(Number(log.transactionIndex));
			const event = contract.type === 'governance'
				? parseGovernanceLog(contract, parsed, block, transaction)
				: await parseVotedValueLog(contract, parsed, block, transaction, provider);
			if (event) eventsByAddress.get(contract.address.toLowerCase()).push(event);
		}
	}

	return { eventsByAddress, cursorBlock: toBlock };
}

module.exports = {
	getSqdLogScanEventsByContract,
	isSqdLogScanSupported,
};
