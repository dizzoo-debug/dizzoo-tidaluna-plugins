import { MediaItem, TidalApi, redux } from "@luna/lib";

import { makeUnmatchedCsv, parseSpotifyCsv, type SpotifyTrackRow } from "./csv";
import { readCsvFile, writeUnmatchedReport } from "./files.native";
import { trace, unloads } from "./runtime";

type SearchResponse = {
	items?: redux.Track[];
};

export type ImportProgress = {
	fileName: string;
	fileIndex: number;
	fileCount: number;
	processed: number;
	total: number;
	stage: "matching" | "creating" | "adding" | "collection" | "done" | "cancelled";
};

export type ImportSummary = {
	fileName: string;
	playlistName: string;
	total: number;
	matched: number;
	unmatched: number;
	reportPath?: string;
	playlistUuid?: string;
};

let cancelRequested = false;
export const cancelImport = () => {
	cancelRequested = true;
};

const normalize = (value?: string | null) =>
	(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\b(?:remaster(?:ed)?|radio edit|single version|album version)\b(?:\s*\d{4})?/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

const tokenSimilarity = (left: string, right: string) => {
	const leftTokens = new Set(normalize(left).split(" ").filter(Boolean));
	const rightTokens = new Set(normalize(right).split(" ").filter(Boolean));
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection++;
	return intersection / new Set([...leftTokens, ...rightTokens]).size;
};

const candidateScore = (source: SpotifyTrackRow, candidate: redux.Track) => {
	const sourceTitle = normalize(source.trackName);
	const candidateTitle = normalize(candidate.title);
	let score = sourceTitle === candidateTitle ? 80 : tokenSimilarity(source.trackName, candidate.title) * 55;
	if (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle)) score += 15;

	const sourceArtists = normalize(source.artistNames);
	const candidateArtists = candidate.artists?.map((artist) => normalize(artist.name)) ?? [];
	if (candidateArtists.some((artist) => artist === sourceArtists || sourceArtists.includes(artist))) score += 35;
	else score += Math.max(0, ...candidateArtists.map((artist) => tokenSimilarity(source.artistNames, artist) * 25));

	if (source.albumName && normalize(candidate.album?.title) === normalize(source.albumName)) score += 15;
	if (source.durationMs && candidate.duration) {
		const difference = Math.abs(source.durationMs / 1000 - candidate.duration);
		if (difference <= 2) score += 20;
		else if (difference <= 5) score += 10;
	}
	return score;
};

const searchTrack = async (track: SpotifyTrackRow) => {
	const query = encodeURIComponent(`${track.artistNames} ${track.trackName}`.replaceAll("_", " ").trim());
	const response = await TidalApi.fetch<SearchResponse>(
		`https://desktop.tidal.com/v1/search/tracks?query=${query}&limit=15&offset=0&${TidalApi.queryArgs()}`,
	);
	const candidates = response?.items ?? [];
	const ranked = candidates.map((candidate) => ({ candidate, score: candidateScore(track, candidate) })).sort((a, b) => b.score - a.score);
	return ranked[0] && ranked[0].score >= 70 ? String(ranked[0].candidate.id) : undefined;
};

const resolveTrack = async (track: SpotifyTrackRow) => {
	if (track.isrc) {
		try {
			const mediaItem = await MediaItem.fromIsrc(track.isrc);
			if (mediaItem !== undefined) return String(mediaItem.id);
		} catch (error) {
			trace.warn(`ISRC lookup failed for ${track.artistNames} - ${track.trackName}; trying text search. ${String(error)}`);
		}
	}
	return searchTrack(track);
};

const chunks = <T>(items: T[], size: number) => {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
};

const createPlaylist = async (title: string, trackIds: string[], onProgress: (added: number) => void) => {
	const { playlist } = await redux.interceptActionResp(
		() =>
			redux.actions["folders/CREATE_PLAYLIST"]({
				description: "Imported from a Spotify CSV export by Spotify CSV Importer",
				folderId: "root",
				fromPlaylist: undefined,
				title,
			}),
		unloads,
		["content/LOAD_PLAYLIST_SUCCESS"],
		["content/LOAD_PLAYLIST_FAIL"],
		{ timeoutMs: 20_000 },
	);
	if (!playlist?.uuid) throw new Error(`TIDAL did not return a UUID for playlist "${title}"`);

	let added = 0;
	for (const ids of chunks(trackIds, 100)) {
		if (cancelRequested) break;
		await redux.interceptActionResp(
			() =>
				redux.actions["content/ADD_MEDIA_ITEMS_TO_PLAYLIST"]({
					addToIndex: -1,
					mediaItemIdsToAdd: ids,
					onDupes: "ADD",
					playlistUUID: playlist.uuid!,
					showNotification: false,
				}),
			unloads,
			["content/ADD_MEDIA_ITEMS_TO_PLAYLIST_SUCCESS"],
			["content/ADD_MEDIA_ITEMS_TO_PLAYLIST_FAIL"],
			{ timeoutMs: 30_000 },
		);
		added += ids.length;
		onProgress(added);
	}
	return String(playlist.uuid);
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

export const importCsvFiles = async (
	filePaths: string[],
	addToCollection: boolean,
	onProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary[]> => {
	cancelRequested = false;
	const summaries: ImportSummary[] = [];

	for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
		if (cancelRequested) break;
		const source = await readCsvFile(filePaths[fileIndex]);
		const tracks = parseSpotifyCsv(source.contents);
		const resolvedIds: (string | undefined)[] = new Array(tracks.length);
		let processed = 0;
		let cursor = 0;

		const worker = async () => {
			while (!cancelRequested) {
				const index = cursor++;
				if (index >= tracks.length) return;
				try {
					resolvedIds[index] = await resolveTrack(tracks[index]);
				} catch (error) {
					trace.warn(`Could not match row ${tracks[index].rowNumber}: ${String(error)}`);
				}
				processed++;
				if (processed === tracks.length || processed % 5 === 0) {
					onProgress({
						fileName: source.fileName,
						fileIndex,
						fileCount: filePaths.length,
						processed,
						total: tracks.length,
						stage: "matching",
					});
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, worker));
		if (cancelRequested) {
			onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed, total: tracks.length, stage: "cancelled" });
			break;
		}

		const matchedIds = resolvedIds.filter((id): id is string => id !== undefined);
		const unmatched = tracks
			.map((track, index) => ({ track, id: resolvedIds[index] }))
			.filter(({ id }) => id === undefined)
			.map(({ track }) => ({ track, reason: "No sufficiently close TIDAL match found" }));
		const reportPath = unmatched.length > 0 ? await writeUnmatchedReport(source.filePath, makeUnmatchedCsv(unmatched)) : undefined;

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
		const playlistUuid = await createPlaylist(source.playlistName, matchedIds, (added) =>
			onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: added, total: matchedIds.length, stage: "adding" }),
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
		};
		summaries.push(summary);
		onProgress({ fileName: source.fileName, fileIndex, fileCount: filePaths.length, processed: matchedIds.length, total: tracks.length, stage: "done" });
		trace.msg.log(`Imported ${summary.matched}/${summary.total} tracks into "${summary.playlistName}".`);
	}

	return summaries;
};
