const conf = require('ocore/conf');
const { ethers } = require("ethers");
const EventEmitter = require('node:events');

const sleep = require('../../utils/sleep');

const CHECK_INTERVAL = 10000;

class Provider {
	#network;
	#url;
	#connectCB;
	
	#lastBlock = 0;
	#lastBlockFromEvent = 0;
	#lastBlockInterval;
	
	_provider = null;
	events = new EventEmitter();

	constructor(network) {
		this.#network = network;
		this.#url = conf.ws_nodes[network];
		this.events.setMaxListeners(100);
		if (!this.#url) {
			throw new Error(`Network ${network} not supported`);
		}
	}

	get network() {
		return this.#network;
	}

	get url() {
		return this.#url;
	}

	get provider() {
		return this._provider;
	}

	connect(cb) {
		if (cb) {
			this.#connectCB = cb;
		}
		this.#createProvider();
	}

	#closeFromCheck() {
		this.#lastBlock = 0;
		this.#lastBlockFromEvent = 0;
		if (this._provider.destroyed) { return; }
		this._provider.destroy();
	}
	
	startSubscribeCheck() {
		this.#lastBlockInterval = setInterval(async () => {
			if (this.#lastBlock === this.#lastBlockFromEvent) {
				console.error('Subscribe check failed');
				this.#closeFromCheck();
				return;
			}
			
			this.#lastBlock = this.#lastBlockFromEvent;
		}, CHECK_INTERVAL);
	}

	#waitOnOpen() {
		return new Promise((resolve) => {
			this._provider.websocket.once('open', () => {
				resolve();
			});	
		});	
	}	
	
	
	async #createProvider() {
		console.log(`[Provider[${this.#network}].ws] create provider`);
		this._provider = new ethers.WebSocketProvider(this.#url);

		this._provider.websocket.on('close', (code) => {
			this.#onClose(code);
		});
		this._provider.websocket.on('error', (error) => {
			this.#onError(error);
		});

		await this.#waitOnOpen();
		this.#onOpen();
		
		this._provider.on('block', (lastBlock) => {
			this.#lastBlockFromEvent = lastBlock;
		});
	}

	#onOpen() {
		this.#connectCB();
	}

	#onError(error) {
		console.error(`[Provider[${this.#network}].ws_error]:`, error);
		if (this._provider.destroyed) { return; }
		this._provider.destroy();
	}

	async #onClose(code) {
		console.error(`[Provider[${this.#network}].ws_close]:`, code);
		this.events.emit('close');
		clearInterval(this.#lastBlockInterval);
		await sleep(2);
		this.connect();
	}
}


module.exports = Provider;
