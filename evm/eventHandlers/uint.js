const { ethers } = require("ethers");

const { getAbiByType } = require("../abi/getAbiByType");
const DataFetcher = require("../controllers/DataFetcher");
const Formatter = require('../controllers/Formatter');
const EventPublisher = require('../controllers/EventPublisher');
const { getTransactionHash } = require('./eventPayload');

// (address indexed who, uint indexed value, uint votes, uint total_votes, uint leader, uint leader_total_votes, uint expiry_ts)
function vote(contract, who, value, votes, total_votes, leader, leader_total_votes, expiry_ts, transaction) {
	const { name: contract_name, address, meta } = contract;
	const event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: getTransactionHash(transaction),
		timestamp: Math.floor(Date.now() / 1000),
		added_support: votes.toString(),
		name: contract_name,
		type: 'added_support',
		leader_support: leader_total_votes.toString(),
		leader_value: Formatter.format(contract_name, leader, meta),
		value: Formatter.format(contract_name, value, meta),
		support: total_votes.toString(),
	}

	console.log('event v2:', event);
	return EventPublisher.publish(meta, event, 'realtime');
}

// (address indexed who, uint indexed value, uint votes)
async function unvote(contract, provider, who, value, votes, transaction) {
	const { type, name: contract_name, address, meta } = contract;

	const c = new ethers.Contract(address, getAbiByType(type), provider);
	const {
		leader_value,
		leader_support,
	} = await DataFetcher.fetchVotedData(c);

	const event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: getTransactionHash(transaction),
		timestamp: Math.floor(Date.now() / 1000),
		name: contract_name,
		type: 'removed_support',
		leader_support: leader_support.toString(),
		leader_value: Formatter.format(contract_name, leader_value, meta),
	}

	console.log('event v2:', event);
	await EventPublisher.publish(meta, event, 'realtime');
}


module.exports = {
	vote,
	unvote,
}
