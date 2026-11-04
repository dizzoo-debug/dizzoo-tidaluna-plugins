import { Tracer, type LunaUnload } from "@luna/core";
import { Album, ContextMenu, getPlaybackInfo, MediaItem, redux, safeInterval, safeTimeout, StyleTag } from "@luna/lib";

import { makeAlbumCreditsText, makeAlbumCreditsTextForAlbum } from "./credits";
import { getIndexedDownloadPath, isAlbumComplete, markAlbumComplete, rememberDownloadedTrack } from "./downloadIndex";
import { logDownload, type DownloadLogEntry } from "./downloadLog";
import { safeDownload, safeDownloadProgress } from "./download.native";
import { audioFileExists, fileExists, saveCoverArt, saveTextFileNextToAudio } from "./files.native";
import {
	applyTagFormat,
	addAtmosFolderSuffix,
	getCoverFileName,
	getCreditsFileName,
	getDownloadFolder,
	getDownloadPath,
	getFileName,
	getStablePathTags,
	type TagValues,
} from "./helpers";
import { settings } from "./Settings";

import styles from "file://downloadButton.css?minify";

export const { errSignal, trace } = Tracer("[SongDownloader]");
export const unloads = new Set<LunaUnload>();

new StyleTag("SongDownloader", unloads, styles);

const downloadButton = ContextMenu.addButton(unloads);
const creditsButton = ContextMenu.addButton(unloads);
const downloadState = { active: false, cancel: false };

const queuedFavoriteIds = new Set<string>();
const albumTrackIds = new Set<string>();
const queuedAlbumIds = new Set<string>();
const deferredRetryCounts = new Map<string, number>();
let autoDownloadQueue = Promise.resolve();
let autoAlbumQueue = Promise.resolve();

const deferredRetryDelays = [15 * 60_000, 30 * 60_000, 60 * 60_000];
// Startup Collection scan: gap between albums.
const albumScanPaceMs = 1000;

// On 429 an item goes to the back of its queue so everything TIDAL still serves keeps downloading.
// Each item gets a few such turns; after that tracks fall back to the deferred retries above, and
// albums wait for the next startup scan.
const maxRateLimitRequeues = 8;
const rateLimitRequeues = new Map<string, number>();
const isRateLimited = (error: unknown) => /\b429\b|too many requests/i.test(error instanceof Error ? `${error.message} ${error.cause ?? ""}` : String(error));

// Requeuing alone would spin through the queue when TIDAL refuses everything, so a run of 429s across
// items slows both queues down (30s, 60s, ... up to 5 min between items) until something succeeds.
let consecutiveRateLimits = 0;
const rateLimitGap = () => (consecutiveRateLimits < 5 ? 0 : Math.min(300_000, 30_000 * 2 ** Math.floor((consecutiveRateLimits - 5) / 5)));
const waitForRateLimit = async () => {
	const gap = rateLimitGap();
	if (gap === 0) return;
	trace.warn(`TIDAL keeps answering 429; pausing downloads for ${gap / 1000}s.`);
	await wait(gap);
};
/** Returns true when the item should be retried from the back of the queue. */
const requeueOnRateLimit = (key: string, error: unknown) => {
	if (!isRateLimited(error)) return false;
	consecutiveRateLimits++;
	const turns = (rateLimitRequeues.get(key) ?? 0) + 1;
	if (turns > maxRateLimitRequeues) {
		rateLimitRequeues.delete(key);
		return false;
	}
	rateLimitRequeues.set(key, turns);
	return true;
};
const noteSuccess = (key: string) => {
	consecutiveRateLimits = 0;
	rateLimitRequeues.delete(key);
};

const retryableDownloadError = (error: unknown) => {
	const text = error instanceof Error ? `${error.name} ${error.message} ${error.cause ?? ""}` : String(error);
	// "terminated" is undici's error when the CDN drops the connection mid-stream.
	return /\b(?:401|403|408|429|500|502|503|504)\b|forbidden|timed?\s*out|fetch failed|socket|network|terminated|aborted|premature close|other side closed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(text);
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

type ResolvedPlayback = {
	playbackInfo: NonNullable<Awaited<ReturnType<typeof getPlaybackInfo>>>;
	quality: redux.AudioQuality;
};

const resolvePlaybackInfo = async (mediaItem: MediaItem): Promise<ResolvedPlayback> => {
	const preferredQuality = settings.downloadQuality;
	const qualityCandidates: redux.AudioQuality[] = [preferredQuality];
	if (preferredQuality === "HI_RES_LOSSLESS" || preferredQuality === "HI_RES") {
		qualityCandidates.push("LOSSLESS");
	}

	let lastError: unknown;
	for (const quality of qualityCandidates) {
		try {
			const playbackInfo = await getPlaybackInfo(mediaItem.id, quality);
			if (playbackInfo === undefined) throw new Error(`Track ${mediaItem.id} is not available at ${quality}`);
			if (quality !== preferredQuality) {
				trace.warn(`TIDAL rejected ${preferredQuality} for track ${mediaItem.id}; using ${quality} instead.`);
			}
			return { playbackInfo, quality };
		} catch (error) {
			lastError = error;
			if (isRateLimited(error) || !retryableDownloadError(error)) throw error;
		}
	}
	throw lastError;
};

const getFileExtension = ({ manifestMimeType }: ResolvedPlayback["playbackInfo"]) => {
	switch (manifestMimeType) {
		case "application/vnd.tidal.bts":
			return "flac";
		case "application/dash+xml":
			return "m4a";
	}
};

const getActualDownloadFormat = ({ playbackInfo, quality }: ResolvedPlayback) => {
	const isAtmos = playbackInfo.audioMode === "DOLBY_ATMOS";
	const qualityLabels: Partial<Record<redux.AudioQuality, string>> = {
		HI_RES_LOSSLESS: "Hi-Res Lossless",
		HI_RES: "Hi-Res",
		LOSSLESS: "Lossless",
		HIGH: "High",
		LOW: "Low",
	};
	return { isAtmos, downloadedAudio: isAtmos ? "Dolby Atmos" : qualityLabels[quality] };
};

const downloadWithRetry = async (mediaItem: MediaItem, path: string | string[], initialPlayback: ResolvedPlayback) => {
	const maxAttempts = 3;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			// Do not use MediaItem.playbackInfo() here: it is memoized and can retain an expired signed URL.
			const playbackInfo = attempt === 1
				? initialPlayback.playbackInfo
				: await getPlaybackInfo(mediaItem.id, initialPlayback.quality);
			if (playbackInfo === undefined) throw new Error(`Track ${mediaItem.id} is not available`);
			const tags = await mediaItem.flacTags();
			await safeDownload(playbackInfo, path, tags, mediaItem.id);
			return playbackInfo;
		} catch (error) {
			lastError = error;
			// A 429 goes back to the queue instead of hitting TIDAL again right away.
			if (attempt >= maxAttempts || isRateLimited(error) || !retryableDownloadError(error)) throw error;
			trace.warn(`TIDAL download failed for track ${mediaItem.id}; retrying with a fresh URL (${attempt}/${maxAttempts}).`);
			await wait(attempt * 1500);
		}
	}
	throw lastError;
};

const getAlbumTagOverrides = async (album: Album): Promise<Partial<TagValues>> => {
	const overrides: Partial<TagValues> = {};
	const title = album.tidalAlbum.title;
	const artists = album.tidalAlbum.artists?.map(({ name }) => name) ??
		(album.tidalAlbum.artist?.name ? [album.tidalAlbum.artist.name] : []);
	const year = album.releaseYear ?? album.releaseDate?.slice(0, 4);
	const upc = album.tidalAlbum.upc;

	if (title) overrides.album = title;
	if (artists.length > 0) overrides.albumArtist = artists;
	if (year) overrides.year = year;
	if (album.releaseDate) overrides.date = album.releaseDate;
	if (upc) overrides.upc = upc;
	return overrides;
};

const queueFavoriteDownload = (
	itemId: redux.ItemId,
	fromFavoritedAlbum = false,
	albumTagOverrides?: Partial<TagValues>,
	sourceAlbum?: Album,
	startupResume = false,
	multiDiscAlbum?: boolean,
) => {
	const itemKey = String(itemId);
	if (fromFavoritedAlbum) albumTrackIds.add(itemKey);
	if (queuedFavoriteIds.has(itemKey)) return;
	queuedFavoriteIds.add(itemKey);
	// Filled in as the track resolves, so a failure can still be logged with whatever is known.
	const logEntry: Omit<DownloadLogEntry, "status"> = {
		source: startupResume ? "collection" : "favorite",
		trackId: itemId,
		album: sourceAlbum?.tidalAlbum.title,
		requested: settings.downloadQuality,
	};

	let requeue = false;

	autoDownloadQueue = autoDownloadQueue
		.then(async () => {
			// Already downloaded: decided from the local index and disk alone, with no TIDAL request.
			// Before this, every startup scan fetched track, tags and playback info for each existing file.
			if (startupResume) {
				const indexedPath = getIndexedDownloadPath(itemId);
				if (indexedPath !== undefined && (await audioFileExists(indexedPath))) return;
			}
			await waitForRateLimit();
			const isAlbumTrack = albumTrackIds.has(itemKey);
			if (isAlbumTrack ? !settings.autoDownloadAlbums : !settings.autoDownloadFavorites) return;
			if (!isAlbumTrack && !redux.store.getState().favorites.tracks.some((favoriteId) => String(favoriteId) === itemKey)) return;
			if (settings.defaultPath === undefined) {
				trace.warn("Auto-download skipped: set a Default save path in Song Downloader Deluxe settings first.");
				return;
			}

			let mediaItem = await MediaItem.fromId(itemId, "track");
			if (mediaItem === undefined) throw new Error(`Unable to load newly favorited track ${itemId}`);
			if (settings.useRealMAX) mediaItem = (await mediaItem.max()) ?? mediaItem;

			const { tags, coverUrl } = await mediaItem.flacTags();
			const archiveTags = await getStablePathTags(mediaItem, tags, albumTagOverrides);
			logEntry.artist = tags.artist?.[0];
			logEntry.title = String(tags.title ?? "");
			logEntry.album ??= archiveTags.album;
			const resolvedPlayback = await resolvePlaybackInfo(mediaItem);
			const { isAtmos, downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
			multiDiscAlbum ??= ((await mediaItem.album())?.tidalAlbum.numberOfVolumes ?? 1) > 1;
			let fileName = await getFileName(
				mediaItem,
				resolvedPlayback.quality,
				albumTagOverrides,
				multiDiscAlbum,
				getFileExtension(resolvedPlayback.playbackInfo),
			);
			if (isAtmos) fileName = addAtmosFolderSuffix(fileName, multiDiscAlbum);
			const audioPath = [settings.defaultPath, fileName];
			const indexedPath = getIndexedDownloadPath(itemId);
			if (startupResume && indexedPath !== undefined && (await audioFileExists(indexedPath))) {
				trace.log(`Collection resume skipped indexed track: ${archiveTags.artist?.[0]} - ${archiveTags.title}`);
				return;
			}

			if (!((settings.skipExistingFiles || startupResume) && (await audioFileExists(audioPath)))) {
				const delivered = await downloadWithRetry(mediaItem, audioPath, resolvedPlayback);
				trace.log(`Auto-downloaded newly favorited track: ${tags.artist?.[0]} - ${tags.title}`);
				await logDownload(settings.defaultPath, {
					...logEntry,
					status: "downloaded",
					delivered,
					file: audioPath,
					details: resolvedPlayback.quality !== settings.downloadQuality ? `TIDAL refused ${settings.downloadQuality}` : undefined,
				});
			} else {
				trace.log(`Auto-download skipped existing track: ${tags.artist?.[0]} - ${tags.title}`);
			}
			await rememberDownloadedTrack(itemId, audioPath);
			if (String(mediaItem.id) !== itemKey) await rememberDownloadedTrack(mediaItem.id, audioPath);

			if (settings.saveCoverArt && coverUrl !== undefined) {
				await saveCoverArt(audioPath, getCoverFileName(archiveTags), coverUrl);
			}
			if (settings.saveAlbumCredits) {
				const credits =
					sourceAlbum === undefined
						? await makeAlbumCreditsText(mediaItem, downloadedAudio)
						: await makeAlbumCreditsTextForAlbum(sourceAlbum, downloadedAudio);
				if (credits !== undefined) await saveTextFileNextToAudio(audioPath, getCreditsFileName(archiveTags), credits);
			}
			deferredRetryCounts.delete(itemKey);
			noteSuccess(`track:${itemKey}`);
		})
		.catch(async (error) => {
			if (requeueOnRateLimit(`track:${itemKey}`, error)) {
				trace.warn(`TIDAL rate limit (429) for track ${itemId}; moved to the end of the queue.`);
				requeue = true;
				return;
			}
			if (retryableDownloadError(error)) {
				const retryNumber = (deferredRetryCounts.get(itemKey) ?? 0) + 1;
				const delay = deferredRetryDelays[retryNumber - 1];
				if (delay !== undefined) {
					deferredRetryCounts.set(itemKey, retryNumber);
					trace.warn(
						`TIDAL server temporarily rejected track ${itemId}; deferred retry ${retryNumber}/${deferredRetryDelays.length} scheduled in ${delay / 60_000} minutes.`,
					);
					await logDownload(settings.defaultPath, {
						...logEntry,
						status: "retry later",
						details: `retry ${retryNumber}/${deferredRetryDelays.length} in ${delay / 60_000} min: ${String(error)}`,
					});
					safeTimeout(unloads, () => {
						queueFavoriteDownload(itemId, fromFavoritedAlbum, albumTagOverrides, sourceAlbum, startupResume, multiDiscAlbum);
					}, delay);
				} else {
					trace.warn(`TIDAL server still rejects track ${itemId}; it will be tried again during the next Collection startup scan.`);
					await logDownload(settings.defaultPath, {
						...logEntry,
						status: "failed",
						details: `gave up for now, tried again at next startup scan: ${String(error)}`,
					});
				}
				return;
			}
			await logDownload(settings.defaultPath, { ...logEntry, status: "failed", details: String(error) });
			trace.msg.err.withContext(`Failed to auto-download newly favorited track ${itemId}`)(error);
		})
		.finally(() => {
			queuedFavoriteIds.delete(itemKey);
			albumTrackIds.delete(itemKey);
			if (requeue) queueFavoriteDownload(itemId, fromFavoritedAlbum, albumTagOverrides, sourceAlbum, startupResume, multiDiscAlbum);
		});
};

const queueAlbumDownload = (albumId: redux.ItemId, startupResume = false) => {
	const albumKey = String(albumId);
	if (queuedAlbumIds.has(albumKey)) return;
	queuedAlbumIds.add(albumKey);

	const loadAlbum = async () => {
		const album = await Album.fromId(albumId);
		if (album === undefined) throw new Error(`Unable to load newly favorited album ${albumId}`);
		return { album, mediaItems: await album.mediaItems() };
	};

	let requeue = false;

	autoAlbumQueue = autoAlbumQueue
		.then(async () => {
			if (startupResume && isAlbumComplete(albumId)) return;
			// The queue runs one album at a time, so pacing here throttles the whole scan.
			if (startupResume) await wait(albumScanPaceMs);
			await waitForRateLimit();
			const { album, mediaItems: albumItems } = await loadAlbum();
			noteSuccess(`album:${albumKey}`);
			const mediaItems: MediaItem[] = [];
			for await (const mediaItem of albumItems) mediaItems.push(mediaItem);
			const present = await Promise.all(
				mediaItems.map(async (mediaItem) => {
					const indexedPath = getIndexedDownloadPath(mediaItem.id);
					return indexedPath !== undefined && (await audioFileExists(indexedPath));
				}),
			);
			if (mediaItems.length > 0 && present.every(Boolean)) {
				await markAlbumComplete(albumId);
				trace.log(`Album complete on disk, skipped from now on: ${album.tidalAlbum.title}`);
				return;
			}
			const albumTagOverrides = await getAlbumTagOverrides(album);
			const multiDiscAlbum = album.tidalAlbum.numberOfVolumes > 1;
			for await (const mediaItem of mediaItems) {
				queueFavoriteDownload(mediaItem.id, true, albumTagOverrides, album, startupResume, multiDiscAlbum);
			}
			trace.log(`Queued newly favorited album: ${album.tidalAlbum.title}`);
		})
		.catch(async (error) => {
			if (requeueOnRateLimit(`album:${albumKey}`, error)) {
				trace.warn(`TIDAL rate limit (429) for album ${albumId}; moved to the end of the queue.`);
				requeue = true;
				return;
			}
			await logDownload(settings.defaultPath, {
				status: "album skipped",
				source: startupResume ? "collection" : "favorite",
				details: `album ${albumId}: ${String(error)}`,
			});
			// A startup scan covers the whole Collection; one toast per album would flood the screen.
			if (startupResume) trace.warn(`Collection scan skipped album ${albumId} this time: ${String(error)}`);
			else trace.msg.err.withContext(`Failed to queue newly favorited album ${albumId}`)(error);
		})
		.finally(() => {
			queuedAlbumIds.delete(albumKey);
			if (requeue) queueAlbumDownload(albumId, startupResume);
		});
};

const initialFavorites = redux.store.getState().favorites;
let favoriteStateHydrated = Object.values(initialFavorites).some((itemIds) => itemIds.length > 0);
let knownFavoriteAlbumIds = new Set(initialFavorites.albums.map(String));
let startupResumeStarted = false;

const resumeCollectionAlbums = (albumIds: redux.ItemId[]) => {
	if (startupResumeStarted || !settings.resumeCollectionAlbums || !settings.autoDownloadAlbums) return;
	startupResumeStarted = true;
	if (settings.defaultPath === undefined) {
		trace.warn("Collection resume skipped: set a Default save path in Song Downloader Deluxe settings first.");
		return;
	}
	trace.log(`Startup Collection scan queued ${albumIds.length} favorite album(s). Existing audio files will be skipped.`);
	for (const albumId of albumIds) queueAlbumDownload(albumId, true);
};

if (favoriteStateHydrated) queueMicrotask(() => resumeCollectionAlbums(initialFavorites.albums));

unloads.add(
	redux.store.subscribe(() => {
		const favorites = redux.store.getState().favorites;
		const currentAlbumIds = new Set(favorites.albums.map(String));
		if (!favoriteStateHydrated) {
			if (!Object.values(favorites).some((itemIds) => itemIds.length > 0)) return;
			knownFavoriteAlbumIds = currentAlbumIds;
			favoriteStateHydrated = true;
			resumeCollectionAlbums(favorites.albums);
			return;
		}

		const addedAlbumIds = favorites.albums.filter((albumId) => !knownFavoriteAlbumIds.has(String(albumId)));
		knownFavoriteAlbumIds = currentAlbumIds;
		if (!settings.autoDownloadAlbums) return;
		for (const albumId of addedAlbumIds) queueAlbumDownload(albumId);
	}),
);

const pendingFavoriteIds: redux.ItemId[] = [];
const isTrackId = (itemId: redux.ItemId) => /^\d+$/.test(String(itemId));
const personalizedRadioPattern =
	/(?:personal(?:ized|ised)?.{0,32}(?:radio|station)|(?:radio|station).{0,32}personal(?:ized|ised)?)/i;

redux.intercept("content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES", unloads, ({ mediaItemIds, moduleId, name }) => {
	if (!settings.autoDownloadFavorites) return;
	const actionContext = `${moduleId ?? ""} ${name ?? ""}`;
	if (personalizedRadioPattern.test(actionContext)) {
		trace.log(`Ignored personalized radio favorite action: ${actionContext.trim() || "unknown radio"}`);
		return;
	}

	const trackIds = mediaItemIds.filter(isTrackId);
	if (trackIds.length !== mediaItemIds.length) {
		trace.log(`Ignored ${mediaItemIds.length - trackIds.length} non-track favorite item(s), such as a mix or radio station.`);
	}
	pendingFavoriteIds.push(...trackIds);
});
redux.intercept("content/ADD_ITEMS_TO_FAVORITES_SUCCESS", unloads, () => {
	const itemIds = pendingFavoriteIds.splice(0);
	if (!settings.autoDownloadFavorites) return;
	for (const itemId of itemIds) queueFavoriteDownload(itemId);
});

ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
	if (!(mediaCollection instanceof Album)) return;
	creditsButton.text = "Download Album Credits";
	creditsButton.onClick(async () => {
		try {
			creditsButton.text = "Loading album credits...";
			let firstMediaItem: MediaItem | undefined;
			for await (const mediaItem of await mediaCollection.mediaItems()) {
				firstMediaItem = mediaItem;
				break;
			}
			if (firstMediaItem === undefined) throw new Error(`Album ${mediaCollection.id} has no downloadable tracks`);

			const { tags: enrichedTags } = await firstMediaItem.flacTags();
			const albumTagOverrides = await getAlbumTagOverrides(mediaCollection);
			const tags = await getStablePathTags(firstMediaItem, enrichedTags, albumTagOverrides);
			const multiDiscAlbum = mediaCollection.tidalAlbum.numberOfVolumes > 1;
			const resolvedPlayback = await resolvePlaybackInfo(firstMediaItem);
			const { isAtmos, downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
			let audioPath: string | string[];
			if (settings.defaultPath !== undefined) {
				const pathFormat = multiDiscAlbum ? settings.multiDiscPathFormat : settings.pathFormat;
				let relativePath = `${applyTagFormat(pathFormat, tags)}.flac`;
				if (isAtmos) relativePath = addAtmosFolderSuffix(relativePath, multiDiscAlbum);
				audioPath = [settings.defaultPath, relativePath];
			} else {
				const selectedFolder = await getDownloadFolder();
				if (selectedFolder === undefined) {
					creditsButton.text = "Download Album Credits";
					return;
				}
				audioPath = [selectedFolder, "album.flac"];
			}

			const credits = await makeAlbumCreditsTextForAlbum(mediaCollection, downloadedAudio);
			await saveTextFileNextToAudio(audioPath, getCreditsFileName(tags), credits, true);
			creditsButton.text = "Album Credits Saved";
			setTimeout(() => (creditsButton.text = "Download Album Credits"), 3000);
		} catch (error) {
			creditsButton.text = "Failed to Save Album Credits";
			trace.msg.err.withContext(`Failed to manually save album credits for ${mediaCollection.tidalAlbum.title}`)(error);
		}
	});
	await creditsButton.show(contextMenu);
});

export { Settings } from "./Settings";
ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
	const trackCount = await mediaCollection.count();
	if (trackCount === 0) return;

	const defaultText = (downloadButton.text = `Download ${trackCount} tracks`);

	downloadButton.onClick(async () => {
		if (downloadButton.elem === undefined) return;
		// Clicking while a download is running requests it to stop after the current track
		if (downloadState.active) {
			downloadState.cancel = true;
			downloadButton.text = `Stopping...`;
			return;
		}
		const downloadFolder = settings.defaultPath ?? (trackCount > 1 ? await getDownloadFolder() : undefined);
		downloadState.active = true;
		downloadState.cancel = false;
		downloadButton.elem.classList.add("download-button");
		let downloadedCount = 0;
		let skippedCount = 0;
		const sourceAlbum = mediaCollection instanceof Album ? mediaCollection : undefined;
		const albumTagOverrides = sourceAlbum === undefined ? undefined : await getAlbumTagOverrides(sourceAlbum);
		const sourceIsMultiDisc = sourceAlbum?.tidalAlbum.numberOfVolumes !== undefined
			? sourceAlbum.tidalAlbum.numberOfVolumes > 1
			: undefined;
		try {
			for await (let mediaItem of await mediaCollection.mediaItems()) {
				if (downloadState.cancel) break;
				const sourceItemId = mediaItem.id;
				if (settings.useRealMAX) {
					downloadButton.text = `Checking RealMax...`;
					mediaItem = (await mediaItem.max()) ?? mediaItem;
				}

				downloadButton.text = `Loading tags...`;
				const { tags, coverUrl } = await mediaItem.flacTags();
				const archiveTags = await getStablePathTags(mediaItem, tags, albumTagOverrides);
				const resolvedPlayback = await resolvePlaybackInfo(mediaItem);
				const { isAtmos, downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
				const multiDiscAlbum = sourceIsMultiDisc ?? (((await mediaItem.album())?.tidalAlbum.numberOfVolumes ?? 1) > 1);

				downloadButton.text = `Fetching filename...`;
				let fileName = await getFileName(
					mediaItem,
					resolvedPlayback.quality,
					albumTagOverrides,
					multiDiscAlbum,
					getFileExtension(resolvedPlayback.playbackInfo),
				);
				if (isAtmos) fileName = addAtmosFolderSuffix(fileName, multiDiscAlbum);

				downloadButton.text = `Fetching download path...`;
				const path = downloadFolder !== undefined ? [downloadFolder, fileName] : await getDownloadPath(fileName);
				if (path === undefined) return;

				const alreadyExists = settings.skipExistingFiles && (await audioFileExists(path));
				let downloadSucceeded = false;
				if (alreadyExists) {
					skippedCount++;
					downloadButton.text = `Skipped existing (${skippedCount})`;
				} else {
					downloadButton.text = `Downloading...`;
					const clearInterval = safeInterval(
						unloads,
						async () => {
							const progress = await safeDownloadProgress(mediaItem.id);
							if (progress === undefined) return;
							const { total, downloaded } = progress;
							if (total === undefined || downloaded === undefined || total <= 0) return;
							const percent = (downloaded / total) * 100;
							downloadButton.elem!.style.setProperty("--progress", `${percent}%`);
							const downloadedMB = (downloaded / 1048576).toFixed(0);
							const totalMB = (total / 1048576).toFixed(0);
							downloadButton.text = `Downloading... ${downloadedMB}/${totalMB}MB ${percent.toFixed(0)}%`;
						},
						50,
					);
					const logEntry = {
						source: "manual" as const,
						artist: tags.artist?.[0],
						album: archiveTags.album,
						title: String(tags.title ?? ""),
						trackId: mediaItem.id,
						requested: settings.downloadQuality,
						file: path,
					};
					try {
						const delivered = await downloadWithRetry(mediaItem, path, resolvedPlayback);
						downloadedCount++;
						downloadSucceeded = true;
						await logDownload(settings.defaultPath, { ...logEntry, status: "downloaded", delivered });
					} catch (error) {
						await logDownload(settings.defaultPath, { ...logEntry, status: "failed", details: String(error) });
						trace.msg.err.withContext(`Failed to download ${tags.title}`)(error);
					} finally {
						clearInterval();
					}
				}
				if (alreadyExists || downloadSucceeded) {
					await rememberDownloadedTrack(sourceItemId, path);
					if (String(mediaItem.id) !== String(sourceItemId)) await rememberDownloadedTrack(mediaItem.id, path);
				}

				if (settings.saveCoverArt && coverUrl !== undefined) {
					downloadButton.text = `Saving cover art...`;
					await saveCoverArt(path, getCoverFileName(archiveTags), coverUrl).catch(
						trace.msg.err.withContext(`Failed to save cover art for ${archiveTags.album}`),
					);
				}

				if (settings.saveAlbumCredits) {
					downloadButton.text = `Saving album credits...`;
					const credits =
						sourceAlbum === undefined
							? await makeAlbumCreditsText(mediaItem, downloadedAudio)
							: await makeAlbumCreditsTextForAlbum(sourceAlbum, downloadedAudio);
					if (credits !== undefined) {
						await saveTextFileNextToAudio(path, getCreditsFileName(archiveTags), credits).catch(
							trace.msg.err.withContext(`Failed to save album credits for ${archiveTags.album}`),
						);
					}
				}
			}
		} finally {
			downloadState.active = false;
			downloadState.cancel = false;
			downloadButton.text = `Done: ${downloadedCount} downloaded, ${skippedCount} skipped`;
			downloadButton.elem?.classList.remove("download-button");
			setTimeout(() => {
				if (!downloadState.active) downloadButton.text = defaultText;
			}, 3000);
		}
	});

	await downloadButton.show(contextMenu);
});
