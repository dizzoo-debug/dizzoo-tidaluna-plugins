import { ReactiveStore } from "@luna/core";
import { showOpenDialog } from "@luna/lib.native";
import { LunaButtonSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";
import React from "react";

import { cancelImport, importCsvFiles, type ImportProgress } from "./importer";
import { trace } from "./runtime";

export const settings = await ReactiveStore.getPluginStorage("SpotifyCsvImporter", {
	addToCollection: false,
});

const progressText = (progress: ImportProgress) => {
	const file = `${progress.fileIndex + 1}/${progress.fileCount} ${progress.fileName}`;
	switch (progress.stage) {
		case "matching":
			return `${file}: matching ${progress.processed}/${progress.total}`;
		case "creating":
			return `${file}: creating playlist`;
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
	const [running, setRunning] = React.useState(false);
	const [status, setStatus] = React.useState(
		"Runtime playlist-api-v5. Select one or more Spotify CSV files. Each file becomes one TIDAL playlist.",
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
			const summaries = await importCsvFiles(selection.filePaths, addToCollection, (progress) => setStatus(progressText(progress)));
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
			<LunaButtonSetting
				title="Import Spotify CSV playlists"
				desc={status}
				onClick={startImport}
				children={running ? "Cancel import" : "Select CSV files"}
			/>
		</LunaSettings>
	);
};
