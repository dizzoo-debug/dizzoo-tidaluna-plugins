import { access, appendFile, constants, copyFile, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";

const resolvePath = (filePath: string | string[]) => (Array.isArray(filePath) ? join(...filePath) : filePath);

export const fileExists = async (filePath: string | string[]) => {
	try {
		await access(resolvePath(filePath), constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

export const audioFileExists = async (filePath: string | string[]) => {
	try {
		return (await stat(resolvePath(filePath))).size > 0;
	} catch {
		return false;
	}
};

export const saveCoverArt = async (audioPath: string | string[], coverFileName: string, coverUrl: string) => {
	const coverPath = join(dirname(resolvePath(audioPath)), coverFileName);
	if (await fileExists(coverPath)) return false;

	const response = await fetch(coverUrl);
	if (!response.ok) throw new Error(`Failed to download cover art: ${response.status} ${response.statusText}`);

	await mkdir(dirname(coverPath), { recursive: true });
	try {
		await writeFile(coverPath, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
};

/**
 * Whether the audio file's folder already has cover art (any .jpg) and album credits (any "credits.txt"),
 * and the album name those files are named after: the folder, or the one above a CD1/CD2 folder. Disk only.
 */
export const albumExtrasPresent = async (audioPath: string | string[]) => {
	const folder = dirname(resolvePath(audioPath));
	const names = await readdir(folder).catch(() => [] as string[]);
	const albumName = /^CD\d+$/i.test(basename(folder)) ? basename(dirname(folder)) : basename(folder);
	return { cover: names.some((name) => /\.jpe?g$/i.test(name)), credits: names.some((name) => /credits\.txt$/i.test(name)), albumName };
};

export const saveTextFileNextToAudio = async (
	audioPath: string | string[],
	fileName: string,
	contents: string,
	overwrite = false,
) => {
	const textPath = join(dirname(resolvePath(audioPath)), fileName);
	if (!overwrite && (await fileExists(textPath))) return false;

	await mkdir(dirname(textPath), { recursive: true });
	try {
		await writeFile(textPath, contents, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
};

/** The quarantine folder: the one chosen in settings, or <root>/_SongDownloader_Quarantine. */
export const quarantineFolderFor = (root: string, chosen?: string) => (chosen ? chosen : join(root, "_SongDownloader_Quarantine"));

/** Under the quarantine folder by the file's path relative to the library root, numbered if that is taken. */
const quarantinePathFor = async (root: string, quarantineFolder: string, filePath: string) => {
	const inside = relative(root, filePath);
	if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Not inside the library root: ${filePath}`);
	const base = join(quarantineFolder, inside);
	let quarantinePath = base;
	for (let n = 2; await fileExists(quarantinePath); n++) quarantinePath = base.replace(/(\.[^.\\/]+)?$/, ` (${n})$1`);
	await mkdir(dirname(quarantinePath), { recursive: true });
	return quarantinePath;
};

// rename() cannot cross drives: a quarantine folder on another drive gets a copy, then the original is removed.
const moveFile = async (from: string, to: string) => {
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await copyFile(from, to, constants.COPYFILE_EXCL);
		if ((await stat(to)).size !== (await stat(from)).size) throw new Error(`Copy to quarantine is incomplete: ${to}`);
		await unlink(from);
	}
};

const moveToQuarantine = async (root: string, quarantineFolder: string, filePath: string) => {
	const quarantinePath = await quarantinePathFor(root, quarantineFolder, filePath);
	await moveFile(filePath, quarantinePath);
	return quarantinePath;
};

const audioFilePattern = /\.(flac|m4a|mp4|mp3|aac|wav|ogg|opus|wma|aiff?)$/i;

const filesUnder = async (folder: string): Promise<string[]> => {
	const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
	const nested = await Promise.all(
		entries.map((entry) => (entry.isDirectory() ? filesUnder(join(folder, entry.name)) : Promise.resolve([join(folder, entry.name)]))),
	);
	return nested.flat();
};

/**
 * An unfavorited track goes to quarantine. Cover art and credits stay while the album has any audio
 * left; once it has none, everything in the album folder (CD folders included) follows and the empty
 * folders are removed. Returns the quarantine paths.
 */
export const quarantineTrack = async (root: string, quarantineFolder: string, audioPath: string | string[]) => {
	const filePath = resolvePath(audioPath);
	const moved = [await moveToQuarantine(root, quarantineFolder, filePath)];
	const folder = dirname(filePath);
	const albumFolder = /^CD\d+$/i.test(basename(folder)) ? dirname(folder) : folder;
	// Only a real album folder (Artist\Album or deeper), never an artist folder or the root itself.
	if (relative(root, albumFolder).split(/[\\/]/).filter(Boolean).length < 2) return moved;
	const rest = await filesUnder(albumFolder);
	if (rest.some((file) => audioFilePattern.test(file))) return moved;
	for (const file of rest) moved.push(await moveToQuarantine(root, quarantineFolder, file));
	const folders = (await readdir(albumFolder, { withFileTypes: true }).catch(() => []))
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(albumFolder, entry.name));
	// rmdir only removes empty folders: anything left behind keeps its folder.
	for (const emptyFolder of [...folders, albumFolder]) await rmdir(emptyFolder).catch(() => undefined);
	return moved;
};

/**
 * Puts a freshly downloaded file in place of an existing one. The old file is never deleted: it moves
 * to the quarantine folder under its own relative path (numbered if that is taken).
 */
export const replaceWithQuarantine = async (root: string, quarantineFolder: string, oldPath: string, newPath: string) => {
	if (!(await audioFileExists(newPath))) throw new Error(`Downloaded file is missing: ${newPath}`);
	const quarantinePath = await quarantinePathFor(root, quarantineFolder, oldPath);
	await moveFile(oldPath, quarantinePath);
	try {
		await rename(newPath, oldPath);
	} catch (error) {
		// Put the original back rather than leave a hole in the album.
		await moveFile(quarantinePath, oldPath).catch(() => undefined);
		throw error;
	}
	return quarantinePath;
};

export const appendDownloadLog = async (rootPath: string, fileName: string, header: string, line: string) => {
	const logPath = join(rootPath, fileName);
	await mkdir(rootPath, { recursive: true });
	try {
		// BOM so Excel opens the UTF-8 file with the right encoding.
		await writeFile(logPath, `${String.fromCharCode(0xfeff)}${header}\r\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await appendFile(logPath, `${line}\r\n`, "utf8");
	return logPath;
};

/** Writes a report file (JSON or text) at the library root, replacing an older one. */
export const writeLibraryReport = async (rootPath: string, fileName: string, text: string) => {
	const reportPath = join(rootPath, fileName);
	await writeFile(reportPath, text, "utf8");
	return reportPath;
};

/** Reads a file at the library root (such as a list written for the plugin), or undefined when it is missing. */
export const readLibraryReport = async (rootPath: string, fileName: string) => {
	try {
		return await readFile(join(rootPath, fileName), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};
