import { TidalApi } from "@luna/lib";

import { readLibraryReport, writeLibraryReport } from "./files.native";

/**
 * Looks up a list of albums (from an archive outside the library) on TIDAL, one album search each,
 * so whole releases can be added to the Collection instead of loose tracks. The list is
 * "_tidal-album-search.json" at the library root: { "albums": [{ "key": "...", "query": "Artist Album" }] }.
 * An entry with "type": "tracks" is a song search instead: its candidates are tracks, each with its album.
 * The candidates go to "_tidal-album-search-result.json"; deciding which one is the same release is left to
 * whoever reads the result. A rerun skips the albums already looked up, so a 429 only pauses the work.
 */
export const albumSearchListName = "_tidal-album-search.json";
export const albumSearchResultName = "_tidal-album-search-result.json";

type ListedAlbum = { key: string; query: string; type?: "albums" | "tracks" };
type Candidate = {
	id: string;
	title: string;
	version?: string;
	artists: string[];
	releaseDate?: string;
	numberOfTracks?: number;
	numberOfVolumes?: number;
	duration?: number;
	upc?: string;
	copyright?: string;
	explicit?: boolean;
};
type TrackCandidate = {
	id: string;
	title: string;
	version?: string;
	artists: string[];
	duration?: number;
	isrc?: string;
	trackNumber?: number;
	volumeNumber?: number;
	album: { id: string; title: string; releaseDate?: string };
};
type SearchResult = Record<string, { query: string; candidates: Candidate[] | TrackCandidate[] } | { query: string; error: string }>;

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const searchAlbums = async (query: string): Promise<Candidate[]> => {
	const url = `https://desktop.tidal.com/v1/search/albums?query=${encodeURIComponent(query)}&limit=10&offset=0&${TidalApi.queryArgs()}`;
	const response = await fetch(url, { headers: await TidalApi.getAuthHeaders(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`TIDAL search ${response.status} ${response.statusText}`);
	const items = ((await response.json()) as { items?: any[] }).items ?? [];
	return items.map((album) => ({
		id: String(album.id),
		title: album.title,
		version: album.version ?? undefined,
		artists: (album.artists ?? []).map((artist: { name: string }) => artist.name),
		releaseDate: album.releaseDate ?? undefined,
		numberOfTracks: album.numberOfTracks,
		numberOfVolumes: album.numberOfVolumes,
		duration: album.duration,
		upc: album.upc ?? undefined,
		copyright: album.copyright ?? undefined,
		explicit: album.explicit,
	}));
};

const searchTracks = async (query: string): Promise<TrackCandidate[]> => {
	const url = `https://desktop.tidal.com/v1/search/tracks?query=${encodeURIComponent(query)}&limit=10&offset=0&${TidalApi.queryArgs()}`;
	const response = await fetch(url, { headers: await TidalApi.getAuthHeaders(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`TIDAL search ${response.status} ${response.statusText}`);
	const items = ((await response.json()) as { items?: any[] }).items ?? [];
	return items.map((track) => ({
		id: String(track.id),
		title: track.title,
		version: track.version ?? undefined,
		artists: (track.artists ?? []).map((artist: { name: string }) => artist.name),
		duration: track.duration,
		isrc: track.isrc ?? undefined,
		trackNumber: track.trackNumber,
		volumeNumber: track.volumeNumber,
		album: { id: String(track.album?.id), title: track.album?.title, releaseDate: track.album?.releaseDate ?? undefined },
	}));
};

export const searchListedAlbums = async (root: string, onProgress?: (done: number, total: number) => void) => {
	const listText = await readLibraryReport(root, albumSearchListName);
	if (listText === undefined) throw new Error(`no ${albumSearchListName} at the library root`);
	const albums = (JSON.parse(listText) as { albums?: ListedAlbum[] }).albums ?? [];
	const previous = await readLibraryReport(root, albumSearchResultName);
	const result: SearchResult = previous ? JSON.parse(previous) : {};
	// Albums that failed before are asked again; found ones are not.
	const todo = albums.filter((album) => !(album.key in result) || "error" in result[album.key]);
	let stoppedByRateLimit = false;
	for (const [index, album] of todo.entries()) {
		onProgress?.(index, todo.length);
		try {
			result[album.key] = { query: album.query, candidates: await (album.type === "tracks" ? searchTracks(album.query) : searchAlbums(album.query)) };
		} catch (error) {
			result[album.key] = { query: album.query, error: String(error) };
			if (/\b429\b/.test(String(error))) {
				stoppedByRateLimit = true;
				break;
			}
		}
		// Saved as it goes, so quitting TIDAL keeps what was found.
		if (index % 20 === 19) await writeLibraryReport(root, albumSearchResultName, JSON.stringify(result, null, 1));
		await pause(1500);
	}
	await writeLibraryReport(root, albumSearchResultName, JSON.stringify(result, null, 1));
	onProgress?.(todo.length, todo.length);
	const looked = albums.filter((album) => album.key in result && !("error" in result[album.key])).length;
	return { total: albums.length, looked, stoppedByRateLimit };
};
