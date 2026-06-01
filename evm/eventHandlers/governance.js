const EventPublisher = require("../controllers/EventPublisher");
const { getTransactionHash } = require("./eventPayload");

// Withdrawal(address indexed who, uint amount)
function withdrawal(contract, who, amount, transaction) {
	const { name: contract_name, address, meta } = contract;

	let event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: getTransactionHash(transaction),
		timestamp: Math.floor(Date.now() / 1000),
		name: contract_name,
		type: 'withdraw',
		amount: amount.toString(),
	}

	console.log('event v2:', event);
	return EventPublisher.publish(meta, event, 'realtime');
}

module.exports = {
	withdrawal,
}
