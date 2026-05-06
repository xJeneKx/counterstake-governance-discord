const { ethers } = require("ethers");

const { getAbiByType } = require('../abi/getAbiByType');
const governanceHandlers = require('../eventHandlers/governance');
const uintHandlers = require("../eventHandlers/uint");
const uintArrayHandlers = require("../eventHandlers/uintArray");
const addressHandlers = require("../eventHandlers/address");

function runHandler(label, handler) {
	Promise.resolve()
		.then(handler)
		.catch((error) => {
			console.error(`[Handlers.${label}] failed:`, error);
		});
}

class Handlers {
	static addGovernanceHandler(contract, provider) {
		let c = new ethers.Contract(contract.address, getAbiByType('governance'), provider.provider);
		c.on('Deposit', (...args) => {
			runHandler('Deposit', () => governanceHandlers.deposit(contract, ...args));
		});
		c.on('Withdrawal', (...args) => {
			runHandler('Withdrawal', () => governanceHandlers.withdrawal(contract, ...args));
		});
		
		provider.events.once('close', () => {
			c.removeAllListeners();
			c = null;
		});
	}

	static addUintHandler(contract, provider) {
		let c = new ethers.Contract(contract.address, getAbiByType('Uint'), provider.provider);
		c.on('Commit', (...args) => {
			runHandler('Uint.Commit', () => uintHandlers.commit(contract, ...args));
		});
		c.on('Vote', (...args) => {
			runHandler('Uint.Vote', () => uintHandlers.vote(contract, ...args));
		});
		c.on('Unvote', (...args) => {
			runHandler('Uint.Unvote', () => uintHandlers.unvote(contract, provider.provider, ...args));
		});
		
		provider.events.once('close', () => {
			c.removeAllListeners();
			c = null;
		});
	}

	static addUintArrayHandler(contract, provider) {
		let c = new ethers.Contract(contract.address, getAbiByType('UintArray'), provider.provider);
		c.on('Commit', (...args) => {
			runHandler('UintArray.Commit', () => uintArrayHandlers.commit(contract, ...args));
		});
		c.on('Vote', (...args) => {
			runHandler('UintArray.Vote', () => uintArrayHandlers.vote(contract, ...args));
		});
		c.on('Unvote', (...args) => {
			runHandler('UintArray.Unvote', () => uintArrayHandlers.unvote(contract, provider.provider, ...args));
		});
		
		provider.events.once('close', () => {
			c.removeAllListeners();
			c = null;
		});
	}

	static addAddressHandler(contract, provider) {
		let c = new ethers.Contract(contract.address, getAbiByType('address'), provider.provider);
		c.on('Commit', (...args) => {
			runHandler('address.Commit', () => addressHandlers.commit(contract, ...args));
		});
		c.on('Vote', (...args) => {
			runHandler('address.Vote', () => addressHandlers.vote(contract, ...args));
		});
		c.on('Unvote', (...args) => {
			runHandler('address.Unvote', () => addressHandlers.unvote(contract, provider.provider, ...args));
		});
		
		provider.events.once('close', () => {
			c.removeAllListeners();
			c = null;
		});
	}
}

module.exports = Handlers;
