function getTransactionHash(payload) {
	return payload?.log?.transactionHash || payload?.transactionHash;
}

module.exports = {
	getTransactionHash,
};
