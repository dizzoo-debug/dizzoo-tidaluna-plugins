import { ReactiveStore } from "@luna/core";
import type { redux } from "@luna/lib";

export type DownloadPath = string | string[];

const storage = ReactiveStore.getStore("@luna/pluginStorage");
const storageKey = "SongDownloaderCustomDownloadIndex";
const completeAlbumsKey = "SongDownloaderDeluxeCompleteAlbums";
let downloadIndex = (await storage.get<Record<string, DownloadPath>>(storageKey)) ?? {};
let completeAlbums = new Set((await storage.get<string[]>(completeAlbumsKey)) ?? []);
let saveQueue = Promise.resolve();

export const getIndexedDownloadPath = (itemId: redux.ItemId) => downloadIndex[String(itemId)];

export const rememberDownloadedTrack = (itemId: redux.ItemId, path: DownloadPath) => {
	downloadIndex = { ...downloadIndex, [String(itemId)]: path };
	const snapshot = downloadIndex;
	saveQueue = saveQueue.then(async () => {
		await storage.set(storageKey, snapshot);
	});
	return saveQueue;
};

/**
 * Albums whose every track was found on disk. The startup Collection scan skips them without asking
 * TIDAL anything, which is most of a large Collection after the first scan.
 */
export const isAlbumComplete = (albumId: redux.ItemId) => completeAlbums.has(String(albumId));

export const markAlbumComplete = (albumId: redux.ItemId) => {
	if (completeAlbums.has(String(albumId))) return saveQueue;
	completeAlbums = new Set([...completeAlbums, String(albumId)]);
	const snapshot = [...completeAlbums];
	saveQueue = saveQueue.then(async () => {
		await storage.set(completeAlbumsKey, snapshot);
	});
	return saveQueue;
};

/** Forget all complete markers, so the next startup scan checks every Collection album again. */
export const clearCompleteAlbums = () => {
	completeAlbums = new Set();
	saveQueue = saveQueue.then(async () => {
		await storage.set(completeAlbumsKey, []);
	});
	return saveQueue;
};

export const completeAlbumCount = () => completeAlbums.size;
