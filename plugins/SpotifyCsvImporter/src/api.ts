import { TidalApi, redux } from "@luna/lib";

// TidalApi.fetch gives up after one retry, and a 429 during matching silently drops album info, which
// is exactly what tells an original album from a compilation. All importer reads go through here instead.
const MAX_CONCURRENT = 2;
// At most ~3 requests per second overall, however many workers are waiting.
const MIN_REQUEST_GAP_MS = 350;
const MAX_ATTEMPTS = 7;

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let active = 0;
const waiting: (() => void)[] = [];
const limited = async <T>(run: () => Promise<T>): Promise<T> => {
	if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
	else active++;
	try {
		return await run();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}
};

// Shared across requests: one 429 pauses everyone, instead of each worker hammering on its own.
let pausedUntil = 0;
let nextRequestAt = 0;
let requestCount = 0;

/** Requests sent since the last resetRateLimitTracking(), shown in the import summary. */
export const requestsSent = () => requestCount;

/** Seconds left in the current TIDAL rate-limit pause, 0 when not throttled. */
export const throttledSeconds = () => Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000));

// TIDAL answers a short Retry-After even while it keeps refusing, so our own backoff is the floor.
const retryDelay = (response: Response | undefined, attempt: number) => {
	const backoff = Math.min(30_000, 1000 * 2 ** attempt);
	const retryAfter = Number(response?.headers.get("retry-after"));
	return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(backoff, retryAfter * 1000) : backoff;
};

/** Thrown when TIDAL has refused every request for a long stretch: waiting longer inside one import won't help. */
export class TidalRateLimitError extends Error {}
const GIVE_UP_AFTER_MS = 3 * 60_000;
let lastSuccessAt = Date.now();

/** Call at the start of an import, so an earlier quiet period does not count as being throttled. */
export const resetRateLimitTracking = () => {
	lastSuccessAt = Date.now();
	pausedUntil = 0;
	requestCount = 0;
};

/** GET with auth, no HTTP cache, a global concurrency limit and backoff on 429/5xx. 403/404 give undefined. */
export const apiGet = async <T>(url: string): Promise<T | undefined> => {
	for (let attempt = 0; ; attempt++) {
		let response: Response | undefined;
		try {
			response = await limited(async () => {
				const pause = pausedUntil - Date.now();
				if (pause > 0) await sleep(pause);
				const gap = nextRequestAt - Date.now();
				nextRequestAt = Math.max(Date.now(), nextRequestAt) + MIN_REQUEST_GAP_MS;
				if (gap > 0) await sleep(gap);
				requestCount++;
				// A hung request would hold a concurrency slot forever and stall the whole import.
				return fetch(url, { headers: await TidalApi.getAuthHeaders(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
			});
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS - 1) throw error;
		}
		if (response?.ok) {
			lastSuccessAt = Date.now();
			return (await response.json()) as T;
		}
		if (response?.status === 403 || response?.status === 404) return undefined;
		if (response === undefined || response.status === 429 || response.status >= 500) {
			if (response?.status === 429 && Date.now() - lastSuccessAt > GIVE_UP_AFTER_MS) {
				throw new TidalRateLimitError(
					`TIDAL has refused all requests for ${Math.round((Date.now() - lastSuccessAt) / 60_000)} min (429 Too Many Requests). ` +
						"Stop other plugins that use TIDAL heavily, wait 30-60 minutes and import again.",
				);
			}
			if (attempt < MAX_ATTEMPTS - 1) {
				pausedUntil = Math.max(pausedUntil, Date.now() + retryDelay(response, attempt));
				continue;
			}
		}
		throw new Error(`TIDAL API ${response?.status} ${response?.statusText} for ${url.split("?")[0]}`);
	}
};

const memo = new Map<string, Promise<unknown>>();
/** apiGet for immutable catalogue data; failures are not cached. */
const cachedGet = <T>(url: string): Promise<T | undefined> => {
	let pending = memo.get(url) as Promise<T | undefined> | undefined;
	if (pending === undefined) {
		pending = apiGet<T>(url);
		memo.set(url, pending);
		pending.catch(() => memo.delete(url));
	}
	return pending;
};

const desktop = (path: string) => `https://desktop.tidal.com/v1/${path}${path.includes("?") ? "&" : "?"}${TidalApi.queryArgs()}`;

export const getTrack = (id: redux.ItemId) => cachedGet<redux.Track>(desktop(`tracks/${id}`));
export const getAlbum = (id: redux.ItemId) => cachedGet<redux.Album>(desktop(`albums/${id}`));

export const searchTracks = async (query: string, limit: number) => {
	const encoded = encodeURIComponent(query.replaceAll("_", " ").trim());
	const response = await cachedGet<{ items?: redux.Track[] }>(desktop(`search/tracks?query=${encoded}&limit=${limit}&offset=0`));
	return response?.items ?? [];
};

type IsrcPage = { data?: { id: string }[]; links?: { next?: string } };

/** TIDAL track ids sharing this ISRC. The filter is case-sensitive, and some Spotify exports are lowercase. */
export const isrcTrackIds = async (isrc: string, max: number) => {
	const ids: string[] = [];
	let page = await cachedGet<IsrcPage>(`https://openapi.tidal.com/v2/tracks?${TidalApi.queryArgs()}&filter[isrc]=${encodeURIComponent(isrc.trim().toUpperCase())}`);
	while (page?.data?.length) {
		ids.push(...page.data.map((track) => track.id));
		if (ids.length >= max || page.links?.next === undefined) break;
		page = await cachedGet<IsrcPage>(`https://openapi.tidal.com/v2/${page.links.next}`);
	}
	return ids.slice(0, max);
};
