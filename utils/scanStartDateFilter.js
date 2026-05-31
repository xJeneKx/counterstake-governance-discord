function getScanStartTimestamp(scanStartDate) {
	const date = new Date(scanStartDate);
	if (!scanStartDate || Number.isNaN(date.getTime())) {
		throw Error('scan_start_date is required and must be a valid date');
	}
	return Math.floor(date.getTime() / 1000);
}

function normalizeEventTimestamp(timestamp) {
	if (timestamp === null || timestamp === undefined || timestamp === '') return null;
	const numeric = Number(timestamp);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
}

function isAfterScanStartDate(timestamp, scanStartDate) {
	const eventTimestamp = normalizeEventTimestamp(timestamp);
	if (!eventTimestamp) return false;
	return eventTimestamp > getScanStartTimestamp(scanStartDate);
}

module.exports = {
	isAfterScanStartDate,
};
