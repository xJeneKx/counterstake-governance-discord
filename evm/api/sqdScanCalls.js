const axios = require('axios');
const { eventsForV1 } = require('../eventsForV1');
const sleep = require('../../utils/sleep');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const SQD_SCAN_BLOCK_RANGE = 50000;
const SQD_PORTAL_BASE_URL = 'https://portal.sqd.dev/datasets';

const DATASETS = {
	Ethereum: 'ethereum-mainnet',
	BSC: 'binance-mainnet',
	Polygon: 'polygon-mainnet',
};

function sameAddress(a, b) {
	return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function normalizeBlockNumber(value) {
	const block = Number(value);
	if (!Number.isFinite(block)) {
		throw Error(`bad SQD block number ${value}`);
	}
	return block;
}

function normalizeTransactionIndex(value) {
	const index = Number(value);
	return Number.isFinite(index) ? index : value;
}

function getUnixTimestamp(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	const timestamp = Math.floor(date.getTime() / 1000);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function ensureEventSelectors(type) {
	const meta = eventsForV1[type];
	if (!meta || !Array.isArray(meta.events) || !meta.events.length) {
		return [];
	}
	const selectors = meta.events.map(event => event.sighash).filter(Boolean);
	if (selectors.length !== meta.events.length) {
		throw Error(`v1 event selectors are not initialized for ${type}`);
	}
	return selectors;
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

function getErrorMessage(e) {
	return e?.message || e?.code || String(e);
}

async function getBlockTimestamp(provider, blockNumber) {
	return requestWithRetry(async () => {
		const block = await provider.getBlock(blockNumber);
		if (!block || !Number.isFinite(Number(block.timestamp))) {
			throw Error(`failed to load block timestamp ${blockNumber}`);
		}
		return Number(block.timestamp);
	}, `sqd block timestamp ${blockNumber}`);
}

async function getBlockForTimestamp(provider, timestamp) {
	if (!provider || typeof provider.getBlockNumber !== 'function' || typeof provider.getBlock !== 'function') {
		throw Error('SQD trace scan needs provider.getBlockNumber/getBlock to resolve scan_start_date');
	}
	const head = await requestWithRetry(
		() => provider.getBlockNumber(),
		'sqd head block'
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
	const cache = options.sqdTimestampBlockCache || new Map();
	const key = `${network}:${timestamp}`;
	if (!cache.has(key)) {
		cache.set(key, getBlockForTimestamp(options.provider, timestamp));
	}
	return cache.get(key);
}

function getSqdRequestBody(contracts, fromBlock, toBlock) {
	const selectors = [...new Set(contracts.flatMap(contract => ensureEventSelectors(contract.type)))];
	if (!selectors.length) {
		throw Error('no v1 selectors for SQD scan');
	}
	const body = {
		type: 'evm',
		fromBlock,
		fields: {
			block: {
				number: true,
				timestamp: true,
			},
			transaction: {
				hash: true,
				transactionIndex: true,
			},
			trace: {
				callFrom: true,
				callTo: true,
				callInput: true,
				callValue: true,
				traceAddress: true,
				transactionIndex: true,
				error: true,
				revertReason: true,
			},
		},
		traces: [{
			type: ['call'],
			callTo: contracts.map(contract => contract.address),
			callSighash: selectors,
			transaction: true,
			subtraces: true,
		}],
	};
	if (Number.isFinite(Number(toBlock))) {
		body.toBlock = Number(toBlock);
	}
	return body;
}

function parseSqdBlocks(data) {
	const text = typeof data === 'string' ? data : String(data || '');
	return text.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function getTransactionByIndex(block) {
	const transactions = new Map();
	for (const tx of block.transactions || []) {
		transactions.set(Number(tx.transactionIndex), tx);
	}
	return transactions;
}

function getTraceAddress(trace) {
	return Array.isArray(trace.traceAddress) ? trace.traceAddress : [];
}

function isChildTrace(parent, trace) {
	const parentAddress = getTraceAddress(parent);
	const traceAddress = getTraceAddress(trace);
	return traceAddress.length > parentAddress.length
		&& parentAddress.every((part, index) => traceAddress[index] === part);
}

function getChildInternalValues(traces, parentTrace) {
	return traces
		.filter(trace => isChildTrace(parentTrace, trace))
		.map(trace => trace.action?.value)
		.map(normalizePositiveValue)
		.filter(Boolean)
		.map(value => ({ value }));
}

function normalizePositiveValue(value) {
	if (value === undefined || value === null) return null;
	try {
		const amount = typeof value === 'string' && value.startsWith('0x')
			? BigInt(value)
			: BigInt(String(value));
		return amount > 0n ? amount.toString() : null;
	} catch (e) {
		return null;
	}
}

function hasDecodableInput(input) {
	return !!input && input !== '0x';
}

function isPublishableCall(call) {
	return hasDecodableInput(call.input)
		&& (call.status === undefined || call.status === null || String(call.status) === '1')
		&& !call.error;
}

function normalizeSqdTrace(block, traces, trace, transaction) {
	const action = trace.action || {};
	return {
		hash: transaction && transaction.hash,
		block_number: normalizeBlockNumber(block.header.number),
		transaction_index: normalizeTransactionIndex(trace.transactionIndex ?? transaction?.transactionIndex),
		trace_address: Array.isArray(trace.traceAddress) ? trace.traceAddress.join('.') : trace.traceAddress,
		timestamp: block.header.timestamp,
		from_address: action.from || transaction?.from,
		to_address: action.to,
		input: action.input || '0x',
		status: trace.error || trace.revertReason ? '0' : '1',
		error: trace.error || trace.revertReason,
		internal_transactions: getChildInternalValues(traces, trace),
	};
}

function getCallsFromBlock(block, contractsByAddress) {
	const transactions = getTransactionByIndex(block);
	const calls = [];
	for (const trace of block.traces || []) {
		const action = trace.action || {};
		const contract = contractsByAddress.get(String(action.to || '').toLowerCase());
		if (!contract) continue;
		const tx = transactions.get(Number(trace.transactionIndex));
		const call = normalizeSqdTrace(block, block.traces || [], trace, tx);
		if (isPublishableCall(call)) calls.push({ contract, call });
	}
	return calls;
}

async function getSqdTargetCallsByContract(network, contracts, fromBlock, options = {}) {
	const dataset = DATASETS[network];
	const callsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), []]));
	const startBlock = await getStartBlock(network, fromBlock, options);
	const maxEndBlock = Number(options.toBlock);
	if (Number.isFinite(maxEndBlock) && startBlock > maxEndBlock) {
		return { callsByAddress, safeCursorBlock: 0 };
	}
	const endBlock = Number.isFinite(maxEndBlock)
		? Math.min(maxEndBlock, startBlock + SQD_SCAN_BLOCK_RANGE - 1)
		: startBlock + SQD_SCAN_BLOCK_RANGE - 1;

	let nextBlock = startBlock;
	const contractsByAddress = new Map(contracts.map(contract => [contract.address.toLowerCase(), contract]));
	for (;;) {
		const body = getSqdRequestBody(contracts, nextBlock, endBlock);
		const response = await requestWithRetry(
			() => axios.post(`${SQD_PORTAL_BASE_URL}/${dataset}/stream`, body, {
				headers: { 'Content-Type': 'application/json' },
				responseType: 'text',
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			}),
			`sqd trace calls ${network} ${contracts.length} contracts`
		);
		const blocks = parseSqdBlocks(response.data);
		if (!blocks.length) break;

		let lastBlockNumber = null;
		for (const block of blocks) {
			if (!block.header || block.header.number === undefined) continue;
			lastBlockNumber = normalizeBlockNumber(block.header.number);
			for (const { contract, call } of getCallsFromBlock(block, contractsByAddress)) {
				callsByAddress.get(contract.address.toLowerCase()).push(call);
			}
		}
		if (lastBlockNumber === null) break;
		if (lastBlockNumber >= endBlock) break;
		if (lastBlockNumber < nextBlock) {
			throw Error(`SQD stream did not advance for ${network}: ${lastBlockNumber} < ${nextBlock}`);
		}
		nextBlock = lastBlockNumber + 1;
	}

	return { callsByAddress, safeCursorBlock: endBlock };
}

function isSqdScanSupported(network, contract) {
	return !process.env.testnet
		&& !!DATASETS[network]
		&& contract?.meta?.aa_version === 'v1';
}

module.exports = {
	getSqdTargetCallsByContract,
	isSqdScanSupported,
};
