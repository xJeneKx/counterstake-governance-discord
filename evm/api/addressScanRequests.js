const axios = require('axios');
const sleep = require('../../utils/sleep');

const MORALIS_LIMIT = 100;
const MINTSCAN_OFFSET = 100;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2000;

function getMoralisChainName(chain) {
	switch (chain) {
		case 'Ethereum':
			return process.env.testnet ? 'sepolia' : 'eth';
		case 'BSC':
			return process.env.testnet ? 'bsc testnet' : 'bsc';
		case 'Polygon':
			return process.env.testnet ? 'polygon amoy' : 'polygon';
	}
	throw Error(`unknown Moralis chain ${chain}`);
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
				console.log(`${logContext} failed after ${attempt + 1} attempts`, e.message || e);
				throw e;
			}
			attempt += 1;
			console.log(`${logContext} retry`, attempt, e.message || e);
			await sleep(DEFAULT_RETRY_DELAY_MS / 1000);
		}
	}
}

function getMoralisUrl(chain, address, fromBlock, cursor, options) {
	const params = new URLSearchParams({
		chain: getMoralisChainName(chain),
		order: 'ASC',
		limit: String(MORALIS_LIMIT),
		include: 'internal_transactions',
	});
	if (options.fromDate) {
		params.set('from_date', options.fromDate);
	} else {
		params.set('from_block', String(fromBlock || 0));
	}
	if (cursor) {
		params.set('cursor', cursor);
	}
	return `https://deep-index.moralis.io/api/v2.2/${address}?${params.toString()}`;
}

async function getMoralisAddressTransactions(chain, address, fromBlock, options = {}) {
	let cursor = null;
	const transactions = [];
	const seenCursors = new Set();

	do {
		const url = getMoralisUrl(chain, address, fromBlock, cursor, options);
		const response = await requestWithRetry(
			() => axios.get(url, { headers: { 'X-API-Key': process.env.moralis_api_key } }),
			`moralis address transactions ${chain} ${address}`
		);
		if (!Array.isArray(response.data?.result)) {
			throw Error(`bad response from Moralis for ${chain} ${address}: ${JSON.stringify(response.data)}`);
		}
		transactions.push(...response.data.result);
		cursor = response.data.cursor || null;
		if (cursor) {
			if (seenCursors.has(cursor)) {
				throw Error(`repeated Moralis cursor for ${chain} ${address}: ${cursor}`);
			}
			seenCursors.add(cursor);
		}
	} while (cursor);

	return transactions;
}

function getMintscanData(response) {
	if (Array.isArray(response.data)) return response.data;
	throw Error(`bad response from Mintscan: ${JSON.stringify(response.data)}`);
}

function getMintscanUrl(path, address, fromBlock, page) {
	const params = new URLSearchParams({
		address,
		page: String(page),
		offset: String(MINTSCAN_OFFSET),
		sort: 'asc',
		start_block: String(fromBlock || 1),
	});
	return `https://apis.mintscan.io/v1/evm/kava/${path}?${params.toString()}`;
}

async function getMintscanPages(path, address, fromBlock) {
	const rows = [];
	let page = 1;

	for (;;) {
		const url = getMintscanUrl(path, address, fromBlock, page);
		const response = await requestWithRetry(
			() => axios.get(url, { headers: { Authorization: `Bearer ${process.env.mintscan_api_key}` } }),
			`mintscan ${path} ${address}`
		);
		const data = getMintscanData(response);
		rows.push(...data);
		if (data.length < MINTSCAN_OFFSET) {
			break;
		}
		page += 1;
	}

	return rows;
}

async function getKavaAddressScanRows(address, fromBlock) {
	const [transactions, internalTransactions] = await Promise.all([
		getMintscanPages('account/tx', address, fromBlock),
		getMintscanPages('account/internal-tx', address, fromBlock),
	]);
	return { transactions, internalTransactions };
}

function createKavaBlockLoader(provider) {
	if (!provider || typeof provider.getBlock !== 'function') return null;

	const blockPromises = new Map();
	return (blockNumber) => {
		if (!blockPromises.has(blockNumber)) {
			blockPromises.set(blockNumber, provider.getBlock(blockNumber, true));
		}
		return blockPromises.get(blockNumber);
	};
}

module.exports = {
	createKavaBlockLoader,
	getKavaAddressScanRows,
	getMoralisAddressTransactions,
};
