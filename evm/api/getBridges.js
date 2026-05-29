const axios = require("axios");
const conf = require("ocore/conf");
const sleep = require("../../utils/sleep");

async function getBridges(r = 0) {
	try {
		const bridges = await axios.get(`${conf.cs_url}/bridges`);
		return bridges.data.data;
	} catch (e) {
		console.log('getBridges error:', e);
		if (r < 5 && e.response?.status === 504) {
			await sleep(10);
			return getBridges(++r);
		}
		return [];
	}
}

module.exports = {
	getBridges,
}
