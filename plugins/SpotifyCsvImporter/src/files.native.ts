import { readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join } from "path";

export type CsvSource = {
	filePath: string;
	fileName: string;
	playlistName: string;
	contents: string;
};

export const readCsvFile = async (filePath: string): Promise<CsvSource> => {
	const extension = extname(filePath);
	if (extension.toLowerCase() !== ".csv") throw new Error(`Not a CSV file: ${filePath}`);
	const fileName = basename(filePath);
	const sourceName = basename(filePath, extension).replace(/\.tidal-unmatched$/i, "");
	return {
		filePath,
		fileName,
		playlistName: sourceName.replaceAll("_", " ").trim(),
		contents: await readFile(filePath, "utf8"),
	};
};

export const writeUnmatchedReports = async (sourcePath: string, textContents: string, csvContents: string) => {
	const extension = extname(sourcePath);
	const sourceName = basename(sourcePath, extension).replace(/\.tidal-unmatched$/i, "");
	const basePath = join(dirname(sourcePath), `${sourceName}.tidal-unmatched`);
	const textPath = `${basePath}.txt`;
	await Promise.all([writeFile(textPath, textContents, "utf8"), writeFile(`${basePath}.csv`, csvContents, "utf8")]);
	return textPath;
};
