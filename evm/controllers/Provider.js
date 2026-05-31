const conf = require('ocore/conf');
const { ethers } = require("ethers");
const EventEmitter = require('node:events');

const sleep = require('../../utils/sleep');

const HEARTBEAT_INTERVAL = 30 * 1000;
const PONG_TIMEOUT = 10 * 1000;
const WS_OPEN = 1;

class Provider {
	#network;
	#url;
	#connectCB;
	#heartbeatInterval = null;
	#pongTimeout = null;
	
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
	
	close() {
		if (!this._provider || this._provider.destroyed) return;
		this.#stopHeartbeat();
		this._provider.websocket.removeAllListeners();
		this._provider.destroy();
	}
	
	async #createProvider() {
		console.log(`[Provider[${this.#network}].ws] create provider`);
		this._provider = new ethers.WebSocketProvider(this.#url);
		
		this._provider.websocket.on('open', () => {
			this.#onOpen()
		});
		this._provider.websocket.on('close', (code) => {
			this.#onClose(code);
		});
		this._provider.websocket.on('error', (error) => {
			this.#onError(error);
		});
		this._provider.websocket.on('pong', () => {
			this.#onPong();
		});
	}

	#onOpen() {
		this.#startHeartbeat();
		this.#connectCB();
	}

	#onError(error) {
		console.error(`[Provider[${this.#network}].ws_error]:`, error);
		this.#stopHeartbeat();
		this.close();
	}

	async #onClose(code) {
		this.#stopHeartbeat();
		console.error(`[Provider[${this.#network}].ws_close]:`, code);
		this.events.emit('close');
		await sleep(2);
		this.connect();
	}

	#startHeartbeat() {
		this.#stopHeartbeat();
		const websocket = this._provider.websocket;
		if (typeof websocket.ping !== 'function') return;

		this.#heartbeatInterval = setInterval(() => this.#sendPing(), HEARTBEAT_INTERVAL);
		this.#heartbeatInterval.unref?.();
		this.#sendPing();
	}

	#stopHeartbeat() {
		clearInterval(this.#heartbeatInterval);
		clearTimeout(this.#pongTimeout);
		this.#heartbeatInterval = null;
		this.#pongTimeout = null;
	}

	#sendPing() {
		const websocket = this._provider.websocket;
		if (websocket.readyState !== WS_OPEN) return;

		clearTimeout(this.#pongTimeout);
		this.#pongTimeout = setTimeout(() => {
			console.error(`[Provider[${this.#network}].ws_pong_timeout]`);
			(websocket.terminate || websocket.close).call(websocket);
		}, PONG_TIMEOUT);
		this.#pongTimeout.unref?.();
		websocket.ping();
	}

	#onPong() {
		clearTimeout(this.#pongTimeout);
		this.#pongTimeout = null;
	}
}


module.exports = Provider;
