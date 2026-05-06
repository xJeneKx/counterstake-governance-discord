const V1_1EventProcessor = require("../controllers/V1_1EventProcessor");

// Deposit(address indexed who, uint amount)
async function deposit(contract, who, amount, transaction) {
	const { name: contract_name, address } = contract;
	const log = V1_1EventProcessor.getLog(transaction);

	let event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: log?.transactionHash,
		name: contract_name,
		type: 'deposit',
		amount: amount.toString(),
	}

	await V1_1EventProcessor.announce(contract, transaction, event);
}

// Withdrawal(address indexed who, uint amount)
async function withdrawal(contract, who, amount, transaction) {
	const { name: contract_name, address } = contract;
	const log = V1_1EventProcessor.getLog(transaction);

	let event = {
		aa_address: address,
		trigger_address: who,
		trigger_unit: log?.transactionHash,
		name: contract_name,
		type: 'withdraw',
		amount: amount.toString(),
	}

	await V1_1EventProcessor.announce(contract, transaction, event);
}

module.exports = {
	deposit,
	withdrawal,
}
