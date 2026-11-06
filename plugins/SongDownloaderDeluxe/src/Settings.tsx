import { ReactiveStore } from "@luna/core";
import { MediaItem, Quality, type redux } from "@luna/lib";
import { LunaButtonSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting, LunaTitle } from "@luna/ui";

import React from "react";
import { clearCompleteAlbums, completeAlbumCount, keepOutsideTidal, reindexFromLibrary } from "./downloadIndex";
import { getDownloadFolder } from "./helpers";
import type { IdentifyResult } from "./identify";
import { identifyLibraryFiles, replaceIdentifiedFiles } from "./identifyLibrary";

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

// Formats are long: every format field gets the same width; path formats also wrap.
const formatFieldSx = { minWidth: 420, marginTop: 0.25 };
const FormatSetting = (props: React.ComponentProps<typeof LunaTextSetting>) => (
	<LunaTextSetting multiline minRows={2} sx={formatFieldSx} {...props} />
);

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
	const [reindexStatus, setReindexStatus] = React.useState<string>();
	const [identifyStatus, setIdentifyStatus] = React.useState<string>();
	const [identifyList, setIdentifyList] = React.useState<{ path: string; reason?: string }[]>([]);
	const [identifyRan, setIdentifyRan] = React.useState(false);
	const [identified, setIdentified] = React.useState<IdentifyResult["found"]>([]);
	const [replaceStatus, setReplaceStatus] = React.useState<string>();
	const [notFound, setNotFound] = React.useState<IdentifyResult["notFound"]>([]);
	const [keepStatus, setKeepStatus] = React.useState<string>();

	const relativePath = (path: string) => path.slice(settings.defaultPath?.length ?? 0).replace(/^[\\/]/, "");
	const runIdentify = async (broad: boolean) => {
		const root = settings.defaultPath;
		if (root === undefined) return;
		setIdentifyList([]);
		setIdentifyStatus("Looking up files…");
		try {
			const result = await identifyLibraryFiles(
				root,
				(done, total, phase) => setIdentifyStatus(`Looking up ${Math.min(done + 1, total)} / ${total} – ${phase}${broad ? ", wide" : ""}…`),
				{ broad },
			);
			const rest = result.notFound.length;
			const otherAlbum = result.found.filter((f) => f.fromOtherAlbum).length;
			setIdentifyStatus(
				`${broad ? "Wide search: identified" : "Identified"} ${result.found.length} file(s)` +
					(otherAlbum ? ` (${otherAlbum} from another album)` : "") +
					(result.sameAudioAsIdentified.length ? `; ${result.sameAudioAsIdentified.length} duplicate(s) of files that have an id` : "") +
					(result.keptOutsideTidal.length ? `; ${result.keptOutsideTidal.length} archive file(s) skipped` : "") +
					(rest ? `; ${rest} not identified${result.stoppedByRateLimit ? " (stopped: TIDAL answered 429, try again later)" : ""}` : "") +
					(rest || result.found.length || result.keptOutsideTidal.length || result.sameAudioAsIdentified.length ? ":" : "."),
			);
			// One list in library order, each file with what Identify found for it.
			setIdentifyList(
				[
					...result.found.map((f) => ({
						path: relativePath(f.path),
						reason: `identified: ${f.title}${f.album ? ` – ${f.album}` : ""} (TIDAL ${f.id})${f.fromOtherAlbum ? ", from another album" : ""}`,
					})),
					...result.keptOutsideTidal.map((path) => ({ path: relativePath(path), reason: "archive file, not looked up (Search wider looks it up)" })),
					...result.sameAudioAsIdentified.map((d) => ({ path: relativePath(d.path), reason: `duplicate: same audio as ${relativePath(d.identifiedPath)}` })),
					...result.notFound.map((f) => ({ path: relativePath(f.path), reason: f.reason })),
				].sort((a, b) => a.path.localeCompare(b.path)),
			);
			setIdentified(result.found);
			// Files a 429 kept from being searched are not offered for keeping.
			setNotFound(result.notFound.filter((f) => !f.reason?.startsWith("not searched")));
			setKeepStatus(undefined);
			setReplaceStatus(undefined);
			setIdentifyRan(!result.stoppedByRateLimit);
		} catch (error) {
			setIdentifyStatus(`Lookup failed: ${String(error)}`);
		}
	};

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
				desc="Download only tracks favorited after this option is enabled. Requires a Library root and never imports old favorites automatically."
				checked={autoDownloadFavorites}
				onChange={(_, checked) => setAutoDownloadFavorites((settings.autoDownloadFavorites = checked))}
			/>
			<LunaSwitchSetting
				title="Auto-download newly favorited albums"
				desc="Download every track from albums favorited after this option is enabled. Requires a Library root and never imports old favorite albums automatically."
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
			<LunaButtonSetting
				title="Re-index library"
				desc={
					<>
						Reads the TIDAL track id stored in every FLAC under the library root and points the download index at the files where they are now, so renamed or moved albums are not downloaded again. Works on disk only and runs automatically before the startup Collection scan.
						{reindexStatus && (
							<>
								<br />
								{reindexStatus}
							</>
						)}
					</>
				}
				sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
				disabled={defaultPath === undefined || reindexStatus === "Re-indexing…"}
				onClick={async () => {
					if (settings.defaultPath === undefined) return;
					setReindexStatus("Re-indexing…");
					try {
						const result = await reindexFromLibrary(settings.defaultPath);
						setReindexStatus(
							`Indexed ${Object.keys(result.entries).length} track(s) from ${result.scanned} FLAC file(s); ${result.withoutId} without a TIDAL id` +
								(result.sameAudioAsIdentified.length ? `, ${result.sameAudioAsIdentified.length} of them identical to a file that has one (duplicates).` : "."),
						);
					} catch (error) {
						setReindexStatus(`Re-index failed: ${String(error)}`);
					}
				}}
				children="Re-index"
			/>
			<LunaButtonSetting
				title="Identify files without TIDAL id"
				desc={
					<>
						Looks up each FLAC that carries no TIDAL id on TIDAL by artist and title, then with the album name (stopping at the first 429), and adds the certain matches to the download index, so they are not downloaded again. Files are never changed here.
						{identifyStatus && (
							<>
								<br />
								{identifyStatus}
							</>
						)}
						{identifyList.length > 0 && (
							<ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
								{identifyList.map(({ path, reason }) => (
									<li key={path}>
										{path}
										{reason && <div style={{ opacity: 0.75 }}>{reason}</div>}
									</li>
								))}
							</ul>
						)}
					</>
				}
				sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
				disabled={defaultPath === undefined || identifyStatus?.startsWith("Looking up")}
				onClick={() => runIdentify(false)}
				children="Identify"
			/>
			{identifyRan && (
				<LunaButtonSetting
					title="Search wider"
					desc="Runs Identify again, deeper: the archive files are looked up too, and the same recording from another album is accepted when title, artist and length (±1 s) match. Then choose Replace or Keep below."
					sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
					disabled={defaultPath === undefined || identifyStatus?.startsWith("Looking up")}
					onClick={() => runIdentify(true)}
					children="Search wider"
				/>
			)}
			{identified.length > 0 && (
				<LunaButtonSetting
					title="Replace identified files with TIDAL downloads"
					desc={
						<>
							Downloads the {identified.length} identified track(s) from TIDAL with the TIDAL id, cover and tags embedded, and puts each one in place of the old file under the same name. The old files move to _SongDownloader_Quarantine; nothing is deleted. A track TIDAL only serves as Atmos or non-FLAC is skipped.
							{identified.some((f) => f.fromOtherAlbum) && " Files matched from another album get that album's copy of the same recording."}
							{replaceStatus && (
								<>
									<br />
									{replaceStatus}
								</>
							)}
						</>
					}
					sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
					disabled={defaultPath === undefined || replaceStatus?.startsWith("Replacing")}
					onClick={async () => {
						const root = settings.defaultPath;
						if (root === undefined) return;
						setReplaceStatus("Replacing…");
						try {
							const result = await replaceIdentifiedFiles(root, identified, (done, total) => setReplaceStatus(`Replacing ${done} / ${total}…`));
							setReplaceStatus(
								`Replaced ${result.replaced} file(s).` +
									(result.skipped.length ? ` Skipped: ${result.skipped.map((s) => `${relativePath(s.path)} (${s.reason})`).join("; ")}` : ""),
							);
							const replaced = new Set(identified.filter((f) => !result.skipped.some((s) => s.path === f.path)).map((f) => relativePath(f.path)));
							setIdentifyList((list) => list.map((item) => (replaced.has(item.path) ? { ...item, reason: "replaced with the TIDAL download" } : item)));
							setIdentified(identified.filter((f) => result.skipped.some((s) => s.path === f.path)));
						} catch (error) {
							setReplaceStatus(`Replace failed: ${String(error)}`);
						}
					}}
					children="Replace"
				/>
			)}
			{identified.length + notFound.length > 0 && (
				<LunaButtonSetting
					title="Keep files as archive files"
					desc={
						<>
							Keeps the {identified.length + notFound.length} listed file(s){identified.length > 0 && notFound.length > 0 && ` (${identified.length} identified, ${notFound.length} not identified)`} in the library as they are, instead of replacing them: Identify no longer looks them up, only Search wider does. Recognised by their audio, so renaming or moving them keeps the mark.
							{keepStatus && (
								<>
									<br />
									{keepStatus}
								</>
							)}
						</>
					}
					sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
					onClick={async () => {
						const files = [...identified, ...notFound];
						await keepOutsideTidal(files);
						setKeepStatus(`Kept ${files.length} file(s) as archive files.`);
						const kept = new Set(files.map((f) => relativePath(f.path)));
						setIdentifyList((list) => list.map((item) => (kept.has(item.path) ? { ...item, reason: `${item.reason ? `${item.reason}; ` : ""}kept as archive file` } : item)));
						setIdentified([]);
						setNotFound([]);
					}}
					children="Keep"
				/>
			)}
			<LunaTextSetting
				title="Cover filename format"
				desc={
					<>
						The <b>.jpg</b> extension is added automatically. Default: {"{archiveAlbumArtist} - {archiveAlbumTitle} ({year}){variantSuffix}"}
					</>
				}
				sx={formatFieldSx}
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
				sx={formatFieldSx}
				value={creditsFileNameFormat}
				onChange={(e) => setCreditsFileNameFormat((settings.creditsFileNameFormat = e.target.value))}
			/>
			<LunaButtonSetting
				title="Choose library root"
				desc={
					<>
						Default save path for the organized library: all downloads, cover art, credits and the download log go here.
						<br />
						{defaultPath ? <>Using {defaultPath}</> : <>Not set: manual downloads ask where to save.</>}
					</>
				}
				sx={{ whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" }}
				children="Change root"
				onClick={async () => {
					// Cancelling the folder dialog keeps the current root.
					const folder = await getDownloadFolder();
					if (folder !== undefined) setDefaultPath((settings.defaultPath = folder));
				}}
			/>
			<FormatSetting
				title="Path format"
				desc={
					<>
						Define subfolders using <b>/</b>.
						<br />
						For example: {"{artist}/{album}/{title}"}
						<br />
						Saves in subfolder artist/album/ named <b>title.flac</b>.
						<br />
						Available tags are listed below the multi-disc format.
					</>
				}
				value={pathFormat}
				onChange={(e) => setPathFormat((settings.pathFormat = e.target.value))}
			/>
			<FormatSetting
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
			<LunaTitle
				variant="h8"
				title="Available format tags"
				desc={
					<ul style={{ columns: 2, columnGap: 32, margin: 0, paddingLeft: 20 }}>
						{["libraryRoot", "archiveAlbumArtist", "archiveAlbumTitle", "variantSuffix", ...MediaItem.availableTags].map((tag) => (
							<li key={tag}>{`{${tag}}`}</li>
						))}
					</ul>
				}
			/>
		</LunaSettings>
	);
};
