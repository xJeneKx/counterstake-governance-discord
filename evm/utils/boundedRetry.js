const DEFAULT_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 120, 180];

function getStatus(error) {
	return error?.response?.status
		|| error?.status
		|| error?.info?.responseStatus
		|| error?.error?.status;
}

function getErrorText(error) {
	return [
		error?.code,
		error?.error?.code,
		error?.reason,
		error?.shortMessage,
		error?.error?.message,
		error?.message,
		error,
	]
		.filter(Boolean)
		.join(' ');
}

function isBlockRangeError(error) {
	const text = getErrorText(error);
	return /block range (is )?too large/i.test(text)
		|| /exceed(?:ed|s)? maximum block range/i.test(text)
		|| /ranges? over \d+ blocks? (?:are|is) not supported/i.test(text);
}

function isRetryableNetworkOrRateLimitError(error) {
	if (isBlockRangeError(error)) {
		return false;
	}

	const status = getStatus(error);
	if (status === 408 || status === 429 || status >= 500) {
		return true;
	}

	const text = getErrorText(error);
	return /rate limit|too many requests|timeout|timed out|socket hang up|connection (?:reset|closed|refused)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|SERVER_ERROR|NETWORK_ERROR/i.test(text);
}

function withTimeout(label, operation, timeoutMs) {
	if (!timeoutMs) {
		return operation();
	}

	let timeout;
	return Promise.race([
		operation(),
		new Promise((resolve, reject) => {
			timeout = setTimeout(() => {
				const error = new Error(`${label} timed out after ${timeoutMs}ms`);
				error.code = 'EVM_REQUEST_TIMEOUT';
				reject(error);
			}, timeoutMs);
		}),
	]).finally(() => clearTimeout(timeout));
}

async function withBoundedRetry(label, operation, {
	delaysSeconds = DEFAULT_RETRY_DELAYS_SECONDS,
	shouldRetry = isRetryableNetworkOrRateLimitError,
	timeoutMs,
} = {}) {
	let lastError;
	for (let attempt = 0; attempt <= delaysSeconds.length; attempt++) {
		try {
			return await withTimeout(label, operation, timeoutMs);
		} catch (error) {
			lastError = error;
			if (!shouldRetry(error) || attempt === delaysSeconds.length) {
				const finalError = attempt === delaysSeconds.length && shouldRetry(error)
					? new Error(`${label} retry attempts exhausted`)
					: error;
				if (finalError !== error) {
					finalError.code = 'EVM_REQUEST_RETRY_EXHAUSTED';
					finalError.cause = error;
				}
				throw finalError;
			}

			const delaySeconds = delaysSeconds[attempt];
			console.error(`[retry:${label}] attempt ${attempt + 1}/${delaysSeconds.length + 1} failed, wait ${delaySeconds}s`, error);
			await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
		}
	}

	throw lastError;
}

module.exports = {
	isRetryableNetworkOrRateLimitError,
	withBoundedRetry,
};
