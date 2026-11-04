import sanitize from "sanitize-filename";

import { createWriteStream } from "fs";
import { access, constants, link, mkdir, rm } from "fs/promises";
import { dirname, join, parse } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import type { PlaybackInfo, redux } from "@luna/lib";
import { fetchMediaItemStream, type FetchProgress } from "@luna/lib.native";

type DownloadTags = {
	tags: Record<string, string[] | string>;
	coverUrl?: string;
};

const progressByTrack = new Map<string, FetchProgress>();
let downloadQueue = Promise.resolve();

const resolvePath = (filePath: string | string[]) => (Array.isArray(filePath) ? join(...filePath) : filePath);

// TidaLuna's FLAC tagger is connected with Readable.pipe(). Node does not forward
// source errors through pipe() automatically. Forward them while our download is
// active so a TIDAL 403 rejects the promise instead of crashing Electron's main process.
const withPipeErrorForwarding = async <T>(run: () => Promise<T>): Promise<T> => {
	const originalPipe = Readable.prototype.pipe;
	Readable.prototype.pipe = function (this: Readable, destination: NodeJS.WritableStream, options?: { end?: boolean }) {
		const source = this;
		const result = originalPipe.call(source, destination, options);
		const forwardError = (error: Error) => {
			const destroyable = destination as unknown as { destroy?: (cause?: Error) => void };
			if (typeof destroyable.destroy === "function") {
				destroyable.destroy(error);
			}
		};
		source.once("error", forwardError);
		destination.once("close", () => source.off("error", forwardError));
		return result;
	} as typeof Readable.prototype.pipe;

	try {
		return await run();
	} finally {
		Readable.prototype.pipe = originalPipe;
	}
};

const performDownload = async (
	playbackInfo: PlaybackInfo,
	filePath: string | string[],
	tags: DownloadTags,
	trackId: redux.ItemId,
) => {
	const requestedPath = resolvePath(filePath);
	const parsed = parse(requestedPath);
	const finalPath = join(parsed.dir, sanitize(parsed.base));
	const partialPath = `${finalPath}.songdownloader.part`;
	await mkdir(dirname(finalPath), { recursive: true });

	try {
		await access(finalPath, constants.F_OK);
		return;
	} catch {
		// Expected when this is a new download.
	}

	await rm(partialPath, { force: true });
	const progress: FetchProgress = { total: 0, downloaded: 0 };
	progressByTrack.set(String(trackId), progress);

	try {
		await withPipeErrorForwarding(async () => {
			const source = await fetchMediaItemStream(playbackInfo, { progress, tags });
			await pipeline(source, createWriteStream(partialPath, { flags: "wx" }));
		});
		// A hard link is atomic and refuses to overwrite an existing destination.
		await link(partialPath, finalPath);
		await rm(partialPath, { force: true });
	} catch (error) {
		await rm(partialPath, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		progressByTrack.delete(String(trackId));
	}
};

export const safeDownload = (
	playbackInfo: PlaybackInfo,
	filePath: string | string[],
	tags: DownloadTags,
	trackId: redux.ItemId,
) => {
	const queued = downloadQueue.then(() => performDownload(playbackInfo, filePath, tags, trackId));
	downloadQueue = queued.catch(() => undefined);
	return queued;
};

export const safeDownloadProgress = (trackId: redux.ItemId) => progressByTrack.get(String(trackId));
