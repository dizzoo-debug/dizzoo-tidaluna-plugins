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
	return {
		filePath,
		fileName,
		playlistName: basename(filePath, extension).replaceAll("_", " ").trim(),
		contents: await readFile(filePath, "utf8"),
	};
};

export const writeUnmatchedReport = async (sourcePath: string, contents: string) => {
	const extension = extname(sourcePath);
	const reportPath = join(dirname(sourcePath), `${basename(sourcePath, extension)}.tidal-unmatched.csv`);
	await writeFile(reportPath, contents, "utf8");
	return reportPath;
};
