import { TidalApi } from "@luna/lib";

import { addIndexEntries, isKeptOutsideTidal, reindexFromLibrary } from "./downloadIndex";
import { identifyOnTidal, type IdentifyPhase, type IdentifyResult, type TrackCandidate } from "./identify";

const searchTracks = async (query: string): Promise<TrackCandidate[]> => {
	const url = `https://desktop.tidal.com/v1/search/tracks?query=${encodeURIComponent(query)}&limit=10&offset=0&${TidalApi.queryArgs()}`;
	const response = await fetch(url, { headers: await TidalApi.getAuthHeaders(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`TIDAL search ${response.status} ${response.statusText}`);
	return ((await response.json()) as { items?: TrackCandidate[] }).items ?? [];
};

/**
 * Re-indexes the library, then looks up each FLAC without a TIDAL id on TIDAL (one search per file)
 * and adds the certain matches to the download index. Files are not changed here.
 */
export const identifyLibraryFiles = async (
	root: string,
	onProgress?: (done: number, total: number, phase: IdentifyPhase) => void,
	options: { broad?: boolean } = {},
) => {
	const { unidentified, sameAudioAsIdentified } = await reindexFromLibrary(root);
	// The wider search looks up the files kept as archive files too.
	const toLookUp = options.broad ? unidentified : unidentified.filter((file) => !isKeptOutsideTidal(file));
	const result = await identifyOnTidal(toLookUp, searchTracks, onProgress, options);
	if (result.found.length > 0) await addIndexEntries(Object.fromEntries(result.found.map((f) => [f.id, f.path])));
	const keptOutsideTidal = unidentified.filter((file) => !toLookUp.includes(file)).map((file) => file.path);
	return { ...result, sameAudioAsIdentified, keptOutsideTidal };
};

/** Downloads one TIDAL track over an existing file; set by the plugin entry, which owns the download code. */
export type TidalReplacer = (root: string, trackId: string, path: string) => Promise<string | undefined>;
let replacer: TidalReplacer | undefined;
export const setTidalReplacer = (next: TidalReplacer) => {
	replacer = next;
};

export type ReplaceResult = { replaced: number; skipped: { path: string; reason: string }[] };

/**
 * Replaces each identified file with a fresh TIDAL download (embedded TIDAL id, cover and tags), one at
 * a time. The old file goes to the quarantine folder; a 429 stops the run.
 */
export const replaceIdentifiedFiles = async (
	root: string,
	found: IdentifyResult["found"],
	onProgress?: (done: number, total: number) => void,
): Promise<ReplaceResult> => {
	if (replacer === undefined) throw new Error("Song Downloader Deluxe is not loaded yet");
	const result: ReplaceResult = { replaced: 0, skipped: [] };
	let stopped = false;
	for (const [index, file] of found.entries()) {
		if (stopped) {
			result.skipped.push({ path: file.path, reason: "not tried after TIDAL answered 429" });
			continue;
		}
		try {
			const skipReason = await replacer(root, file.id, file.path);
			if (skipReason === undefined) result.replaced++;
			else result.skipped.push({ path: file.path, reason: skipReason });
		} catch (error) {
			if (/\b429\b|too many requests/i.test(String(error))) stopped = true;
			result.skipped.push({ path: file.path, reason: String(error) });
		}
		onProgress?.(index + 1, found.length);
	}
	return result;
};
