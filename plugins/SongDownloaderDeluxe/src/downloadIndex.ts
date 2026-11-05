import { ReactiveStore } from "@luna/core";
import type { redux } from "@luna/lib";

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
 * Albums whose every track was found on disk. The startup Collection scan skips them without asking
 * TIDAL anything, which is most of a large Collection after the first scan.
 */
export const isAlbumComplete = (albumId: redux.ItemId) => completeAlbums.has(String(albumId));

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
