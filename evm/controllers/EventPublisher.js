const mutex = require('ocore/mutex');
const logs = require('../../db/EventLogs');
const Discord = require('./Discord');

async function publish(meta, event, source) {
	const logEntry = {
		network: meta.network,
		address: String(event.aa_address).toLowerCase(),
		tx_hash: event.trigger_unit,
		aa_version: meta.aa_version,
		event_type: event.type,
		event_name: event.name,
		source,
		payload_json: JSON.stringify(event),
	};
	const lockKey = [
		'EventPublisher',
		logEntry.network,
		logEntry.address,
		logEntry.tx_hash,
		logEntry.event_type,
		logEntry.event_name,
	];
	const unlock = await mutex.lock(lockKey);

	try {
		if (await logs.hasEvent(logEntry)) {
			console.log('skip already published event', lockKey.slice(1).join(':'));
			return false;
		}

		await Discord.announceEvent(meta, event);
		await logs.saveEventLog(logEntry);
		return true;
	} finally {
		unlock();
	}
}

module.exports = {
	publish,
};
