const {
	createKavaBlockLoader,
	getKavaAddressScanRows,
	getMoralisAddressTransactions,
} = require('./addressScanRequests');

function normalizeBlockNumber(value) {
	const block = Number(value);
	if (!Number.isFinite(block)) {
		throw Error(`bad block number ${value}`);
	}
	return block;
}

function sameAddress(a, b) {
	return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function hasDecodableInput(input) {
	return !!input && input !== '0x';
}

function isPublishableTargetCall(call, address) {
	return sameAddress(call.to_address, address)
		&& hasDecodableInput(call.input)
		&& (call.status === undefined || call.status === null || String(call.status) === '1')
		&& !call.error;
}

function normalizeMoralisTransaction(tx) {
	return {
		hash: tx.hash,
		block_number: normalizeBlockNumber(tx.block_number),
		transaction_index: tx.transaction_index,
		timestamp: tx.block_timestamp,
		from_address: tx.from_address,
		to_address: tx.to_address,
		input: tx.input,
		status: tx.receipt_status ?? tx.status,
	};
}

function isSameTopLevelCall(parentTx, internal) {
	return sameAddress(parentTx.from_address, internal.from)
		&& sameAddress(parentTx.to_address, internal.to)
		&& parentTx.input === internal.input;
}

function getMoralisCallsFromTransaction(rawTx) {
	const transaction = normalizeMoralisTransaction(rawTx);
	const calls = [{
		...transaction,
		internal_transactions: getInternalValues(rawTx.internal_transactions),
	}];

	if (!Array.isArray(rawTx.internal_transactions)) {
		return calls;
	}

	for (const internal of rawTx.internal_transactions) {
		if (isSameTopLevelCall(transaction, internal)) continue;
		const hash = internal.transaction_hash || transaction.hash;
		calls.push({
			hash,
			block_number: normalizeBlockNumber(internal.block_number ?? transaction.block_number),
			transaction_index: transaction.transaction_index,
			timestamp: transaction.timestamp,
			from_address: internal.from || transaction.from_address,
			to_address: internal.to,
			input: internal.input || '0x',
			status: internal.status,
			error: internal.error,
			internal_transactions: [{ value: internal.value }],
		});
	}

	return calls;
}

async function getMoralisTargetAddressScanCalls(chain, address, fromBlock, options) {
	const transactions = await getMoralisAddressTransactions(chain, address, fromBlock, options);
	const calls = transactions.flatMap(getMoralisCallsFromTransaction);
	return getTargetCalls(calls, address);
}

function getInternalValues(rows) {
	return Array.isArray(rows) ? rows.map(row => ({ value: row.value })) : [];
}

function getMintscanExternalCall(row) {
	const hash = row.hash;
	if (!hash) {
		throw Error(`missing Mintscan transaction hash: ${JSON.stringify(row)}`);
	}
	return {
		hash,
		block_number: normalizeBlockNumber(row.blockNumber),
		transaction_index: row.transactionIndex,
		timestamp: row.timestamp ?? null,
		from_address: row.from,
		to_address: row.to,
		input: row.input || '0x',
		status: row.status,
		error: row.error,
		internal_transactions: [],
	};
}

function getMintscanInternalCall(row) {
	const hash = row.hash || null;
	const blockNumber = normalizeBlockNumber(row.blockNumber);

	return {
		hash,
		block_number: blockNumber,
		transaction_index: row.transactionIndex,
		timestamp: row.timestamp ?? null,
		from_address: row.from,
		to_address: row.to,
		input: row.input || '0x',
		status: row.status,
		error: row.error,
		internal_transactions: [{ value: row.value }],
	};
}

async function hydrateKavaCall(call, loadBlock) {
	if (call.hash && call.timestamp) return;
	const blockNumber = Number(call.block_number);
	if (!Number.isFinite(blockNumber)) return;
	const block = await loadBlock(blockNumber);
	if (block && block.timestamp) {
		call.timestamp = block.timestamp;
	}
	if (call.hash || call.transaction_index === undefined || call.transaction_index === null) return;

	const transactionIndex = Number(call.transaction_index);
	const transaction = block && Number.isInteger(transactionIndex)
		? (block.prefetchedTransactions && block.prefetchedTransactions[transactionIndex])
			|| (block.transactions && block.transactions[transactionIndex])
		: null;
	const hash = typeof transaction === 'string' ? transaction : transaction && transaction.hash;
	if (!hash) return;

	call.hash = hash;
}

async function hydrateKavaCalls(calls, provider) {
	const loadBlock = createKavaBlockLoader(provider);
	if (!loadBlock) return;
	for (const call of calls) {
		await hydrateKavaCall(call, loadBlock);
	}
}

async function getKavaTargetAddressScanCalls(address, fromBlock, options) {
	const { transactions, internalTransactions } = await getKavaAddressScanRows(address, fromBlock);
	const calls = [
		...transactions.map(getMintscanExternalCall),
		...internalTransactions.map(getMintscanInternalCall),
	];

	const targetCalls = getTargetCalls(calls, address);
	await hydrateKavaCalls(targetCalls, options.provider);
	return targetCalls;
}

function sortScanCalls(calls) {
	return calls.sort((a, b) => {
		const blockDiff = Number(a.block_number) - Number(b.block_number);
		if (blockDiff) return blockDiff;
		return Number(a.transaction_index ?? 0) - Number(b.transaction_index ?? 0);
	});
}

function getTargetCalls(calls, address) {
	return sortScanCalls(calls.filter(call => isPublishableTargetCall(call, address)));
}

async function getTargetAddressScanCalls(chain, address, fromBlock, options = {}) {
	if (chain === 'Kava') {
		return getKavaTargetAddressScanCalls(address, fromBlock, options);
	}
	return getMoralisTargetAddressScanCalls(chain, address, fromBlock, options);
}

module.exports = {
	getTargetAddressScanCalls,
};
