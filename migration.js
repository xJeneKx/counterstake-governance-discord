const db = require('ocore/db');

async function init() {
  await db.query(`CREATE TABLE IF NOT EXISTS web3_addresses (
        address TEXT(50) NOT NULL,
        last_block INTEGER DEFAULT 0 NOT NULL,
\tCONSTRAINT web3_addresses_PK PRIMARY KEY (address)
)`);
  await db.query(`CREATE TABLE IF NOT EXISTS web3_address_cursors (
        network TEXT(32) NOT NULL,
        address TEXT(50) NOT NULL,
        last_block INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT NOT NULL,
\tCONSTRAINT web3_address_cursors_PK PRIMARY KEY (network, address)
)`);
  await db.query(`CREATE TABLE IF NOT EXISTS logs (
        network TEXT(32) NOT NULL,
        address TEXT(50) NOT NULL,
        tx_hash TEXT NOT NULL,
        aa_version TEXT(16),
        event_type TEXT(32) NOT NULL,
        event_name TEXT(64) NOT NULL,
        source TEXT(16) NOT NULL,
        payload_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
\tCONSTRAINT logs_unique_event UNIQUE (network, address, tx_hash, event_type, event_name)
)`);
  console.log('migration done')
}

module.exports = {
  init,
}
