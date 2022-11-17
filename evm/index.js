const { utils } = require('ethers');

const Provider = require('./controllers/Provider');
const Bridges = require('./controllers/Bridges');
const ContractManager = require('./controllers/ContractManager');
const ContractRunnerForV1 = require('./controllers/ContractRunnerForV1');

const { eventsForV1 } = require('./eventsForV1');

function generateMetaForEventsInV1() {
	for (let type in eventsForV1) {
		const t = eventsForV1[type];
		if (!t.events.length) continue;

		const interfaces = t.events.map(v => v.code);
		t.iface = new utils.Interface(interfaces);
		t.events = t.events.map(v => {
			v.sighash = t.iface.getSighash(v.name);
			return v;
		});
	}
}

function initNetwork(network, contractManager, contractManagerOfV1, bridges) {
	const p = new Provider(network);
	contractManager.onV1Ready(network, (contracts) => { // v1 only
		contractManagerOfV1.setContracts(network, contracts);
	});
	p.connect(async () => { // new provider (connect/reconnect)
		contractManagerOfV1.setProvider(network, p.provider);
		const contracts = bridges.getContractsByNetwork(network);
		await contractManager.initNetworkContracts(contracts, network, p.provider);
		contractManager.initHandlersByNetwork(network, p.provider);
		console.error(`[${network}]: connected`);
	});
}

async function init() {
	generateMetaForEventsInV1();
	const bridges = new Bridges();
	await bridges.init();

	const contractManager = new ContractManager();
	const contractManagerOfV1 = new ContractRunnerForV1();

	initNetwork('Ethereum', contractManager, contractManagerOfV1, bridges);
	initNetwork('BSC', contractManager, contractManagerOfV1, bridges);
	initNetwork('Polygon', contractManager, contractManagerOfV1, bridges);
}

module.exports = {
	init,
};
