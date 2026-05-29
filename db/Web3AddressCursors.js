const db = require('ocore/db');

async function getLastBlock(network, address) {
	const rows = await db.query(
		'SELECT last_block FROM web3_address_cursors WHERE network = ? AND address = ?',
		[network, address.toLowerCase()]
	);
	if (rows.length) {
		return rows[0].last_block;
	}
	return null;
}

async function setLastBlock(network, address, lastBlock) {
	await db.query(
		`INSERT OR REPLACE INTO web3_address_cursors(network, address, last_block, updated_at)
				VALUES(?, ?, ?, datetime('now'))`,
		[network, address.toLowerCase(), lastBlock]
	);
}

module.exports = {
	getLastBlock,
	setLastBlock,
};
