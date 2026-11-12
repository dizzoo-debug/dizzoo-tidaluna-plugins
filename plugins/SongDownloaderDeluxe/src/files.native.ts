import { access, appendFile, constants, mkdir, readdir, rename, stat, writeFile } from "fs/promises";
import { basename, dirname, join, relative } from "path";

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

/**
 * Puts a freshly downloaded file in place of an existing one. The old file is never deleted: it moves
 * to <root>/_SongDownloader_Quarantine under its own relative path (numbered if that is taken).
 */
export const replaceWithQuarantine = async (root: string, oldPath: string, newPath: string) => {
	if (!(await audioFileExists(newPath))) throw new Error(`Downloaded file is missing: ${newPath}`);
	const base = join(root, "_SongDownloader_Quarantine", relative(root, oldPath));
	let quarantinePath = base;
	for (let n = 2; await fileExists(quarantinePath); n++) quarantinePath = base.replace(/(\.[^.\\/]+)?$/, ` (${n})$1`);
	await mkdir(dirname(quarantinePath), { recursive: true });
	await rename(oldPath, quarantinePath);
	try {
		await rename(newPath, oldPath);
	} catch (error) {
		// Put the original back rather than leave a hole in the album.
		await rename(quarantinePath, oldPath).catch(() => undefined);
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
