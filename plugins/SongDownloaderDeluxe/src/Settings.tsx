import { ReactiveStore } from "@luna/core";
import { MediaItem, Quality, type redux } from "@luna/lib";
import { LunaButtonSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";

import React from "react";
import { clearCompleteAlbums, completeAlbumCount } from "./downloadIndex";
import { getDownloadFolder } from "./helpers";

type Settings = {
	downloadQuality: redux.AudioQuality;
	defaultPath?: string;
	pathFormat: string;
	multiDiscPathFormat: string;
	useRealMAX: boolean;
	skipExistingFiles: boolean;
	saveCoverArt: boolean;
	coverFileNameFormat: string;
	saveAlbumCredits: boolean;
	creditsFileNameFormat: string;
	autoDownloadFavorites: boolean;
	autoDownloadAlbums: boolean;
	resumeCollectionAlbums: boolean;
	libraryLayoutVersion: number;
};

const defaultSettings: Settings = {
	downloadQuality: Quality.Max.audioQuality,
	defaultPath: "D:\\!My Music",
	pathFormat: "{libraryRoot}/{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}/{trackNumber} - {artist} - {title}",
	multiDiscPathFormat: "{libraryRoot}/{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}/CD{discNumber}/{trackNumber} - {artist} - {title}",
	useRealMAX: false,
	skipExistingFiles: true,
	saveCoverArt: true,
	coverFileNameFormat: "{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}",
	saveAlbumCredits: true,
	creditsFileNameFormat: "{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix} - credits",
	autoDownloadFavorites: true,
	autoDownloadAlbums: true,
	resumeCollectionAlbums: true,
	libraryLayoutVersion: 2,
};

const pluginStorage = ReactiveStore.getStore("@luna/pluginStorage");
const existingCustomSettings = await pluginStorage.get<Settings>("SongDownloaderCustom");
const legacySettings = existingCustomSettings === undefined
	? await pluginStorage.get<Partial<Settings>>("SongDownloader")
	: undefined;

// Seed or migrate persisted settings without replacing choices the user has
// already made. Previously the boolean values below were forced on every plugin
// load, so restarting TIDAL restored the startup profile instead of the saved
// values.
const previousSettings = existingCustomSettings ?? legacySettings;
const layoutMigration = previousSettings !== undefined && previousSettings.libraryLayoutVersion !== defaultSettings.libraryLayoutVersion;
const migratedSettings: Settings = {
	...defaultSettings,
	...legacySettings,
	...existingCustomSettings,
};
if (layoutMigration) {
	migratedSettings.defaultPath = defaultSettings.defaultPath;
	migratedSettings.pathFormat = defaultSettings.pathFormat;
	migratedSettings.multiDiscPathFormat = defaultSettings.multiDiscPathFormat;
	migratedSettings.coverFileNameFormat = defaultSettings.coverFileNameFormat;
	migratedSettings.creditsFileNameFormat = defaultSettings.creditsFileNameFormat;
	// Do not duplicate an existing Collection into the new root before its files are migrated.
	migratedSettings.resumeCollectionAlbums = false;
	migratedSettings.libraryLayoutVersion = defaultSettings.libraryLayoutVersion;
}
const needsMigration =
	existingCustomSettings === undefined ||
	layoutMigration ||
	(Object.keys(defaultSettings) as (keyof Settings)[]).some(
		(key) => existingCustomSettings[key] === undefined && defaultSettings[key] !== undefined,
	);

if (needsMigration) await pluginStorage.set("SongDownloaderCustom", migratedSettings);
if (layoutMigration) await clearCompleteAlbums();

export const settings = await ReactiveStore.getPluginStorage<Settings>("SongDownloaderCustom", defaultSettings);

if (settings.multiDiscPathFormat === undefined) settings.multiDiscPathFormat = defaultSettings.multiDiscPathFormat;

// Sanitize download quality
if (Quality.fromAudioQuality(settings.downloadQuality) === undefined) settings.downloadQuality = Quality.Max.audioQuality;

export const Settings = () => {
	const [downloadQuality, setDownloadQuality] = React.useState(settings.downloadQuality);
	const [defaultPath, setDefaultPath] = React.useState(settings.defaultPath);
	const [pathFormat, setPathFormat] = React.useState(settings.pathFormat);
	const [multiDiscPathFormat, setMultiDiscPathFormat] = React.useState(settings.multiDiscPathFormat);
	const [useRealMAX, setUseRealMAX] = React.useState(settings.useRealMAX);
	const [skipExistingFiles, setSkipExistingFiles] = React.useState(settings.skipExistingFiles);
	const [saveCoverArt, setSaveCoverArt] = React.useState(settings.saveCoverArt);
	const [coverFileNameFormat, setCoverFileNameFormat] = React.useState(settings.coverFileNameFormat);
	const [saveAlbumCredits, setSaveAlbumCredits] = React.useState(settings.saveAlbumCredits);
	const [creditsFileNameFormat, setCreditsFileNameFormat] = React.useState(settings.creditsFileNameFormat);
	const [autoDownloadFavorites, setAutoDownloadFavorites] = React.useState(settings.autoDownloadFavorites);
	const [autoDownloadAlbums, setAutoDownloadAlbums] = React.useState(settings.autoDownloadAlbums);
	const [resumeCollectionAlbums, setResumeCollectionAlbums] = React.useState(settings.resumeCollectionAlbums);
	const [completeAlbums, setCompleteAlbums] = React.useState(completeAlbumCount());

	return (
		<LunaSettings>
			<LunaSelectSetting
				title="Download quality"
				value={downloadQuality}
				onChange={(e) => setDownloadQuality((settings.downloadQuality = e.target.value))}
			>
				{Object.values(Quality.lookups.audioQuality).map((quality) => {
					if (typeof quality !== "string" && quality.audioQuality !== Quality.MQA.audioQuality)
						return <LunaSelectItem key={quality.name} value={quality.audioQuality} children={quality.name} />;
				})}
			</LunaSelectSetting>
			<LunaSwitchSetting
				title="Use RealMAX to find the highest quality"
				checked={useRealMAX}
				onChange={(_, checked) => setUseRealMAX((settings.useRealMAX = checked))}
			/>
			<LunaSwitchSetting
				title="Skip existing audio files"
				desc="Do not download a track when a file with the same final path already exists."
				checked={skipExistingFiles}
				onChange={(_, checked) => setSkipExistingFiles((settings.skipExistingFiles = checked))}
			/>
			<LunaSwitchSetting
				title="Save album cover art"
				desc="Save one JPEG cover next to the downloaded album tracks. Existing cover files are never overwritten."
				checked={saveCoverArt}
				onChange={(_, checked) => setSaveCoverArt((settings.saveCoverArt = checked))}
			/>
			<LunaSwitchSetting
				title="Save album credits"
				desc="Save one UTF-8 .txt file with album and per-track TIDAL credits next to the downloaded tracks. Existing credit files are never overwritten."
				checked={saveAlbumCredits}
				onChange={(_, checked) => setSaveAlbumCredits((settings.saveAlbumCredits = checked))}
			/>
			<LunaSwitchSetting
				title="Auto-download newly favorited tracks"
				desc="Download only tracks favorited after this option is enabled. Requires a Default save path and never imports old favorites automatically."
				checked={autoDownloadFavorites}
				onChange={(_, checked) => setAutoDownloadFavorites((settings.autoDownloadFavorites = checked))}
			/>
			<LunaSwitchSetting
				title="Auto-download newly favorited albums"
				desc="Download every track from albums favorited after this option is enabled. Requires a Default save path and never imports old favorite albums automatically."
				checked={autoDownloadAlbums}
				onChange={(_, checked) => setAutoDownloadAlbums((settings.autoDownloadAlbums = checked))}
			/>
			<LunaSwitchSetting
				title="Resume missing Collection albums on startup"
				desc="After TIDAL starts, scan favorite albums and download only audio files missing from their final paths. Existing files are never overwritten by this startup scan."
				checked={resumeCollectionAlbums}
				onChange={(_, checked) => setResumeCollectionAlbums((settings.resumeCollectionAlbums = checked))}
			/>
			<LunaButtonSetting
				title="Re-check complete albums"
				desc={`${completeAlbums} album(s) were found complete on disk and are skipped by the startup scan without contacting TIDAL. Reset this after deleting or moving music files.`}
				onClick={async () => {
					await clearCompleteAlbums();
					setCompleteAlbums(completeAlbumCount());
				}}
				children="Reset"
			/>
			<LunaTextSetting
				title="Cover filename format"
				desc={
					<>
						The <b>.jpg</b> extension is added automatically. Default: {"{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}"}
					</>
				}
				value={coverFileNameFormat}
				onChange={(e) => setCoverFileNameFormat((settings.coverFileNameFormat = e.target.value))}
			/>
			<LunaTextSetting
				title="Credits filename format"
				desc={
					<>
						The <b>.txt</b> extension is added automatically. Default: {"{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix} - credits"}
					</>
				}
				value={creditsFileNameFormat}
				onChange={(e) => setCreditsFileNameFormat((settings.creditsFileNameFormat = e.target.value))}
			/>
			<LunaButtonSetting
				title="Default save path"
				desc={
					<>
						Set a default folder to save files to (will disable prompting for path on download)
						{defaultPath && (
							<>
								<br />
								Using {defaultPath}
							</>
						)}
					</>
				}
				children={defaultPath === undefined ? "Set default folder" : "Clear default folder"}
				onClick={async () => {
					if (defaultPath !== undefined) return setDefaultPath((settings.defaultPath = undefined));
					setDefaultPath((settings.defaultPath = await getDownloadFolder()));
				}}
			/>
			<LunaTextSetting
				title="Path format"
				desc={
					<>
						Define subfolders using <b>/</b>.
						<br />
						For example: {"{artist}/{album}/{title}"}
						<br />
						Saves in subfolder artist/album/ named <b>title.flac</b>.
						<div style={{ marginTop: 8 }} />
						You can use the following tags:
						<ul>
							{["libraryRoot", "archiveAlbumArtist", "archiveAlbumTitle", "variantSuffix"].map((tag) => (
								<li key={tag}>{tag}</li>
							))}
							{MediaItem.availableTags.map((tag) => (
								<li key={tag}>{tag}</li>
							))}
						</ul>
					</>
				}
				value={pathFormat}
				onChange={(e) => setPathFormat((settings.pathFormat = e.target.value))}
			/>
			<LunaTextSetting
				title="Multi-disc path format"
				desc={
					<>
						Used only when TIDAL reports more than one disc. Default:{" "}
						{"{libraryRoot}/{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}/CD{discNumber}/{trackNumber} - {artist} - {title}"}
					</>
				}
				value={multiDiscPathFormat}
				onChange={(e) => setMultiDiscPathFormat((settings.multiDiscPathFormat = e.target.value))}
			/>
		</LunaSettings>
	);
};
