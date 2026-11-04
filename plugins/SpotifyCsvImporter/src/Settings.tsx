import { ReactiveStore } from "@luna/core";
import { showOpenDialog } from "@luna/lib.native";
import { LunaButtonSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";
import React from "react";

import { cancelImport, importCsvFiles, type ImportProgress } from "./importer";
import { trace } from "./runtime";

export const settings = await ReactiveStore.getPluginStorage("SpotifyCsvImporter", {
	addToCollection: false,
	preferOriginalAlbums: true,
	mergeIntoExisting: false,
	replaceVersions: true,
});

const progressText = (progress: ImportProgress) => {
	const file = `${progress.fileIndex + 1}/${progress.fileCount} ${progress.fileName}`;
	switch (progress.stage) {
		case "matching":
			return (
				`${file}: matching ${progress.processed}/${progress.total}` +
				(progress.waitSeconds ? ` (TIDAL rate limit, waiting ${progress.waitSeconds}s)` : "")
			);
		case "creating":
			return `${file}: preparing playlist`;
		case "replacing":
			return `${file}: replacing versions ${progress.processed}/${progress.total}`;
		case "adding":
			return `${file}: adding ${progress.processed}/${progress.total}`;
		case "collection":
			return `${file}: adding to My Collection ${progress.processed}/${progress.total}`;
		case "done":
			return `${file}: done`;
		case "cancelled":
			return `${file}: cancelled`;
	}
};

export const Settings = () => {
	const [addToCollection, setAddToCollection] = React.useState(settings.addToCollection);
	const [preferOriginalAlbums, setPreferOriginalAlbums] = React.useState(settings.preferOriginalAlbums);
	const [mergeIntoExisting, setMergeIntoExisting] = React.useState(settings.mergeIntoExisting);
	const [replaceVersions, setReplaceVersions] = React.useState(settings.replaceVersions);
	const [running, setRunning] = React.useState(false);
	const [status, setStatus] = React.useState(
		"Runtime playlist-api-v8. Select one or more Spotify CSV files. Each file becomes one TIDAL playlist.",
	);

	const startImport = async () => {
		if (running) {
			cancelImport();
			setStatus("Stopping after the current request...");
			return;
		}

		const selection = await showOpenDialog({
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "Spotify CSV", extensions: ["csv"] }],
		});
		if (selection.canceled || selection.filePaths.length === 0) return;

		setRunning(true);
		try {
			const summaries = await importCsvFiles(selection.filePaths, { addToCollection, preferOriginalAlbums, mergeIntoExisting, replaceVersions }, (progress) => setStatus(progressText(progress)));
			const matched = summaries.reduce((sum, item) => sum + item.matched, 0);
			const unmatched = summaries.reduce((sum, item) => sum + item.unmatched, 0);
			setStatus(`Finished: ${summaries.length} playlist(s), ${matched} matched, ${unmatched} unmatched.`);
		} catch (error) {
			setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
			trace.msg.err.withContext("Spotify CSV import failed")(error as Error);
		} finally {
			setRunning(false);
		}
	};

	return (
		<LunaSettings>
			<LunaSwitchSetting
				title="Add imported tracks to My Collection"
				desc="When enabled, every matched track is also added to your TIDAL My Collection. Off by default."
				checked={addToCollection}
				onChange={(_: unknown, checked: boolean) => setAddToCollection((settings.addToCollection = checked))}
			/>
			<LunaSwitchSetting
				title="Prefer original albums over compilations"
				desc="Checks every TIDAL release of the same recording (ISRC) and picks the artist's own album matching the Spotify album, instead of a compilation or Various Artists release. Slower: more TIDAL lookups per track."
				checked={preferOriginalAlbums}
				onChange={(_: unknown, checked: boolean) => setPreferOriginalAlbums((settings.preferOriginalAlbums = checked))}
			/>
			<LunaSwitchSetting
				title="Add to existing playlist with the same name"
				desc="If you already have a playlist named like the CSV file, only the tracks it is missing are appended to it. Otherwise a new playlist is created."
				checked={mergeIntoExisting}
				onChange={(_: unknown, checked: boolean) => setMergeIntoExisting((settings.mergeIntoExisting = checked))}
			/>
			<LunaSwitchSetting
				title="Replace other versions in the existing playlist"
				desc="When adding to an existing playlist, a track that is there in another version (e.g. from a compilation or mixtape) is swapped in place for the newly matched one, and extra copies of that track in other versions are removed. Tracks not in the CSV are left alone."
				checked={replaceVersions}
				disabled={!mergeIntoExisting}
				onChange={(_: unknown, checked: boolean) => setReplaceVersions((settings.replaceVersions = checked))}
			/>
			<LunaButtonSetting
				title="Import Spotify CSV playlists"
				desc={status}
				onClick={startImport}
				children={running ? "Cancel import" : "Select CSV files"}
			/>
		</LunaSettings>
	);
};
