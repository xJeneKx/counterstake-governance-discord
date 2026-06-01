const DAG = require('aabot/dag.js');
const conf = require('ocore/conf.js');
const network = require('ocore/network.js');
const eventBus = require('ocore/event_bus.js');
const lightWallet = require('ocore/light_wallet.js');
const walletGeneral = require('ocore/wallet_general.js');
const governanceEvents = require('governance_events/governance_events.js');
const governanceDiscord = require('governance_events/governance_discord.js');
const migration = require('./migration');
const evm = require('./evm');
const { isAfterScanStartDate } = require('./utils/scanStartDateFilter');

var assocGovernanceAAs = {};
var assocCounterstakeAAs = {};

lightWallet.setLightVendorHost(conf.hub);

eventBus.once('connected', function(ws){
	network.initWitnessesIfNecessary(ws, start);
});

async function start(){
	await discoverGovernanceAas();
	watchBaseGovernanceAas();
	eventBus.on('connected', function(){
		watchBaseGovernanceAas();
	});
	lightWallet.refreshLightClientHistory();
	setInterval(discoverGovernanceAas, 24*3600*1000); // everyday check
	await migration.init()
	await evm.init();
}

function watchBaseGovernanceAas() {
	conf.governance_export_base_AAs
	.concat(conf.governance_import_base_AAs)
	.forEach((address) => {
		network.addLightWatchedAa(address, null, console.log);
	});
}

eventBus.on('aa_response', async function(objResponse){
	if(objResponse.response.error)
		return console.log('ignored response with error: ' + objResponse.response.error);
	if (assocGovernanceAAs[objResponse.aa_address]){
		const governance_aa = assocGovernanceAAs[objResponse.aa_address];
		const main_aa = assocCounterstakeAAs[governance_aa.main_aa];

		const event = await governanceEvents.treatResponseFromGovernanceAA(objResponse, main_aa.asset);
		if (!isAfterScanStartDate(event.timestamp, conf.scan_start_date))
			return;

		const aa_name = main_aa.aa_address + ' - ' + main_aa.symbol + ' on Obyte (' + (governance_aa.is_import ? 'import' : 'export') + ')';
		governanceDiscord.announceEvent(aa_name, main_aa.symbol, main_aa.decimals, conf.counterstake_base_url + main_aa.aa_address, event);
	}
});

async function discoverGovernanceAas(){
	const rows = await DAG.getAAsByBaseAAs(conf.governance_export_base_AAs.concat(conf.governance_import_base_AAs));
	await Promise.all(rows.map(indexAndWatchGovernanceAA));
}

async function indexAndWatchGovernanceAA(governanceAA){
	const isImport = conf.governance_import_base_AAs.includes(governanceAA.definition[1].base_aa);
	const mainAAAddress = governanceAA.definition[1].params[isImport ? 'import_aa' : 'export_aa'];

	await indexAllCounterstakeAaParams(mainAAAddress, isImport);
	assocGovernanceAAs[governanceAA.address] = {
		main_aa: mainAAAddress,
		is_import: isImport
	}

	await new Promise(resolve => walletGeneral.addWatchedAddress(governanceAA.address, resolve));
}

async function indexAllCounterstakeAaParams(mainAAAddress, isImport){
	const mainAADefinition = await DAG.readAADefinition(mainAAAddress);
	const asset = isImport ? (await DAG.readAAStateVar(mainAAAddress, "asset")) : mainAADefinition[1].params.asset;
	const decimals = mainAADefinition[1].params.asset_decimals;
	const governance_aa = await DAG.readAAStateVar(mainAAAddress, "governance_aa");
	const symbol = await DAG.readAAStateVar(conf.token_registry_AA_address, 'a2s_' + asset);

	assocCounterstakeAAs[mainAAAddress] = {
		aa_address: mainAAAddress,
		governance_aa: governance_aa,
		asset: asset,
		decimals: asset == 'base' ? 9 : decimals,
		symbol: asset == 'base' ? 'GB' : symbol
	}
}

function handleJustsaying(ws, subject, body) {
	switch (subject) {
		case 'light/have_updates':
			lightWallet.refreshLightClientHistory();
			break;
	}
}
eventBus.on("message_for_light", handleJustsaying);

process.on('unhandledRejection', up => { throw up });
