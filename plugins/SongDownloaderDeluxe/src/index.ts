import { Tracer, type LunaUnload } from "@luna/core";
import { Album, ContextMenu, getCredentials, getPlaybackInfo, MediaItem, redux, safeInterval, safeTimeout, StyleTag, TidalApi } from "@luna/lib";

import { makeAlbumCreditsText, makeAlbumCreditsTextForAlbum } from "./credits";
import {
	forgetDownloadedFile,
	getIndexedDownloadPath,
	isAlbumComplete,
	isTrackUnavailable,
	markAlbumComplete,
	markTrackAvailable,
	markTrackUnavailable,
	rememberDownloadedTrack,
	reindexFromLibrary,
	trackIdsForPath,
} from "./downloadIndex";
import { logDownload, type DownloadLogEntry } from "./downloadLog";
import { atmosAvailable, getAtmosPlaybackInfo, hasAtmosLogin } from "./atmos";
import { safeDownload, safeDownloadProgress } from "./download.native";
import {
	albumExtrasPresent,
	audioFileExists,
	fileExists,
	quarantineFolderFor,
	quarantineTrack,
	replaceWithQuarantine,
	saveCoverArt,
	saveTextFileNextToAudio,
} from "./files.native";
import { setTidalReplacer } from "./identifyLibrary";
import {
	applyTagFormat,
	getCoverFileName,
	getCreditsFileName,
	getDownloadFolder,
	getDownloadPath,
	getEmbeddedTags,
	getFileName,
	getStablePathTags,
	formatTidalTitle,
	type ArchiveTagValues,
	type TagValues,
} from "./helpers";
import { addFolderVariants, formatVariantSuffix, technicalVariants } from "./archiveLayout";
import { settings } from "./Settings";

import styles from "file://downloadButton.css?minify";

export const { errSignal, trace } = Tracer("[SongDownloader]");
export const unloads = new Set<LunaUnload>();

// Luna can leave the previous copy of the plugin running after an update without a full TIDAL restart
// (seen 2026-11-11: every download twice, same second). The newest copy takes over; older copies stop
// starting work, so nothing is requested from TIDAL twice.
const instanceKey = "__songDownloaderDeluxeInstance";
const instance = Symbol("SongDownloaderDeluxe");
const globals = globalThis as unknown as Record<string, symbol | undefined>;
globals[instanceKey] = instance;
const superseded = () => globals[instanceKey] !== instance;
unloads.add(() => {
	if (globals[instanceKey] === instance) delete globals[instanceKey];
});

new StyleTag("SongDownloader", unloads, styles);

const downloadButton = ContextMenu.addButton(unloads);
const creditsButton = ContextMenu.addButton(unloads);
const downloadState = { active: false, cancel: false };

const queuedFavoriteIds = new Set<string>();
/** Track id → the Collection album that queued it. */
const albumTrackIds = new Map<string, string>();
const queuedAlbumIds = new Set<string>();
/** Favorites added on another device (the phone) that the desktop app has not loaded; see pollCollection. */
const otherDeviceTracks = new Set<string>();
const otherDeviceAlbums = new Set<string>();
const isFavoriteTrack = (trackId: redux.ItemId) =>
	otherDeviceTracks.has(String(trackId)) || redux.store.getState().favorites.tracks.some((favoriteId) => String(favoriteId) === String(trackId));
const isFavoriteAlbum = (albumId: redux.ItemId) =>
	otherDeviceAlbums.has(String(albumId)) || redux.store.getState().favorites.albums.some((favoriteId) => String(favoriteId) === String(albumId));
const deferredRetryCounts = new Map<string, number>();
let autoDownloadQueue = Promise.resolve();
let autoAlbumQueue = Promise.resolve();

const deferredRetryDelays = [15 * 60_000, 30 * 60_000, 60 * 60_000];

// Once per start whenever an auto-download is on, so files renamed or moved on disk are found through
// the index instead of downloaded again. Works on disk only: no TIDAL requests.
let startupReindex: Promise<void> | undefined;
const reindexOnStartup = () =>
	(startupReindex ??= (async () => {
		const root = settings.defaultPath;
		if (root === undefined || !(settings.autoDownloadFavorites || settings.autoDownloadAlbums)) return;
		try {
			const result = await reindexFromLibrary(root);
			trace.log(`Library re-indexed on startup: ${Object.keys(result.entries).length} track(s) from ${result.scanned} file(s).`);
			for (const [trackId, path] of Object.entries(result.entries)) queueAlbumExtras(trackId, path);
		} catch (error) {
			trace.warn(`Library re-index failed, using the existing index: ${String(error)}`);
		}
	})());

/**
 * Cover art and credits for album folders that have audio but lack them. They used to be written only
 * while a track was being downloaded, so albums the index already knew (complete albums, renamed or
 * moved folders, Identify → Replace) never got them. The folder is checked on disk first; TIDAL is
 * asked only for a missing file, one folder at a time and paced, and a 429 stops it until next start.
 * Files are named after the album folder, as the default cover and credits formats name them, and an
 * existing file is never overwritten.
 */
const extrasFolders = new Set<string>();
let extrasQueue = Promise.resolve();
let extrasStopped = false;
const extrasPace = 2000;
const folderOf = (path: string | string[]) => {
	const full = Array.isArray(path) ? path.join("\\") : path;
	return full.slice(0, Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"))).toLowerCase();
};
const queueAlbumExtras = (trackId: redux.ItemId, audioPath: string | string[]) => {
	if (!settings.saveCoverArt && !settings.saveAlbumCredits) return;
	const folder = folderOf(audioPath);
	if (extrasFolders.has(folder)) return;
	extrasFolders.add(folder);
	extrasQueue = extrasQueue.then(async () => {
		if (extrasStopped || superseded()) return;
		const present = await albumExtrasPresent(audioPath);
		const needCover = settings.saveCoverArt && !present.cover;
		const needCredits = settings.saveAlbumCredits && !present.credits;
		if (!needCover && !needCredits) return;
		await wait(extrasPace);
		await waitForRateLimit();
		try {
			const mediaItem = await MediaItem.fromId(trackId, "track");
			if (mediaItem === undefined) return;
			const coverUrl = needCover ? await mediaItem.coverUrl() : undefined;
			if (coverUrl !== undefined) await saveCoverArt(audioPath, `${present.albumName}.jpg`, coverUrl);
			if (needCredits) {
				const credits = await makeAlbumCreditsText(mediaItem);
				if (credits !== undefined) await saveTextFileNextToAudio(audioPath, `${present.albumName} - credits.txt`, credits);
			}
			trace.log(`Filled in missing ${[coverUrl !== undefined && "cover art", needCredits && "credits"].filter(Boolean).join(" and ")} for ${present.albumName}`);
		} catch (error) {
			if (isRateLimited(error)) {
				extrasStopped = true;
				trace.warn("TIDAL answered 429 while filling in cover art and credits; the rest waits for the next start.");
			} else trace.warn(`Could not fill in cover art or credits for ${present.albumName}: ${String(error)}`);
		}
	});
};

/** Bookkeeping after the audio is on disk: a failure is a warning, never a failed download. */
const afterAudioSaved = async (what: string, step: () => Promise<unknown>) => {
	try {
		await step();
	} catch (error) {
		trace.warn(`Audio saved, but ${what} failed: ${String(error)}`);
	}
};
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
	/** Delivered by the Atmos sign-in (see atmos.ts), so a retry asks that profile again. */
	atmos?: boolean;
};

const advertisesAtmos = (mediaItem: MediaItem) => {
	const item = mediaItem.tidalItem as { audioModes?: string[]; mediaMetadata?: { tags?: string[] } };
	return Boolean(item.audioModes?.includes("DOLBY_ATMOS") || item.mediaMetadata?.tags?.includes("DOLBY_ATMOS"));
};

const retryPassingErrors = async <T,>(run: () => Promise<T>, attempts = 3): Promise<T> => {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= attempts || isRateLimited(error) || !retryableDownloadError(error)) throw error;
			await wait(attempt * 2000);
		}
	}
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
			// A passing TIDAL error (500, 403, a dropped connection) is asked again at the same quality:
			// falling back on it turned single tracks of Hi-Res albums into 16-bit files.
			const playbackInfo = await retryPassingErrors(() => getPlaybackInfo(mediaItem.id, quality));
			if (playbackInfo === undefined) {
				// Not served at this quality: try the next one (HiRes falls back to Lossless).
				lastError = new Error(`Track ${mediaItem.id} is not available at ${quality}`);
				continue;
			}
			if (quality !== preferredQuality) {
				trace.warn(`TIDAL rejected ${preferredQuality} for track ${mediaItem.id}; using ${quality} instead.`);
			}
			return { playbackInfo, quality };
		} catch (error) {
			// Only "not served at this quality" moves to the next quality; any error stops here, so the
			// track is retried later at the quality asked for instead of being saved lower.
			throw error;
		}
	}
	// The desktop profile gets no stream for an Atmos-only track; the Atmos sign-in does.
	if (advertisesAtmos(mediaItem)) {
		if (!hasAtmosLogin())
			throw new Error(
				atmosAvailable
					? `Track ${mediaItem.id} is only on TIDAL in Dolby Atmos: sign in to Dolby Atmos in the plugin settings to download it`
					: `Track ${mediaItem.id} is only on TIDAL in Dolby Atmos, which TIDAL does not serve to the desktop app`,
			);
		const playbackInfo = await getAtmosPlaybackInfo(mediaItem.id);
		if (playbackInfo !== undefined) return { playbackInfo, quality: preferredQuality, atmos: true };
		lastError = new Error(`Track ${mediaItem.id} is not available in Dolby Atmos either`);
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

/**
 * An album gets CD folders when TIDAL counts more than one volume or any of its tracks sits on disc 2
 * or later: an album object from the page can report one volume for a two-disc album.
 */
const multiDiscAlbums = new Map<string, Promise<boolean>>();
const isMultiDiscAlbum = (album: Album) => {
	let multiDisc = multiDiscAlbums.get(String(album.id));
	if (multiDisc === undefined) {
		multiDisc = (async () => {
			if ((album.tidalAlbum.numberOfVolumes ?? 1) > 1) return true;
			for await (const item of await album.mediaItems()) if ((item.tidalItem.volumeNumber ?? 1) > 1) return true;
			return false;
		})();
		multiDiscAlbums.set(String(album.id), multiDisc);
	}
	return multiDisc;
};

type AlbumMarkers = { hiRes: boolean; realMax: boolean };
const albumMarkers = new Map<string, Promise<AlbumMarkers>>();
const hasHiResMaster = (item: MediaItem) => item.tidalItem.mediaMetadata?.tags?.includes("HIRES_LOSSLESS") === true;

/**
 * Album-wide markers, decided before the first file is written so one album never splits across
 * folders: [Hi-Res] only when every track has a Hi-Res master on TIDAL, [RealMAX] only when RealMAX
 * replaces every track; an album where it replaces some tracks is a mix and gets neither. `scanRealMax` false (single favorites) skips the RealMAX lookups and
 * judges the album's own tracks. Lookups are memoized by Luna, so the download loop reuses them.
 */
const getAlbumMarkers = (album: Album, scanRealMax = settings.useRealMAX) => {
	const key = `${album.id}:${scanRealMax}:${settings.downloadQuality}`;
	let markers = albumMarkers.get(key);
	if (markers === undefined) {
		markers = (async () => {
			const tracks: MediaItem[] = [];
			let replaced = 0;
			for await (const item of await album.mediaItems()) {
				if (item.contentType !== "track") continue;
				const chosen = scanRealMax ? ((await item.max()) ?? item) : item;
				if (chosen.id !== item.id) replaced++;
				tracks.push(chosen);
			}
			// A mix (RealMAX replaced only some tracks) gets neither marker.
			const mix = replaced > 0 && replaced < tracks.length;
			const wantsHiRes = settings.downloadQuality === "HI_RES_LOSSLESS" || settings.downloadQuality === "HI_RES";
			return {
				hiRes: !mix && wantsHiRes && tracks.length > 0 && tracks.every(hasHiResMaster),
				realMax: tracks.length > 0 && replaced === tracks.length,
			};
		})();
		albumMarkers.set(key, markers);
		markers.catch(() => albumMarkers.delete(key));
	}
	return markers;
};

/** The bracket markers after the year: Atmos and AAC from the delivered stream, Hi-Res and RealMAX album-wide. */
const getPathVariants = ({ playbackInfo, quality }: ResolvedPlayback, album: AlbumMarkers) =>
	technicalVariants({
		atmos: playbackInfo.audioMode === "DOLBY_ATMOS",
		lossy: [quality, playbackInfo.audioQuality].some((value) => value === "HIGH" || value === "LOW"),
		bitDepth: album.hiRes ? 24 : 16,
		realMax: album.realMax,
	});

/** Markers for a track without a known album object: its own album, judged without RealMAX lookups. */
const getTrackAlbumMarkers = async (item: MediaItem, album?: Album, scanRealMax?: boolean): Promise<AlbumMarkers> => {
	const resolved = album ?? (await item.album());
	return resolved === undefined ? { hiRes: false, realMax: false } : getAlbumMarkers(resolved, scanRealMax);
};

type DownloadTagInfo = Awaited<ReturnType<MediaItem["flacTags"]>>;

const downloadWithRetry = async (
	mediaItem: MediaItem,
	path: string | string[],
	initialPlayback: ResolvedPlayback,
	// Always the TIDAL-first tags from getEmbeddedTags, never raw flacTags() (see selectTidalTags).
	downloadTags: DownloadTagInfo,
) => {
	const maxAttempts = 3;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			// Do not use MediaItem.playbackInfo() here: it is memoized and can retain an expired signed URL.
			const playbackInfo = attempt === 1
				? initialPlayback.playbackInfo
				: initialPlayback.atmos
					? await getAtmosPlaybackInfo(mediaItem.id)
					: await getPlaybackInfo(mediaItem.id, initialPlayback.quality);
			if (playbackInfo === undefined) throw new Error(`Track ${mediaItem.id} is not available`);
			await safeDownload(playbackInfo, path, downloadTags, mediaItem.id);
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
	const title = formatTidalTitle(album.tidalAlbum.title, album.tidalAlbum.version);
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
	if (fromFavoritedAlbum && sourceAlbum !== undefined) albumTrackIds.set(itemKey, String(sourceAlbum.id));
	if (queuedFavoriteIds.has(itemKey)) return;
	queuedFavoriteIds.add(itemKey);
	// Filled in as the track resolves, so a failure can still be logged with whatever is known.
	const logEntry: Omit<DownloadLogEntry, "status"> = {
		source: startupResume ? "collection" : "favorite",
		trackId: itemId,
		album: sourceAlbum?.tidalAlbum.title,
		requested: settings.downloadQuality,
	};

	// "Artist - Title (Album)" once TIDAL has answered, the id until then.
	const describeTrack = () =>
		logEntry.title ? `${logEntry.artist ? `${logEntry.artist} - ` : ""}${logEntry.title}${logEntry.album ? ` (${logEntry.album})` : ""}` : `track ${itemId}`;

	let requeue = false;
	// Set once the audio file is on disk. Anything failing after that (download index, cover, credits,
	// Luna's IndexedDB cache closing) is bookkeeping and must not be reported as a failed download.
	let audioSaved = false;

	autoDownloadQueue = autoDownloadQueue
		.then(async () => {
			// Already downloaded: decided from the local index and disk alone, with no TIDAL request.
			// Before this, every startup scan fetched track, tags and playback info for each existing file.
			// New favorites use it too, so a track already on disk under another name is not downloaded twice.
			await reindexOnStartup();
			const indexedPath = getIndexedDownloadPath(itemId);
			if (indexedPath !== undefined && (await audioFileExists(indexedPath))) {
				if (!startupResume) trace.log(`Auto-download skipped, already on disk: ${Array.isArray(indexedPath) ? indexedPath.join("\\") : indexedPath}`);
				queueAlbumExtras(itemId, indexedPath);
				return;
			}
			if (superseded()) return;
			if (startupResume && !settings.retryUnavailableTracks && isTrackUnavailable(itemId)) return;
			// The startup scan may reach many missing tracks: pace them like albums.
			if (startupResume) await wait(albumScanPaceMs);
			await waitForRateLimit();
			// Still wanted? An album removed from the Collection drops its queued tracks, unless the track is a favorite itself.
			const albumKey = albumTrackIds.get(itemKey);
			const isAlbumTrack = albumKey !== undefined && isFavoriteAlbum(albumKey);
			const isTrackFavorite = isFavoriteTrack(itemKey);
			if (!((isAlbumTrack && settings.autoDownloadAlbums) || (isTrackFavorite && settings.autoDownloadFavorites))) {
				if (albumKey !== undefined && !isAlbumTrack && !isTrackFavorite) trace.log(`Not downloading track ${itemId}: its album was removed from the Collection.`);
				return;
			}
			const libraryBase = settings.defaultPath;
			if (libraryBase === undefined) {
				trace.warn("Auto-download skipped: set a Library root in Song Downloader Deluxe settings first.");
				return;
			}

			const sourceMediaItem = await MediaItem.fromId(itemId, "track");
			if (sourceMediaItem === undefined) {
				await markTrackUnavailable(itemId);
				throw new Error(`TIDAL could not load this track (removed from TIDAL or not available here)`);
			}
			await markTrackAvailable(itemId);
			// Known before any tag work, so even a failure further down is reported by name.
			logEntry.artist = sourceMediaItem.tidalItem.artists?.[0]?.name;
			logEntry.title = formatTidalTitle(sourceMediaItem.tidalItem.title, sourceMediaItem.tidalItem.version);
			logEntry.album ??= sourceMediaItem.tidalItem.album?.title;
			let mediaItem = sourceMediaItem;
			if (settings.useRealMAX) mediaItem = (await mediaItem.max()) ?? mediaItem;

			const downloadedTagInfo = await mediaItem.flacTags();
			const sourceTagInfo = sourceMediaItem === mediaItem ? downloadedTagInfo : await sourceMediaItem.flacTags();
			const { tags } = downloadedTagInfo;
			const coverUrl = sourceTagInfo.coverUrl ?? downloadedTagInfo.coverUrl;
			const archiveTags = await getStablePathTags(sourceMediaItem, tags, albumTagOverrides, mediaItem);
			// The TIDAL-first tags: raw flacTags() can name another song (Luna's MusicBrainz fallback).
			logEntry.artist = archiveTags.artist?.[0] ?? logEntry.artist;
			logEntry.title = String(archiveTags.title ?? logEntry.title ?? "");
			logEntry.album = archiveTags.album ?? logEntry.album;
			const resolvedPlayback = await resolvePlaybackInfo(mediaItem);
			const { downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
			const variants = getPathVariants(resolvedPlayback, await getTrackAlbumMarkers(sourceMediaItem, sourceAlbum, isAlbumTrack && settings.useRealMAX));
			const presentationTags: ArchiveTagValues = { ...archiveTags, variantSuffix: formatVariantSuffix(variants) };
			// Disc layout follows the chosen TIDAL release, not the RealMAX substitute.
			multiDiscAlbum ??= await sourceMediaItem.album().then((album) => (album === undefined ? false : isMultiDiscAlbum(album)));
			let fileName = await getFileName(
				mediaItem,
				resolvedPlayback.quality,
				albumTagOverrides,
				multiDiscAlbum,
				getFileExtension(resolvedPlayback.playbackInfo),
				presentationTags,
			);
			fileName = addFolderVariants(fileName, variants, multiDiscAlbum);
			const audioPath = [libraryBase, fileName];

			if (!((settings.skipExistingFiles || startupResume) && (await audioFileExists(audioPath)))) {
				const delivered = await downloadWithRetry(mediaItem, audioPath, resolvedPlayback, {
					tags: getEmbeddedTags(archiveTags),
					coverUrl,
				});
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
			audioSaved = true;
			deferredRetryCounts.delete(itemKey);
			noteSuccess(`track:${itemKey}`);

			const label = `${tags.artist?.[0]} - ${tags.title}`;
			await afterAudioSaved(`download index for ${label}`, async () => {
				await rememberDownloadedTrack(itemId, audioPath);
				if (String(mediaItem.id) !== itemKey) await rememberDownloadedTrack(mediaItem.id, audioPath);
			});
			if (settings.saveCoverArt && coverUrl !== undefined) {
				await afterAudioSaved(`cover art for ${label}`, () => saveCoverArt(audioPath, getCoverFileName(presentationTags), coverUrl));
			}
			if (settings.saveAlbumCredits) {
				await afterAudioSaved(`album credits for ${label}`, async () => {
					const credits =
						sourceAlbum === undefined
							? await makeAlbumCreditsText(mediaItem, downloadedAudio)
							: await makeAlbumCreditsTextForAlbum(sourceAlbum, downloadedAudio);
					if (credits !== undefined) await saveTextFileNextToAudio(audioPath, getCreditsFileName(presentationTags), credits);
				});
			}
		})
		.catch(async (error) => {
			if (audioSaved) {
				trace.warn(`${describeTrack()} was saved, but a follow-up step failed: ${String(error)}`);
				return;
			}
			if (requeueOnRateLimit(`track:${itemKey}`, error)) {
				trace.warn(`TIDAL rate limit (429) for ${describeTrack()}; moved to the end of the queue.`);
				requeue = true;
				return;
			}
			if (retryableDownloadError(error)) {
				const retryNumber = (deferredRetryCounts.get(itemKey) ?? 0) + 1;
				const delay = deferredRetryDelays[retryNumber - 1];
				if (delay !== undefined) {
					deferredRetryCounts.set(itemKey, retryNumber);
					trace.warn(
						`TIDAL server temporarily rejected ${describeTrack()}; deferred retry ${retryNumber}/${deferredRetryDelays.length} scheduled in ${delay / 60_000} minutes.`,
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
					trace.warn(`TIDAL server still rejects ${describeTrack()}; it will be tried again during the next Collection startup scan.`);
					await logDownload(settings.defaultPath, {
						...logEntry,
						status: "failed",
						details: `gave up for now, tried again at next startup scan: ${String(error)}`,
					});
				}
				return;
			}
			await logDownload(settings.defaultPath, { ...logEntry, status: "failed", details: String(error) });
			// The startup scan reaches every favorite track, including ones TIDAL no longer serves: log, no toast each.
			if (startupResume) trace.warn(`Collection scan could not download ${describeTrack()} this time: ${String(error)}`);
			else trace.msg.err.withContext(`Failed to auto-download ${describeTrack()}`)(error);
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
			if (superseded()) return;
			if (startupResume && isAlbumComplete(albumId)) return;
			// The queue runs one album at a time, so pacing here throttles the whole scan.
			if (startupResume) await wait(albumScanPaceMs);
			await waitForRateLimit();
			const { album, mediaItems: albumItems } = await loadAlbum();
			noteSuccess(`album:${albumKey}`);
			const mediaItems: MediaItem[] = [];
			for await (const mediaItem of albumItems) mediaItems.push(mediaItem);
			await reindexOnStartup();
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
			const multiDiscAlbum = await isMultiDiscAlbum(album);
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
let knownFavoriteAlbumIds = new Set<string>(initialFavorites.albums.map(String));
let startupResumeStarted = false;

/**
 * Favorite albums and favorite tracks: a track favorited while the plugin was not running (TIDAL closed,
 * Luna missing after a TIDAL update) is only ever caught here.
 */
const resumeCollectionAlbums = (albumIds: redux.ItemId[], trackIds: redux.ItemId[]) => {
	if (superseded() || startupResumeStarted || !settings.resumeCollectionAlbums || !(settings.autoDownloadAlbums || settings.autoDownloadFavorites)) return;
	startupResumeStarted = true;
	if (settings.defaultPath === undefined) {
		trace.warn("Collection resume skipped: set a Library root in Song Downloader Deluxe settings first.");
		return;
	}
	// Re-index first, so albums renamed or moved on disk are recognized instead of downloaded again.
	void reindexOnStartup().finally(() => {
		if (settings.autoDownloadAlbums) {
			trace.log(`Startup Collection scan queued ${albumIds.length} favorite album(s). Existing audio files will be skipped.`);
			for (const albumId of albumIds) queueAlbumDownload(albumId, true);
		}
		if (settings.autoDownloadFavorites) {
			const tracks = trackIds.filter(isTrackId);
			trace.log(`Startup Collection scan queued ${tracks.length} favorite track(s). Tracks already in the download index are skipped without contacting TIDAL.`);
			for (const trackId of tracks) queueFavoriteDownload(trackId, false, undefined, undefined, true);
		}
	});
};

// Not only before the Collection scan: also when only favorite auto-downloads are on.
void reindexOnStartup();
if (favoriteStateHydrated) queueMicrotask(() => resumeCollectionAlbums(initialFavorites.albums, initialFavorites.tracks));

/**
 * "Move unfavorited tracks to quarantine". Only a removal made here, while the plugin runs, counts: the
 * favorites list shrinking within seconds of TIDAL confirming a removal. A list that shrinks for any
 * other reason (a sync, a reload) moves nothing, and neither does a removal of more tracks at once than
 * a person would make by hand.
 */
let knownFavoriteTrackIds = new Set<string>(initialFavorites.tracks.map(String));
const removedFavoriteTracks = new Map<string, number>();
let lastFavoriteRemovalAt = 0;
const removalWindowMs = 15_000;
const maxRemovedAtOnce = 25;
let unfavoriteCheckPending = false;
let unfavoriteQueue = Promise.resolve();

const noteRemovedFavoriteTracks = (currentTrackIds: Set<string>) => {
	const now = Date.now();
	for (const trackId of knownFavoriteTrackIds) {
		if (currentTrackIds.has(trackId)) continue;
		removedFavoriteTracks.set(trackId, now);
		otherDeviceTracks.delete(trackId);
	}
	for (const trackId of currentTrackIds) removedFavoriteTracks.delete(trackId);
	const removedSome = [...knownFavoriteTrackIds].some((trackId) => !currentTrackIds.has(trackId));
	knownFavoriteTrackIds = currentTrackIds;
	if (removedSome) scheduleUnfavoriteCheck();
};

const scheduleUnfavoriteCheck = () => {
	if (unfavoriteCheckPending) return;
	unfavoriteCheckPending = true;
	// The list change and TIDAL's confirmation arrive in either order: look once both are in.
	safeTimeout(unloads, () => {
		unfavoriteCheckPending = false;
		checkUnfavoritedTracks();
	}, 2000);
};

const checkUnfavoritedTracks = () => {
	const root = settings.defaultPath;
	if (superseded() || !settings.quarantineUnfavoritedTracks || root === undefined) {
		removedFavoriteTracks.clear();
		return;
	}
	const now = Date.now();
	const confirmed: string[] = [];
	for (const [trackId, removedAt] of removedFavoriteTracks) {
		if (Math.abs(removedAt - lastFavoriteRemovalAt) <= removalWindowMs) confirmed.push(trackId);
		// Unconfirmed and old: the list changed for another reason. Never acted on later.
		if (confirmed.includes(trackId) || now - removedAt > removalWindowMs) removedFavoriteTracks.delete(trackId);
	}
	if (confirmed.length === 0) return;
	if (confirmed.length > maxRemovedAtOnce) {
		trace.warn(`${confirmed.length} tracks left the favorites at once; not moving any of them to quarantine. Move them by hand if that was intended.`);
		return;
	}
	for (const trackId of confirmed) queueUnfavoritedTrack(trackId, root);
};

const queueUnfavoritedTrack = (trackId: string, root: string) => {
	unfavoriteQueue = unfavoriteQueue.then(async () => {
		if (isFavoriteTrack(trackId)) return;
		const path = getIndexedDownloadPath(trackId);
		if (path === undefined || !(await audioFileExists(path))) return;
		// The file can stand for other ids too (a RealMAX substitute): keep it while any of them is a favorite.
		const sharedFavorite = trackIdsForPath(path).some(isFavoriteTrack);
		if (sharedFavorite) return;
		const mediaItem = await MediaItem.fromId(trackId, "track").catch(() => undefined);
		const albumId = mediaItem?.tidalItem.album?.id;
		const label = mediaItem ? `${mediaItem.tidalItem.artists?.[0]?.name ?? ""} - ${formatTidalTitle(mediaItem.tidalItem.title, mediaItem.tidalItem.version)}` : `track ${trackId}`;
		// Without its album we cannot tell whether a Collection album still holds it: keep the file.
		if (albumId === undefined) {
			trace.warn(`Kept unfavorited ${label}: TIDAL did not say which album it is on.`);
			return;
		}
		if (isFavoriteAlbum(albumId)) {
			trace.log(`Kept unfavorited ${label}: its album is in your Collection.`);
			return;
		}
		try {
			const moved = await quarantineTrack(root, quarantineFolderFor(root, settings.quarantineFolder), path);
			await forgetDownloadedFile(path, albumId);
			trace.msg.log(`Moved unfavorited ${label} to quarantine${moved.length > 1 ? ` (album now empty: ${moved.length - 1} more file(s) moved)` : ""}.`);
		} catch (error) {
			trace.warn(`Could not move unfavorited ${label} to quarantine: ${String(error)}`);
		}
	});
};

// "Identify files without TIDAL id" → Replace: a fresh TIDAL download takes the old file's place, and
// the old file goes to quarantine. Only lossless stereo FLAC replaces a FLAC; anything else is skipped.
setTidalReplacer(async (root, trackId, path) => {
	await waitForRateLimit();
	const mediaItem = await MediaItem.fromId(trackId, "track");
	if (mediaItem === undefined) return "TIDAL no longer has this track";
	const { tags, coverUrl } = await mediaItem.flacTags();
	const archiveTags = await getStablePathTags(mediaItem, tags);
	const resolvedPlayback = await resolvePlaybackInfo(mediaItem);
	const { isAtmos, downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
	if (isAtmos || getFileExtension(resolvedPlayback.playbackInfo) !== "flac") return `TIDAL serves it as ${downloadedAudio ?? "non-FLAC"}, kept the existing file`;
	const temporaryPath = path.replace(/\.flac$/i, ".tidal-new.flac");
	const delivered = await downloadWithRetry(mediaItem, temporaryPath, resolvedPlayback, { tags: getEmbeddedTags(archiveTags), coverUrl });
	const quarantined = await replaceWithQuarantine(root, quarantineFolderFor(root, settings.quarantineFolder), path, temporaryPath);
	noteSuccess(`track:${trackId}`);
	await afterAudioSaved(`download index for ${archiveTags.title}`, () => rememberDownloadedTrack(trackId, path));
	queueAlbumExtras(trackId, path);
	await logDownload(root, {
		source: "manual",
		status: "downloaded",
		trackId,
		artist: archiveTags.artist?.[0],
		album: archiveTags.album,
		title: String(archiveTags.title ?? ""),
		requested: settings.downloadQuality,
		delivered,
		file: path,
		details: `replaced a file without TIDAL id; old copy: ${quarantined}`,
	});
	trace.log(`Replaced with TIDAL download: ${path}`);
	return undefined;
});

unloads.add(
	redux.store.subscribe(() => {
		const favorites = redux.store.getState().favorites;
		const currentAlbumIds = new Set<string>(favorites.albums.map(String));
		const currentTrackIds = new Set<string>(favorites.tracks.map(String));
		if (!favoriteStateHydrated) {
			if (!Object.values(favorites).some((itemIds) => itemIds.length > 0)) return;
			knownFavoriteAlbumIds = currentAlbumIds;
			knownFavoriteTrackIds = currentTrackIds;
			favoriteStateHydrated = true;
			resumeCollectionAlbums(favorites.albums, favorites.tracks);
			return;
		}

		noteRemovedFavoriteTracks(currentTrackIds);

		const addedAlbumIds = favorites.albums.filter((albumId) => !knownFavoriteAlbumIds.has(String(albumId)));
		// Removed here: no longer counts as a favorite from the other device either.
		for (const albumId of knownFavoriteAlbumIds) if (!currentAlbumIds.has(albumId)) otherDeviceAlbums.delete(albumId);
		knownFavoriteAlbumIds = currentAlbumIds;
		if (superseded() || !settings.autoDownloadAlbums) return;
		for (const albumId of addedAlbumIds) queueAlbumDownload(albumId);
	}),
);

/**
 * The desktop app does not see tracks and albums added to the Collection on the phone until it restarts.
 * Every 30 minutes one request asks TIDAL for the Collection's ids and the new ones are downloaded.
 * Removals on the phone are ignored: only a removal made here moves a file (see checkUnfavoritedTracks).
 */
const collectionPollMs = 30 * 60_000;
const pollCollection = async () => {
	if (superseded() || !favoriteStateHydrated || settings.defaultPath === undefined) return;
	if (!(settings.autoDownloadFavorites || settings.autoDownloadAlbums)) return;
	await waitForRateLimit();
	const { userId } = await getCredentials();
	const response = await fetch(`https://desktop.tidal.com/v1/users/${userId}/favorites/ids?${TidalApi.queryArgs()}`, {
		headers: await TidalApi.getAuthHeaders(),
		cache: "no-store",
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`TIDAL Collection ids ${response.status} ${response.statusText}`);
	const ids = (await response.json()) as { TRACK?: redux.ItemId[]; ALBUM?: redux.ItemId[] };
	const newTracks = (ids.TRACK ?? []).map(String).filter((trackId) => isTrackId(trackId) && !isFavoriteTrack(trackId));
	const newAlbums = (ids.ALBUM ?? []).map(String).filter((albumId) => !isFavoriteAlbum(albumId));
	if (newTracks.length === 0 && newAlbums.length === 0) return;
	trace.log(`Collection check: ${newTracks.length} track(s) and ${newAlbums.length} album(s) added on another device.`);
	for (const trackId of newTracks) otherDeviceTracks.add(trackId);
	for (const albumId of newAlbums) otherDeviceAlbums.add(albumId);
	if (settings.autoDownloadAlbums) for (const albumId of newAlbums) queueAlbumDownload(albumId, true);
	if (settings.autoDownloadFavorites) for (const trackId of newTracks) queueFavoriteDownload(trackId, false, undefined, undefined, true);
};
safeInterval(
	unloads,
	() => {
		pollCollection().catch((error) => trace.warn(`Collection check failed, trying again in 30 minutes: ${String(error)}`));
	},
	collectionPollMs,
);

const pendingFavoriteIds: redux.ItemId[] = [];
const isTrackId = (itemId: redux.ItemId) => /^\d+$/.test(String(itemId));
const personalizedRadioPattern =
	/(?:personal(?:ized|ised)?.{0,32}(?:radio|station)|(?:radio|station).{0,32}personal(?:ized|ised)?)/i;

redux.intercept("content/ADD_MEDIA_ITEM_IDS_TO_FAVORITES", unloads, ({ mediaItemIds, moduleId, name }) => {
	if (superseded() || !settings.autoDownloadFavorites) return;
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
redux.intercept("content/REMOVE_ITEMS_FROM_FAVORITES_SUCCESS", unloads, () => {
	lastFavoriteRemovalAt = Date.now();
	scheduleUnfavoriteCheck();
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
			const multiDiscAlbum = await isMultiDiscAlbum(mediaCollection);
			const albumMarkers = await getAlbumMarkers(mediaCollection);
			// Credits need no stream: when TIDAL refuses one (e.g. "Asset is not ready for playback"),
			// the folder markers come from what the track advertises instead.
			let downloadedAudio: string | undefined;
			let variants: ReturnType<typeof technicalVariants>;
			try {
				const resolvedPlayback = await resolvePlaybackInfo(firstMediaItem);
				downloadedAudio = getActualDownloadFormat(resolvedPlayback).downloadedAudio;
				variants = getPathVariants(resolvedPlayback, albumMarkers);
			} catch (error) {
				if (isRateLimited(error)) throw error;
				const atmos = advertisesAtmos(firstMediaItem);
				downloadedAudio = atmos ? "Dolby Atmos" : undefined;
				variants = technicalVariants({ atmos, lossy: false, bitDepth: albumMarkers.hiRes ? 24 : 16, realMax: albumMarkers.realMax });
			}
			const presentationTags: ArchiveTagValues = { ...tags, variantSuffix: formatVariantSuffix(variants) };
			let audioPath: string | string[];
			const libraryBase = settings.defaultPath;
			if (libraryBase !== undefined) {
				const pathFormat = multiDiscAlbum ? settings.multiDiscPathFormat : settings.pathFormat;
				let relativePath = `${applyTagFormat(pathFormat, presentationTags)}.flac`;
				relativePath = addFolderVariants(relativePath, variants, multiDiscAlbum);
				audioPath = [libraryBase, relativePath];
			} else {
				const selectedFolder = await getDownloadFolder();
				if (selectedFolder === undefined) {
					creditsButton.text = "Download Album Credits";
					return;
				}
				audioPath = [selectedFolder, "album.flac"];
			}

			const credits = await makeAlbumCreditsTextForAlbum(mediaCollection, downloadedAudio);
			await saveTextFileNextToAudio(audioPath, getCreditsFileName(presentationTags), credits, true);
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
		// An album is judged as a whole; a playlist track by its own album, without RealMAX lookups on it.
		const collectionMarkers = (item: MediaItem) =>
			sourceAlbum !== undefined ? getAlbumMarkers(sourceAlbum) : getTrackAlbumMarkers(item, undefined, false);
		const sourceIsMultiDisc = sourceAlbum !== undefined ? await isMultiDiscAlbum(sourceAlbum) : undefined;
		try {
			if (sourceAlbum !== undefined) {
				downloadButton.text = settings.useRealMAX ? `Checking RealMax...` : `Checking album quality...`;
				await getAlbumMarkers(sourceAlbum);
			}
			for await (let mediaItem of await mediaCollection.mediaItems()) {
				if (downloadState.cancel) break;
				const sourceMediaItem = mediaItem;
				const sourceItemId = mediaItem.id;
				if (settings.useRealMAX) {
					downloadButton.text = `Checking RealMax...`;
					mediaItem = (await mediaItem.max()) ?? mediaItem;
				}

				downloadButton.text = `Loading tags...`;
				const downloadedTagInfo = await mediaItem.flacTags();
				const sourceTagInfo = sourceMediaItem === mediaItem ? downloadedTagInfo : await sourceMediaItem.flacTags();
				const { tags } = downloadedTagInfo;
				const coverUrl = sourceTagInfo.coverUrl ?? downloadedTagInfo.coverUrl;
				const archiveTags = await getStablePathTags(sourceMediaItem, tags, albumTagOverrides, mediaItem);
				const resolvedPlayback = await resolvePlaybackInfo(mediaItem);
				const { downloadedAudio } = getActualDownloadFormat(resolvedPlayback);
				const variants = getPathVariants(resolvedPlayback, await collectionMarkers(sourceMediaItem));
				const presentationTags: ArchiveTagValues = { ...archiveTags, variantSuffix: formatVariantSuffix(variants) };
				const multiDiscAlbum = sourceIsMultiDisc ?? (await mediaItem.album().then((album) => (album === undefined ? false : isMultiDiscAlbum(album))));

				downloadButton.text = `Fetching filename...`;
				let fileName = await getFileName(
					mediaItem,
					resolvedPlayback.quality,
					albumTagOverrides,
					multiDiscAlbum,
					getFileExtension(resolvedPlayback.playbackInfo),
					presentationTags,
				);
				fileName = addFolderVariants(fileName, variants, multiDiscAlbum);

				downloadButton.text = `Fetching download path...`;
				const path = downloadFolder !== undefined ? [downloadFolder, fileName] : await getDownloadPath(fileName);
				if (path === undefined) return;

				const indexedPath = getIndexedDownloadPath(sourceItemId) ?? getIndexedDownloadPath(mediaItem.id);
				const alreadyExists =
					settings.skipExistingFiles && ((await audioFileExists(path)) || (indexedPath !== undefined && (await audioFileExists(indexedPath))));
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
						const delivered = await downloadWithRetry(mediaItem, path, resolvedPlayback, {
							tags: getEmbeddedTags(archiveTags),
							coverUrl,
						});
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
					await afterAudioSaved(`download index for ${tags.title}`, async () => {
						await rememberDownloadedTrack(sourceItemId, path);
						if (String(mediaItem.id) !== String(sourceItemId)) await rememberDownloadedTrack(mediaItem.id, path);
					});
				}

				if (settings.saveCoverArt && coverUrl !== undefined) {
					downloadButton.text = `Saving cover art...`;
					await afterAudioSaved(`cover art for ${archiveTags.album}`, () => saveCoverArt(path, getCoverFileName(presentationTags), coverUrl));
				}

				if (settings.saveAlbumCredits) {
					downloadButton.text = `Saving album credits...`;
					await afterAudioSaved(`album credits for ${archiveTags.album}`, async () => {
						const credits =
							sourceAlbum === undefined
								? await makeAlbumCreditsText(mediaItem, downloadedAudio)
								: await makeAlbumCreditsTextForAlbum(sourceAlbum, downloadedAudio);
						if (credits !== undefined) await saveTextFileNextToAudio(path, getCreditsFileName(presentationTags), credits);
					});
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
