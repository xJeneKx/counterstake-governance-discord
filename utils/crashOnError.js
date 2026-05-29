function crashOnError(label, e) {
	console.error(label, e);
	setImmediate(() => {
		throw e;
	});
}

module.exports = crashOnError;
