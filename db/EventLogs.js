const db = require('ocore/db');

async function hasEvent(entry) {
	const rows = await db.query(
		`SELECT 1 FROM logs
		WHERE network = ?
			AND address = ?
			AND tx_hash = ?
			AND event_type = ?
			AND event_name = ?
		LIMIT 1`,
		[
			entry.network,
			entry.address,
			entry.tx_hash,
			entry.event_type,
			entry.event_name,
		]
	);
	return rows.length > 0;
}

async function saveEventLog(entry) {
	await db.query(
		`INSERT INTO logs(network, address, tx_hash, aa_version, event_type, event_name, source, payload_json, published_at)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		[
			entry.network,
			entry.address,
			entry.tx_hash,
			entry.aa_version,
			entry.event_type,
			entry.event_name,
			entry.source,
			entry.payload_json,
		]
	);
}

module.exports = {
	hasEvent,
	saveEventLog,
};
