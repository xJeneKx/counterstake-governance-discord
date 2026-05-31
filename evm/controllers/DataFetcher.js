const { ethers } = require("ethers");

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

class DataFetcher {
	static async fetchVotedData(contract, data) {
		const leader_value = await contract.leader();
		const leader_support = await contract.votesByValue(leader_value);
		let support = null;
		let value = null;
		if (data) {
			support = await contract.votesByValue(data.value);
			value = data.value.toString();
		}
		return {
			leader_value: leader_value.toString(),
			leader_support,
			support,
			value,
		};
	}

	static async fetchVotedArrayData(contract, data) {
		let leader_value = [];
		for (let i = 0; ; i++) {
			try {
				leader_value.push(await contract.leader(i));
			} catch (e) {
				if (!isArrayOutOfBoundsError(e, i)) {
					throw e;
				}
				break;
			}
		}
		const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint[]'], [leader_value]);
		const leader_support = await contract.votesByValue(ethers.keccak256(encoded));

		let support = null;
		let value = null;
		if (data) {
			const dataEncoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint[]'], [data.value]);
			support = await contract.votesByValue(ethers.keccak256(dataEncoded));
			value = data.value.map(v => Number(v));
		}

		return {
			leader_value: leader_value.map(v => Number(v)),
			leader_support,
			support,
			value,
		}
	}
}

module.exports = DataFetcher;
