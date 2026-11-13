import { ReactiveStore } from "@luna/core";
import type { redux } from "@luna/lib";

import { reindexLibrary } from "./reindex.native";

export type DownloadPath = string | string[];

const storage = ReactiveStore.getStore("@luna/pluginStorage");
const storageKey = "SongDownloaderCustomDownloadIndex";
const completeAlbumsKey = "SongDownloaderDeluxeCompleteAlbums";
let downloadIndex = (await storage.get<Record<string, DownloadPath>>(storageKey)) ?? {};
let completeAlbums = new Set((await storage.get<string[]>(completeAlbumsKey)) ?? []);
let saveQueue: Promise<void> = Promise.resolve();

/**
 * These writes only persist reconciliation hints. They must not make a completed audio download
 * look failed when TIDAL is closing Luna's shared IndexedDB connection. Recovering the queue here
 * also prevents one rejected write from poisoning every later write in the session.
 */
const queueIndexSave = (write: () => Promise<unknown>) => {
	saveQueue = saveQueue
		.catch(() => undefined)
		.then(async () => {
			try {
				await write();
			} catch (error) {
				console.warn("[SongDownloaderDeluxe] Audio was saved, but its download index could not be updated.", error);
			}
		});
	return saveQueue;
};

export const getIndexedDownloadPath = (itemId: redux.ItemId) => downloadIndex[String(itemId)];

export const rememberDownloadedTrack = (itemId: redux.ItemId, path: DownloadPath) => {
	downloadIndex = { ...downloadIndex, [String(itemId)]: path };
	const snapshot = downloadIndex;
	return queueIndexSave(async () => {
		await storage.set(storageKey, snapshot);
	});
};

/**
 * Points the index at the files as they are on disk now, read from the TIDAL track id each FLAC
 * carries. Renamed or moved albums are then recognized and never downloaded again. Disk only.
 */
// The quarantine folder chosen in settings (set by Settings, which this module cannot import): never indexed.
let quarantineFolder: string | undefined;
export const setIndexQuarantineFolder = (folder: string | undefined) => {
	quarantineFolder = folder;
};

export const reindexFromLibrary = async (root: string) => {
	const result = await reindexLibrary(root, quarantineFolder);
	downloadIndex = { ...downloadIndex, ...result.entries };
	const snapshot = downloadIndex;
	await queueIndexSave(async () => {
		await storage.set(storageKey, snapshot);
	});
	return result;
};

/**
 * Archive files that are not from TIDAL and stay as they are: never looked up again. Kept by audio
 * MD5, so a renamed or moved file is still recognised; by path when the file has no MD5.
 */
const keptOutsideTidalKey = "SongDownloaderDeluxeKeptOutsideTidal";
let keptOutsideTidal = new Set((await storage.get<string[]>(keptOutsideTidalKey)) ?? []);
const keptKey = (file: { path: string; audioMd5?: string }) => file.audioMd5 ?? file.path;
export const isKeptOutsideTidal = (file: { path: string; audioMd5?: string }) => keptOutsideTidal.has(keptKey(file));
export const keepOutsideTidal = (files: { path: string; audioMd5?: string }[]) => {
	keptOutsideTidal = new Set([...keptOutsideTidal, ...files.map(keptKey)]);
	const snapshot = [...keptOutsideTidal];
	return queueIndexSave(async () => {
		await storage.set(keptOutsideTidalKey, snapshot);
	});
};

/** Index entries found some other way (a TIDAL lookup of files that carry no id). */
export const addIndexEntries = (entries: Record<string, DownloadPath>) => {
	downloadIndex = { ...downloadIndex, ...entries };
	const snapshot = downloadIndex;
	return queueIndexSave(async () => {
		await storage.set(storageKey, snapshot);
	});
};

/**
 * Albums whose every track was found on disk. The startup Collection scan skips them without asking
 * TIDAL anything, which is most of a large Collection after the first scan.
 */
export const isAlbumComplete = (albumId: redux.ItemId) => completeAlbums.has(String(albumId));

const pathKey = (path: DownloadPath) => (Array.isArray(path) ? path.join("\\") : path).replaceAll("/", "\\").toLowerCase();

/** Every track id whose index entry points at this file (a RealMAX substitute shares its file). */
export const trackIdsForPath = (path: DownloadPath) => {
	const key = pathKey(path);
	return Object.keys(downloadIndex).filter((id) => pathKey(downloadIndex[id]) === key);
};

/** The file left the library: drop its index entries, and its album is no longer complete. */
export const forgetDownloadedFile = (path: DownloadPath, albumId?: redux.ItemId) => {
	const key = pathKey(path);
	downloadIndex = Object.fromEntries(Object.entries(downloadIndex).filter(([, entry]) => pathKey(entry) !== key));
	const snapshot = downloadIndex;
	if (albumId !== undefined) completeAlbums.delete(String(albumId));
	const albums = [...completeAlbums];
	return queueIndexSave(async () => {
		await storage.set(storageKey, snapshot);
		await storage.set(completeAlbumsKey, albums);
	});
};

export const markAlbumComplete = (albumId: redux.ItemId) => {
	if (completeAlbums.has(String(albumId))) return saveQueue;
	completeAlbums = new Set([...completeAlbums, String(albumId)]);
	const snapshot = [...completeAlbums];
	return queueIndexSave(async () => {
		await storage.set(completeAlbumsKey, snapshot);
	});
};

/** Forget all complete markers, so the next startup scan checks every Collection album again. */
export const clearCompleteAlbums = () => {
	completeAlbums = new Set();
	return queueIndexSave(async () => {
		await storage.set(completeAlbumsKey, []);
	});
};

export const completeAlbumCount = () => completeAlbums.size;

/**
 * Favorite tracks TIDAL could not load (removed from TIDAL, region-locked). With "Look again for
 * tracks TIDAL could not find" off, the startup scan skips them without asking TIDAL.
 */
const unavailableTracksKey = "SongDownloaderDeluxeUnavailableTracks";
let unavailableTracks = new Set((await storage.get<string[]>(unavailableTracksKey)) ?? []);
const saveUnavailable = () => {
	const snapshot = [...unavailableTracks];
	return queueIndexSave(async () => {
		await storage.set(unavailableTracksKey, snapshot);
	});
};
export const isTrackUnavailable = (trackId: redux.ItemId) => unavailableTracks.has(String(trackId));
export const markTrackUnavailable = (trackId: redux.ItemId) => {
	if (unavailableTracks.has(String(trackId))) return saveQueue;
	unavailableTracks = new Set([...unavailableTracks, String(trackId)]);
	return saveUnavailable();
};
export const markTrackAvailable = (trackId: redux.ItemId) => {
	if (!unavailableTracks.delete(String(trackId))) return saveQueue;
	return saveUnavailable();
};
export const clearUnavailableTracks = () => {
	unavailableTracks = new Set();
	return saveUnavailable();
};
export const unavailableTrackCount = () => unavailableTracks.size;
