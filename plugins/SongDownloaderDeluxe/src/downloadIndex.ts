import { ReactiveStore } from "@luna/core";
import type { redux } from "@luna/lib";

export type DownloadPath = string | string[];

const storage = ReactiveStore.getStore("@luna/pluginStorage");
const storageKey = "SongDownloaderCustomDownloadIndex";
let downloadIndex = (await storage.get<Record<string, DownloadPath>>(storageKey)) ?? {};
let saveQueue = Promise.resolve();

export const getIndexedDownloadPath = (itemId: redux.ItemId) => downloadIndex[String(itemId)];

export const rememberDownloadedTrack = (itemId: redux.ItemId, path: DownloadPath) => {
	downloadIndex = { ...downloadIndex, [String(itemId)]: path };
	const snapshot = downloadIndex;
	saveQueue = saveQueue.then(() => storage.set(storageKey, snapshot));
	return saveQueue;
};

