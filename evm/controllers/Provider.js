const conf = require('ocore/conf');
const { ethers } = require("ethers");
const EventEmitter = require('node:events');

const sleep = require('../../utils/sleep');
const crashOnError = require('../../utils/crashOnError');

const HEARTBEAT_INTERVAL = 30 * 1000;
const PONG_TIMEOUT = 10 * 1000;
const WS_OPEN = 1;
const MAX_CONNECT_ERROR_ATTEMPTS = 5;
const HTTP_HANDSHAKE_ERROR_RE = /^Unexpected server response: \d{3}$/;

class Provider {
	#network;
	#url;
	#connectCB;
	#heartbeatInterval = null;
	#pongTimeout = null;
	#reconnecting = false;
	#reconnectSourceProvider = null;
	#openedProviders = new WeakSet();
	#connectErrorAttempts = 0;
	
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
		const provider = new ethers.WebSocketProvider(this.#url);
		this._provider = provider;
		
		provider.websocket.on('open', () => {
			this.#onOpen(provider);
		});
		provider.websocket.on('close', (code) => {
			this.#onClose(provider, code);
		});
		provider.websocket.on('error', (error) => {
			this.#onError(provider, error);
		});
		provider.websocket.on('pong', () => {
			this.#onPong(provider);
		});
	}

	#isCurrentProvider(provider) {
		return provider && provider === this._provider;
	}

	#onOpen(provider) {
		if (!this.#isCurrentProvider(provider)) return;
		this.#openedProviders.add(provider);
		this.#connectErrorAttempts = 0;
		this.#reconnecting = false;
		this.#reconnectSourceProvider = null;
		this.#startHeartbeat();
		this.#connectCB();
	}

	#onError(provider, error) {
		if (!this.#isCurrentProvider(provider)) return;
		console.error(`[Provider[${this.#network}].ws_error]:`, error);
		if (HTTP_HANDSHAKE_ERROR_RE.test(error?.message || '')) {
			return crashOnError(`[Provider[${this.#network}].ws_fatal_http_error]`, error);
		}
		if (!this.#openedProviders.has(provider) && ++this.#connectErrorAttempts >= MAX_CONNECT_ERROR_ATTEMPTS) {
			return crashOnError(`[Provider[${this.#network}].ws_connect_error_limit]`, error);
		}
		this.#reconnect(provider, 'error');
	}

	async #onClose(provider, code) {
		if (!this.#isCurrentProvider(provider)) return;
		this.#reconnect(provider, `close ${code}`);
	}

	async #reconnect(provider, reason) {
		if (!this.#isCurrentProvider(provider)) return;
		if (this.#reconnecting && provider === this.#reconnectSourceProvider) return;
		this.#reconnecting = true;
		this.#reconnectSourceProvider = provider;
		this.#stopHeartbeat();
		console.error(`[Provider[${this.#network}].ws_reconnect]:`, reason);
		this.events.emit('close');
		if (!provider.destroyed) {
			provider.destroy();
		}
		await sleep(2);
		if (this.#isCurrentProvider(provider)) {
			this.connect();
		}
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

	#onPong(provider) {
		if (!this.#isCurrentProvider(provider)) return;
		clearTimeout(this.#pongTimeout);
		this.#pongTimeout = null;
	}
}


module.exports = Provider;
