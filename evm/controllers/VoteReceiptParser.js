const { ethers } = require('ethers');

const VOTE_EVENT_ABI_BY_TYPE = {
	Uint: 'event Vote(address indexed who, uint indexed value, uint votes, uint total_votes, uint leader, uint leader_total_votes, uint expiry_ts)',
	UintArray: 'event Vote(address indexed who, uint[] value, uint votes, uint total_votes, uint[] leader, uint leader_total_votes, uint expiry_ts)',
	address: 'event Vote(address indexed who, address indexed value, uint votes, uint total_votes, address leader, uint leader_total_votes, uint expiry_ts)',
};

function sameAddress(a, b) {
	return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

function sameUintArray(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	return a.every((value, index) => value.toString() === b[index].toString());
}

function sameVoteValue(type, a, b) {
	if (type === 'address') return sameAddress(a, b);
	if (type === 'UintArray') return sameUintArray(a, b);
	return a !== undefined && b !== undefined && a.toString() === b.toString();
}

function matchesExpectedVote(parsed, contract, expected) {
	if (!expected) return true;
	if (expected.who && !sameAddress(parsed.args.who, expected.who)) return false;
	if (expected.value !== undefined && !sameVoteValue(contract.type, parsed.args.value, expected.value)) return false;
	return true;
}

function parseVoteLogFromReceipt(receipt, contract, expected) {
	if (!receipt || !Array.isArray(receipt.logs)) return null;

	const voteEventAbi = VOTE_EVENT_ABI_BY_TYPE[contract.type];
	if (!voteEventAbi) return null;

	const iface = new ethers.Interface([voteEventAbi]);
	const contractAddress = String(contract.address).toLowerCase();
	for (const log of receipt.logs) {
		if (!log.address || String(log.address).toLowerCase() !== contractAddress) continue;
		let parsed;
		try {
			parsed = iface.parseLog(log);
		} catch (e) {
			continue;
		}
		if (parsed && parsed.name === 'Vote' && matchesExpectedVote(parsed, contract, expected)) {
			return parsed.args;
		}
	}
	return null;
}

module.exports = {
	parseVoteLogFromReceipt,
};
