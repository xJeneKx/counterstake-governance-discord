const { ethers } = require('ethers');

const Provider = require('./controllers/Provider');
const Bridges = require('./controllers/Bridges');
const ContractManager = require('./controllers/ContractManager');
const AddressEventScanner = require('./controllers/AddressEventScanner');

const { eventsForV1 } = require('./eventsForV1');
const crashOnError = require('../utils/crashOnError');

function generateMetaForEventsInV1() {
	for (let type in eventsForV1) {
		const t = eventsForV1[type];
		if (!t.events.length) continue;

		const interfaces = t.events.map(v => v.code);
		t.iface = new ethers.Interface(interfaces);
		t.events = t.events.map(v => {
			try {
				const functionFragment = t.iface.getFunction(v.name);
				if (functionFragment) {
					v.sighash = functionFragment.selector;
				} else {
					console.error(`Function ${v.name} not found in interface, calculating selector manually`);
					const signature = `${v.name}()`;
					v.sighash = ethers.id(signature).substring(0, 10);
				}
			} catch (e) {
				console.error(e);
				throw `Error getting selector for ${v.name}`;
			}
			return v;
		});
	}
}

function initNetwork(network, contractManager, addressEventScanner, bridges) {
	const p = new Provider(network);
	contractManager.onContractsReady(network, (contracts) => {
		addressEventScanner.setContracts(network, contracts);
	});
	p.connect(() => { // new provider (connect/reconnect)
		(async () => {
			addressEventScanner.setProvider(network, p.provider);
			const contracts = bridges.getContractsByNetwork(network);
			const initialized = await contractManager.initNetworkContracts(contracts, network, p.provider);
			if (!initialized) return;
			contractManager.initHandlersByNetwork(network, p);
			await addressEventScanner.scanNetworkOnce(network);
			console.log(`[${network}]: connected`);
		})().catch(e => crashOnError(`[${network}]: connect handler failed`, e));
	});
}

async function init() {
	generateMetaForEventsInV1();
	const bridges = new Bridges();
	await bridges.init();

	const contractManager = new ContractManager();
	const addressEventScanner = new AddressEventScanner();
	addressEventScanner.startInterval();

	initNetwork('Ethereum', contractManager, addressEventScanner, bridges);
	initNetwork('BSC', contractManager, addressEventScanner, bridges);
	initNetwork('Polygon', contractManager, addressEventScanner, bridges);
	initNetwork('Kava', contractManager, addressEventScanner, bridges);
}

module.exports = {
	init,
};
