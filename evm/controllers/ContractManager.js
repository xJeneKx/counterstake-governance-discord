const { ethers } = require("ethers");

const Handlers = require('./Handlers');
const { getAbiByType } = require('../abi/getAbiByType');

const SUPPORTED_AA_VERSIONS = ['v1', 'v1.1', 'v1.2'];
const REALTIME_AA_VERSIONS = ['v1.1', 'v1.2'];

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

class ContractManager {
	#contracts = Object.fromEntries(SUPPORTED_AA_VERSIONS.map(version => [version, {}]));
	#initializedNetworks = {};
	#contractsReadyHandlers = {};
	#handlers = {
		governance: Handlers.addGovernanceHandler,
		Uint: Handlers.addUintHandler,
		UintArray: Handlers.addUintArrayHandler,
		address: Handlers.addAddressHandler,
	};

	async initNetworkContracts(contracts, network, provider) {
		if (this.#initializedNetworks[network]) {
			return true;
		}
		this.#resetNetworkContracts(network);

		try {
			for (let index in contracts) {
				const contract = contracts[index];
				await this.#setContracts(contract, network, provider);
				await wait(2000);
			}
		} catch (e) {
			if (e?.message &&
				(
					e.message.toLowerCase().includes('internal error') ||
					e.message.toLowerCase().includes('timeout')
				)
			) {
				console.error('Error initializing contracts:', e.message, '. try reconnect');
				provider.close();
				return false;
			}
			
			throw e;
		}

		console.log('initNetworkContracts:', network, 'done');
		this.#initializedNetworks[network] = true;

		if (this.#contractsReadyHandlers[network]) {
			this.#contractsReadyHandlers[network](
				SUPPORTED_AA_VERSIONS.flatMap(version => this.#contracts[version][network] || [])
			);
		}
		return true;
	}

	initHandlersByNetwork(network, provider) {
		REALTIME_AA_VERSIONS.flatMap(version => this.#contracts[version][network] || []).forEach(contract => {
			if (this.#handlers[contract.type]) {
				this.#handlers[contract.type](contract, provider);
			}
		});
	}

	onContractsReady(network, handler) {
		this.#contractsReadyHandlers[network] = handler;
	}

	#resetNetworkContracts(network) {
		delete this.#initializedNetworks[network];
		for (const version of SUPPORTED_AA_VERSIONS) {
			delete this.#contracts[version][network];
		}
	}

	#addContract(meta, address, type, name) {
		const versionContracts = this.#contracts[meta.aa_version];
		if (!versionContracts[meta.network]) {
			versionContracts[meta.network] = [];
		}
		
		console.log('added contract: ', {
			aa_version: meta.aa_version,
			network: meta.network,
			address,
			type,
			name,
		});

		versionContracts[meta.network].push({
			address,
			type,
			name,
			meta,
		});
	}

	async #setContracts(contract, network, provider) {
		const { type, aa, aa_version, symbol, decimals } = contract;
		if (!SUPPORTED_AA_VERSIONS.includes(aa_version)) {
			throw Error(`unsupported EVM aa_version ${aa_version} for ${network} ${aa}`);
		}

		const isImport = type === 'import';
		const meta = { aa_version, network, symbol, decimals, isImport, main_aa: aa };

		const cs = new ethers.Contract(aa, getAbiByType('counterstake'), provider);
		const governance_address = await cs.governance();
		const governance = new ethers.Contract(governance_address, getAbiByType('governance'), provider);

		meta.governance_address = governance_address;

		this.#addContract(meta, governance_address, 'governance', 'governance');

		const ratio100 = await governance.votedValuesMap('ratio100');
		this.#addContract(meta, ratio100, 'Uint', 'ratio100');

		const counterstake_coef100 = await governance.votedValuesMap('counterstake_coef100');
		this.#addContract(meta, counterstake_coef100, 'Uint', 'counterstake_coef100');

		const min_stake = await governance.votedValuesMap('min_stake');
		this.#addContract(meta, min_stake, 'Uint', 'min_stake');

		const min_tx_age = await governance.votedValuesMap('min_tx_age');
		this.#addContract(meta, min_tx_age, 'Uint', 'min_tx_age');
		await wait(1000);

		const large_threshold = await governance.votedValuesMap('large_threshold');
		this.#addContract(meta, large_threshold, 'Uint', 'large_threshold');

		const challenging_periods = await governance.votedValuesMap('challenging_periods');
		this.#addContract(meta, challenging_periods, 'UintArray', 'challenging_periods');

		const large_challenging_periods = await governance.votedValuesMap('large_challenging_periods');
		this.#addContract(meta, large_challenging_periods, 'UintArray', 'large_challenging_periods');

		if (isImport) {
			const oracleAddress = await governance.votedValuesMap('oracleAddress');
			this.#addContract(meta, oracleAddress, 'address', 'address');

			const min_price20 = await governance.votedValuesMap('min_price20');
			this.#addContract(meta, min_price20, 'Uint', 'min_price20');
		}
	}
}

module.exports = ContractManager;
