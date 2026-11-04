import { access, appendFile, constants, mkdir, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

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
