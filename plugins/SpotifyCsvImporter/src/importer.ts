import { TidalApi, redux } from "@luna/lib";

import { apiGet, getAlbum, getTrack, isrcTrackIds, requestsSent, resetRateLimitTracking, searchTracks, throttledSeconds, TidalRateLimitError } from "./api";
import { makeUnmatchedCsv, makeUnmatchedText, parseSpotifyCsv, type SpotifyTrackRow } from "./csv";
import { readCsvFile, writeUnmatchedReports } from "./files.native";
import { findDirectAlbumMatch, MIN_TRACK_SCORE, pickBestCandidate, trackScore, type Candidate, type CandidateTrack } from "./matching";
import { planMerge, shiftedIndexes } from "./merge";
import { trace } from "./runtime";

export type ImportProgress = {
	fileName: string;
	fileIndex: number;
	fileCount: number;
	processed: number;
	total: number;
	stage: "matching" | "creating" | "replacing" | "adding" | "collection" | "done" | "cancelled";
	/** Seconds until TIDAL's rate limit lets requests through again. */
	waitSeconds?: number;
};

export type ImportSummary = {
	fileName: string;
	playlistName: string;
	total: number;
	matched: number;
	unmatched: number;
	reportPath?: string;
	playlistUuid?: string;
	addedToExisting?: boolean;
	/** Matched tracks skipped because the existing playlist already contained them. */
	alreadyPresent?: number;
	/** Existing entries swapped for the newly chosen version of the same recording. */
	replaced?: number;
};

let cancelRequested = false;
export const cancelImport = () => {
	cancelRequested = true;
};

// Per-row request budget. The first import of this feature spent 30-110 requests per row and got the
// account rate-limited; the steps below stop as soon as the answer is clear, so most rows cost 1-3.
const MAX_ISRC_VERSIONS = 8;
const MAX_ALBUM_LOOKUPS = 6;

const chunks = <T>(items: T[], size: number) => {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
};

const isrcVersions = async (isrc: string) => {
	const tracks: redux.Track[] = [];
	// Sequential: these share the global limiter anyway, and an early 429 then stops the rest.
	for (const id of await isrcTrackIds(isrc, MAX_ISRC_VERSIONS)) {
		const track = await getTrack(id);
		if (track !== undefined) tracks.push(track);
	}
	return tracks;
};

const logChoice = (track: SpotifyTrackRow, best: Candidate, how: string) =>
	trace.log(
		`Row ${track.rowNumber}: ${track.artistNames} - ${track.trackName} -> TIDAL ${best.track.id} "${best.album?.title ?? best.track.album?.title ?? "?"}"` +
			` (${best.album?.type ?? "?"}, ${best.album?.releaseDate ?? "?"}; ${how})`,
	);

const resolveTrack = async (track: SpotifyTrackRow, preferOriginalAlbums: boolean): Promise<CandidateTrack | undefined> => {
	const candidates = new Map<string, Candidate>();
	const rowIsrc = track.isrc?.trim().toUpperCase();
	const add = (tidalTrack: redux.Track, fromIsrc: boolean) => {
		const id = String(tidalTrack.id);
		const sameIsrc = fromIsrc || (rowIsrc !== undefined && tidalTrack.isrc?.toUpperCase() === rowIsrc);
		const existing = candidates.get(id);
		if (existing === undefined) candidates.set(id, { track: tidalTrack, fromIsrc: sameIsrc });
		else existing.fromIsrc ||= sameIsrc;
	};
	const all = () => [...candidates.values()];

	// 1. One search request. Its results carry the album title, which settles most rows on its own.
	for (const result of await searchTracks(`${track.artistNames} ${track.trackName}`, 15)) add(result, false);
	if (preferOriginalAlbums) {
		const direct = findDirectAlbumMatch(track, all());
		if (direct !== undefined) {
			logChoice(track, direct, "search");
			return direct.track;
		}
	}

	// 2. Every release of the recording, by ISRC (Spotify's, or the best text match's).
	const bestText = all()
		.filter((candidate) => trackScore(track, candidate.track) >= MIN_TRACK_SCORE && candidate.track.isrc)
		.sort((a, b) => trackScore(track, b.track) - trackScore(track, a.track))[0];
	const isrc = rowIsrc ?? bestText?.track.isrc ?? undefined;
	const needIsrc = preferOriginalAlbums || all().every((candidate) => !candidate.fromIsrc && trackScore(track, candidate.track) < MIN_TRACK_SCORE);
	if (isrc && needIsrc) {
		try {
			for (const version of await isrcVersions(isrc)) add(version, true);
		} catch (error) {
			if (error instanceof TidalRateLimitError) throw error;
			trace.warn(`ISRC lookup failed for ${track.artistNames} - ${track.trackName}; using search results only. ${String(error)}`);
		}
		if (preferOriginalAlbums) {
			const direct = findDirectAlbumMatch(track, all());
			if (direct !== undefined) {
				logChoice(track, direct, "isrc");
				return direct.track;
			}
		}
	}

	// 3. Only now pay for album details, for a few distinct albums, to tell originals from compilations.
	if (preferOriginalAlbums) {
		const seenAlbums = new Set<string>();
		const plausible = all()
			.filter((candidate) => candidate.fromIsrc || trackScore(track, candidate.track) >= MIN_TRACK_SCORE)
			.sort((a, b) => trackScore(track, b.track) - trackScore(track, a.track))
			.filter((candidate) => {
				const albumId = candidate.track.album?.id;
				if (albumId === undefined || seenAlbums.has(String(albumId))) return false;
				seenAlbums.add(String(albumId));
				return true;
			})
			.slice(0, MAX_ALBUM_LOOKUPS);
		for (const candidate of plausible) {
			candidate.album = await getAlbum(candidate.track.album!.id).catch((error) => {
				if (error instanceof TidalRateLimitError) throw error;
				return undefined;
			});
		}
		// Same album id, same details: share them with the other candidates on that album.
		const albumsById = new Map(plausible.filter((c) => c.album).map((c) => [String(c.track.album!.id), c.album]));
		for (const candidate of all()) candidate.album ??= albumsById.get(String(candidate.track.album?.id));
	}

	const best = pickBestCandidate(track, all(), preferOriginalAlbums);
	if (best === undefined) return undefined;
	logChoice(track, best, preferOriginalAlbums ? "albums compared" : "match");
	return best.track;
};

const tidalWrite = async <T>(
	url: string,
	body: URLSearchParams | undefined,
	extraHeaders: Record<string, string> = {},
	method: "POST" | "DELETE" = "POST",
): Promise<T> => {
	const response = await fetch(url, {
		method,
		headers: {
			...(await TidalApi.getAuthHeaders()),
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			...extraHeaders,
		},
		body,
	});
	if (!response.ok) {
		const details = (await response.text()).slice(0, 300);
		throw new Error(`TIDAL API ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
};

const getPlaylistWriteState = async (playlistUuid: string) => {
	const response = await fetch(`https://desktop.tidal.com/v1/playlists/${playlistUuid}?${TidalApi.queryArgs()}`, {
		headers: await TidalApi.getAuthHeaders(),
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`TIDAL API ${response.status} ${response.statusText} while reading playlist ETag`);
	const etag = response.headers.get("etag");
	if (!etag) throw new Error("TIDAL did not return the playlist ETag required for writing");
	return { playlist: (await response.json()) as redux.Playlist, etag };
};

/**
 * Runs a playlist write with a freshly read ETag. A 412 means TIDAL rejected it unapplied because the
 * playlist changed in between (often TIDAL's own UI syncing), so it is safe to retry with a new ETag.
 */
const withPlaylistEtag = async <T>(playlistUuid: string, write: (state: Awaited<ReturnType<typeof getPlaylistWriteState>>) => Promise<T>) => {
	for (let attempt = 1; ; attempt++) {
		const state = await getPlaylistWriteState(playlistUuid);
		try {
			return await write(state);
		} catch (error) {
			if (attempt >= 4 || !/\b412\b/.test(String(error))) throw error;
			trace.warn(`Playlist changed while writing (412); retrying with a fresh ETag (${attempt}/3).`);
			await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
		}
	}
};

type Page<T> = { items?: T[]; totalNumberOfItems?: number };

const readAllPages = async <T>(baseUrl: string) => {
	const items: T[] = [];
	// Advance by what TIDAL actually returned: it may cap the page below the requested limit.
	for (let page = 0; page < 1000; page++) {
		const response = await apiGet<Page<T>>(`${baseUrl}?limit=100&offset=${items.length}&${TidalApi.queryArgs()}`);
		if (response === undefined) throw new Error(`TIDAL returned nothing for ${baseUrl}`);
		const pageItems = response.items ?? [];
		items.push(...pageItems);
		if (pageItems.length === 0 || (response.totalNumberOfItems !== undefined && items.length >= response.totalNumberOfItems)) return items;
	}
	throw new Error(`Too many pages while reading ${baseUrl}`);
};

const normalizeTitle = (title: string) => title.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/**
 * The user's own playlist with this title (case-insensitive). Among same-named ones (e.g. left behind by
 * earlier imports) the fullest wins, so an empty leftover of a failed import is never picked over the real one.
 */
const findOwnPlaylist = async (title: string) => {
	const userId = redux.store.getState().user.meta.id;
	const playlists = await readAllPages<redux.Playlist>(`https://desktop.tidal.com/v1/users/${userId}/playlists`);
	const sameName = playlists
		.filter((playlist) => normalizeTitle(playlist.title) === normalizeTitle(title) && String(playlist.creator?.id ?? userId) === String(userId))
		.sort((a, b) => (b.numberOfTracks ?? 0) - (a.numberOfTracks ?? 0) || (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""));
	if (sameName.length === 0) {
		trace.msg.log(`No playlist named "${title}" among your ${playlists.length} playlists; creating a new one.`);
	} else if (sameName.length > 1) {
		trace.msg.log(
			`${sameName.length} playlists are named "${title}"; using the one with ${sameName[0].numberOfTracks} tracks. ` +
				`Delete the others to avoid confusion.`,
		);
	}
	return sameName[0];
};

/** All playlist entries in order; videos are kept as placeholders so indexes stay aligned with TIDAL's. */
const playlistEntries = async (playlist: redux.Playlist): Promise<CandidateTrack[]> => {
	const items = await readAllPages<redux.MediaItem>(`https://desktop.tidal.com/v1/playlists/${playlist.uuid}/items`);
	// Planning against a partial read would re-add or replace the wrong entries, so refuse instead.
	const expected = (playlist.numberOfTracks ?? 0) + (playlist.numberOfVideos ?? 0);
	if (items.length < expected) throw new Error(`Read only ${items.length}/${expected} items of "${playlist.title}"; not modifying it`);
	return items.map((entry) => (entry.type === "track" ? (entry.item as redux.Track) : { id: `video:${entry.item.id}`, title: "" }));
};

const createPlaylist = async (title: string) => {
	const userId = redux.store.getState().user.meta.id;
	const playlist = await tidalWrite<redux.Playlist>(
		`https://desktop.tidal.com/v1/users/${userId}/playlists?${TidalApi.queryArgs()}`,
		new URLSearchParams({
			title,
			description: "Imported from a Spotify CSV export by Spotify CSV Importer",
		}),
	);
	if (!playlist?.uuid) throw new Error(`TIDAL did not return a UUID for playlist "${title}"`);
	return String(playlist.uuid);
};

const appendTracks = async (playlistUuid: string, trackIds: string[], onProgress: (added: number) => void) => {
	let added = 0;
	for (const ids of chunks(trackIds, 100)) {
		if (cancelRequested) break;
		await withPlaylistEtag(playlistUuid, ({ playlist: currentPlaylist, etag }) =>
			tidalWrite<void>(
				`https://desktop.tidal.com/v1/playlists/${playlistUuid}/items?${TidalApi.queryArgs()}`,
				new URLSearchParams({
					trackIds: ids.join(","),
					toIndex: String(currentPlaylist.numberOfTracks),
					onDupes: "ADD",
					onArtifactNotFound: "SKIP",
				}),
				{ "If-None-Match": etag },
			),
		);
		added += ids.length;
		onProgress(added);
	}
};

/**
 * Swaps entries for another version in place. New tracks are inserted right after the old ones from the
 * bottom up, then the old ones (plus `remove`, surplus copies) go in one call, so an interruption can only
 * leave both versions — which the next import's plan then lists under `remove`.
 */
const replaceEntries = async (
	playlistUuid: string,
	replacements: { index: number; id: string }[],
	remove: number[],
	onProgress: (done: number) => void,
) => {
	const inserted: number[] = [];
	for (const { index, id } of [...replacements].sort((a, b) => b.index - a.index)) {
		if (cancelRequested) break;
		await withPlaylistEtag(playlistUuid, ({ etag }) =>
			tidalWrite<void>(
				`https://desktop.tidal.com/v1/playlists/${playlistUuid}/items?${TidalApi.queryArgs()}`,
				new URLSearchParams({ trackIds: id, toIndex: String(index + 1), onDupes: "ADD", onArtifactNotFound: "SKIP" }),
				{ "If-None-Match": etag },
			),
		);
		inserted.push(index);
		onProgress(inserted.length);
	}
	const toDelete = [...shiftedIndexes(inserted), ...shiftedIndexes(remove, inserted)].sort((a, b) => a - b);
	if (toDelete.length === 0) return 0;
	await withPlaylistEtag(playlistUuid, ({ etag }) =>
		tidalWrite<void>(
			`https://desktop.tidal.com/v1/playlists/${playlistUuid}/items/${toDelete.join(",")}?${TidalApi.queryArgs()}`,
			undefined,
			{ "If-None-Match": etag },
			"DELETE",
		),
	);
	return inserted.length;
};

const addTracksToCollection = async (trackIds: string[], onProgress: (added: number) => void) => {
	const uniqueIds = [...new Set(trackIds)];
	let added = 0;
	for (const ids of chunks(uniqueIds, 100)) {
		if (cancelRequested) break;
		redux.actions["content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES"]({
			forceFavorite: true,
			from: "contextMenu",
			mediaItemIds: ids,
			moduleId: "spotify-csv-importer",
			name: "Spotify CSV Importer",
		});
		added += ids.length;
		onProgress(added);
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
};

export type ImportOptions = {
	addToCollection: boolean;
	preferOriginalAlbums: boolean;
	/** Append to an existing playlist with the same title instead of creating a new one. */
	mergeIntoExisting: boolean;
	/** When merging, swap other versions of a recording (e.g. compilation copies) for the newly chosen one. */
	replaceVersions: boolean;
};

export const importCsvFiles = async (
	filePaths: string[],
	{ addToCollection, preferOriginalAlbums, mergeIntoExisting, replaceVersions }: ImportOptions,
	onProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary[]> => {
	cancelRequested = false;
	resetRateLimitTracking();
	const summaries: ImportSummary[] = [];

	for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
		if (cancelRequested) break;
		const source = await readCsvFile(filePaths[fileIndex]);
		const tracks = parseSpotifyCsv(source.contents);
		const resolved: (CandidateTrack | undefined)[] = new Array(tracks.length);
		let processed = 0;
		let cursor = 0;
		let rateLimited: TidalRateLimitError | undefined;

		const worker = async () => {
			while (!cancelRequested && rateLimited === undefined) {
				const index = cursor++;
				if (index >= tracks.length) return;
				try {
					resolved[index] = await resolveTrack(tracks[index], preferOriginalAlbums);
				} catch (error) {
					if (error instanceof TidalRateLimitError) {
						rateLimited = error;
						return;
					}
					trace.warn(`Could not match row ${tracks[index].rowNumber}: ${String(error)}`);
				}
				processed++;
				reportMatching();
			}
		};
		const reportMatching = () =>
			onProgress({
				fileName: source.fileName,
				fileIndex,
				fileCount: filePaths.length,
				processed,
				total: tracks.length,
				stage: "matching",
				waitSeconds: throttledSeconds(),
			});

		// Rows can take a while (and TIDAL may throttle), so refresh the status even when no row finished.
		reportMatching();
		const heartbeat = setInterval(reportMatching, 1000);
		try {
			await Promise.all(Array.from({ length: Math.min(2, tracks.length) }, worker));
		} finally {
			clearInterval(heartbeat);
		}
		// Nothing has been written yet at this point, so stopping leaves every playlist untouched.
		if (rateLimited !== undefined) throw rateLimited;
		if (cancelRequested) {
			onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed, total: tracks.length, stage: "cancelled" });
			break;
		}

		const matchedIds = resolved.filter((track) => track !== undefined).map((track) => String(track.id));
		const unmatched = tracks
			.map((track, index) => ({ track, id: resolved[index] }))
			.filter(({ id }) => id === undefined)
			.map(({ track }) => ({ track, reason: "No sufficiently close TIDAL match found" }));
		const reportPath =
			unmatched.length > 0
				? await writeUnmatchedReports(source.filePath, makeUnmatchedText(unmatched), makeUnmatchedCsv(unmatched))
				: undefined;

		if (matchedIds.length === 0) {
			summaries.push({
				fileName: source.fileName,
				playlistName: source.playlistName,
				total: tracks.length,
				matched: 0,
				unmatched: unmatched.length,
				reportPath,
			});
			continue;
		}

		onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: 0, total: matchedIds.length, stage: "creating" });
		const existing = mergeIntoExisting ? await findOwnPlaylist(source.playlistName) : undefined;
		const playlistUuid = existing ? String(existing.uuid) : await createPlaylist(source.playlistName);
		let idsToAdd = matchedIds;
		let alreadyPresent = 0;
		let replaced = 0;
		let removed = 0;
		if (existing) {
			// Re-importing the same CSV only fixes and completes the playlist instead of duplicating it.
			const plan = planMerge(tracks, resolved, await playlistEntries(existing), replaceVersions);
			idsToAdd = plan.append;
			alreadyPresent = plan.alreadyPresent;
			trace.log(
				`Existing playlist "${existing.title}": ${plan.alreadyPresent} kept, ${plan.replacements.length} to replace, ${plan.remove.length} extra copies to remove, ${plan.append.length} to add.`,
			);
			removed = plan.remove.length;
			replaced = await replaceEntries(playlistUuid, plan.replacements, plan.remove, (done) =>
				onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: done, total: plan.replacements.length, stage: "replacing" }),
			);
		}
		await appendTracks(playlistUuid, idsToAdd, (added) =>
			onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: added, total: idsToAdd.length, stage: "adding" }),
		);

		if (addToCollection && !cancelRequested) {
			await addTracksToCollection(matchedIds, (added) =>
				onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: added, total: new Set(matchedIds).size, stage: "collection" }),
			);
		}

		const summary = {
			fileName: source.fileName,
			playlistName: source.playlistName,
			total: tracks.length,
			matched: matchedIds.length,
			unmatched: unmatched.length,
			reportPath,
			playlistUuid,
			addedToExisting: existing !== undefined,
			alreadyPresent,
			replaced,
		};
		summaries.push(summary);
		onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: matchedIds.length, total: tracks.length, stage: "done" });
		trace.msg.log(
			summary.addedToExisting
				? `Updated "${summary.playlistName}": ${summary.replaced} replaced with better versions, ${removed} extra copies removed, ${idsToAdd.length} added, ${summary.alreadyPresent} already fine.`
				: `Imported ${summary.matched}/${summary.total} tracks into "${summary.playlistName}".`,
		);
		trace.log(`${source.fileName}: ${requestsSent()} TIDAL catalogue requests so far in this import (${tracks.length} rows in this file).`);
	}

	return summaries;
};
