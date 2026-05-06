const { ethers } = require("ethers");

const { getAbiByType } = require("../abi/getAbiByType");
const DataFetcher = require("../controllers/DataFetcher");
const Formatter = require('../controllers/Formatter');
const V1_1EventProcessor = require("../controllers/V1_1EventProcessor");

// (address indexed who, uint indexed value, uint votes, uint total_votes, uint leader, uint leader_total_votes, uint expiry_ts)
async function vote(contract, who, value, votes, total_votes, leader, leader_total_votes, expiry_ts, transaction) {
	const { name: contract_name, address, meta } = contract;
	const log = V1_1EventProcessor.getLog(transaction);
	const event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: log?.transactionHash,
		added_support: votes.toString(),
		name: contract_name,
		type: 'added_support',
		leader_support: leader_total_votes.toString(),
		leader_value: Formatter.format(contract_name, leader, meta),
		value: Formatter.format(contract_name, value, meta),
		support: total_votes.toString(),
	}

	await V1_1EventProcessor.announce(contract, transaction, event);
}

// (address indexed who, uint indexed value)
async function commit(contract, who, value, transaction) {
	const { name: contract_name, address, meta } = contract;
	const log = V1_1EventProcessor.getLog(transaction);
	const event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: log?.transactionHash,
		name: contract_name,
		type: 'commit',
		value: Formatter.format(contract_name, value, meta),
	}

	await V1_1EventProcessor.announce(contract, transaction, event);
}

// (address indexed who, uint indexed value, uint votes)
async function unvote(contract, provider, who, value, votes, transaction) {
	const { type, name: contract_name, address, meta } = contract;
	const log = V1_1EventProcessor.getLog(transaction);

	const c = new ethers.Contract(address, getAbiByType(type), provider);
	const {
		leader_value,
		leader_support,
	} = await DataFetcher.fetchVotedData(c);

	const event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: log?.transactionHash,
		name: contract_name,
		type: 'removed_support',
		leader_support: leader_support.toString(),
		leader_value: Formatter.format(contract_name, leader_value, meta),
	}

	await V1_1EventProcessor.announce(contract, transaction, event);
}


module.exports = {
	vote,
	commit,
	unvote,
}
