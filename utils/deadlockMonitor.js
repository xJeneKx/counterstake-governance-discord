const mutex = require('ocore/mutex');
const crashOnError = require('./crashOnError');

const DEADLOCK_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const watchedKeys = {};

function die(message) {
	crashOnError(message, new Error(message));
}

async function checkForDeadlock(key) {
	const timer = setTimeout(die, DEADLOCK_CHECK_INTERVAL_MS, `possible deadlock on ${key}`);
	let unlock;

	try {
		unlock = await mutex.lock(key);
	} finally {
		if (unlock) unlock();
		clearTimeout(timer);
	}
}

function watchForDeadlock(key) {
	if (watchedKeys[key])
		return console.log('already watching for deadlock on ' + key);
	watchedKeys[key] = true;
	setInterval(() => {
		checkForDeadlock(key).catch(e => crashOnError(`deadlock check failed for ${key}`, e));
	}, DEADLOCK_CHECK_INTERVAL_MS);
}

module.exports = {
	watchForDeadlock,
};
