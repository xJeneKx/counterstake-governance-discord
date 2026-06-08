const ARRAY_OUT_OF_BOUNDS_PANIC_CODE = 0x32n;

function isArrayOutOfBoundsError(error, index) {
	const panicCode = error?.revert?.args?.[0];
	if (error?.revert?.name === 'Panic'
		&& panicCode !== undefined
		&& BigInt(panicCode) === ARRAY_OUT_OF_BOUNDS_PANIC_CODE) {
		return true;
	}
	return index > 0
		&& error?.code === 'CALL_EXCEPTION'
		&& error?.action === 'call'
		&& error?.data === '0x'
		&& error?.reason === 'require(false)'
		&& error?.invocation?.method === 'leader'
		&& error?.invocation?.signature === 'leader(uint256)';
}

function toPlainArray(value) {
	return Array.from(value || []);
}

function callWithOptions(contract, method, args, callOptions) {
	return callOptions
		? contract[method](...args, callOptions)
		: contract[method](...args);
}

class DataFetcher {
	static async fetchVotedData(contract, data, callOptions) {
		const leader_value = await callWithOptions(contract, 'leader', [], callOptions);
		const leader_support = await callWithOptions(contract, 'votesByValue', [leader_value], callOptions);
		let support = null;
		let value = null;
		if (data) {
			support = await callWithOptions(contract, 'votesByValue', [data.value], callOptions);
			value = data.value.toString();
		}
		return {
			leader_value: leader_value.toString(),
			leader_support,
			support,
			value,
		};
	}

	static async fetchVotedArrayData(contract, data, callOptions) {
		let leader_value = [];
		for (let i = 0; ; i++) {
			try {
				leader_value.push(await callWithOptions(contract, 'leader', [i], callOptions));
			} catch (e) {
				if (!isArrayOutOfBoundsError(e, i)) {
					throw e;
				}
				break;
			}
		}
		const leaderArray = toPlainArray(leader_value);
		const leaderKey = await callWithOptions(contract, 'getKey', [leaderArray], callOptions);
		const leader_support = await callWithOptions(contract, 'votesByValue', [leaderKey], callOptions);

		let support = null;
		let value = null;
		if (data) {
			const dataValue = toPlainArray(data.value);
			const dataKey = await callWithOptions(contract, 'getKey', [dataValue], callOptions);
			support = await callWithOptions(contract, 'votesByValue', [dataKey], callOptions);
			value = dataValue.map(v => Number(v));
		}

		return {
			leader_value: leaderArray.map(v => Number(v)),
			leader_support,
			support,
			value,
		};
	}
}

module.exports = DataFetcher;
