import { Album, MediaItem, TidalApi, type redux } from "@luna/lib";

type AlbumCreditItem = {
	item: redux.Track;
	type: redux.ContentType;
	credits?: redux.Credit[];
};

type AlbumCreditsResponse = {
	items: AlbumCreditItem[];
	totalNumberOfItems: number;
};

const albumCredits = new Map<string, Promise<AlbumCreditItem[]>>();

const fetchAlbumCredits = (albumId: redux.ItemId) => {
	const albumKey = String(albumId);
	let request = albumCredits.get(albumKey);
	if (request !== undefined) return request;

	request = (async () => {
		const items: AlbumCreditItem[] = [];
		const limit = 100;
		for (let offset = 0; ; offset += limit) {
			const response = await TidalApi.fetch<AlbumCreditsResponse>(
				`https://desktop.tidal.com/v1/albums/${albumId}/items/credits?${TidalApi.queryArgs()}&replace=true&offset=${offset}&limit=${limit}&includeContributors=true`,
			);
			if (response === undefined) break;
			items.push(...response.items);
			if (items.length >= response.totalNumberOfItems || response.items.length < limit) break;
		}
		return items;
	})();

	albumCredits.set(albumKey, request);
	request.catch(() => albumCredits.delete(albumKey));
	return request;
};

const formatTrackNumber = (track: redux.Track, multipleDiscs: boolean) => {
	const trackNumber = String(track.trackNumber).padStart(2, "0");
	return multipleDiscs ? `${track.volumeNumber}-${trackNumber}` : trackNumber;
};

const audioLabel: Record<string, string> = {
	DOLBY_ATMOS: "Dolby Atmos",
	SONY_360RA: "Sony 360 Reality Audio",
	HIRES_LOSSLESS: "Hi-Res Lossless",
	HI_RES_LOSSLESS: "Hi-Res Lossless",
	HI_RES: "Hi-Res",
	LOSSLESS: "Lossless",
	MQA: "MQA",
	HIGH: "High",
	LOW: "Low",
};

const audioPriority = ["Dolby Atmos", "Sony 360 Reality Audio", "Hi-Res Lossless", "Hi-Res", "Lossless", "MQA", "High", "Low"];

const getAudioFormats = (item: Pick<redux.Track, "audioModes" | "audioQuality" | "mediaMetadata">) => {
	const formats = new Set<string>();
	for (const value of [...(item.audioModes ?? []), ...(item.mediaMetadata?.tags ?? []), item.audioQuality]) {
		const label = audioLabel[value];
		if (label !== undefined) formats.add(label);
	}
	return [...formats].sort((a, b) => audioPriority.indexOf(a) - audioPriority.indexOf(b));
};

export const makeAlbumCreditsTextForAlbum = async (album: Album, downloadedAudio?: string) => {
	const albumId = album.id;
	const creditItems = await fetchAlbumCredits(albumId);

	const artist = album.tidalAlbum.artist?.name ?? album.tidalAlbum.artists?.map(({ name }) => name).join(", ") ?? "Unknown artist";
	const title = album.tidalAlbum.title ?? "Unknown album";
	const multipleDiscs = creditItems.some(({ item }) => item.volumeNumber > 1);
	const albumAudioFormats = new Set(getAudioFormats(album.tidalAlbum));
	for (const { item } of creditItems) for (const format of getAudioFormats(item)) albumAudioFormats.add(format);
	const sortedAlbumAudioFormats = [...albumAudioFormats].sort((a, b) => audioPriority.indexOf(a) - audioPriority.indexOf(b));
	const lines = [
		`${artist.toUpperCase()} — ${title.toUpperCase()}`,
		"",
		album.releaseDate && `Released: ${album.releaseDate.slice(0, 10)}`,
		album.recordLabel && `Label: ${album.recordLabel}`,
		downloadedAudio && `Downloaded audio: ${downloadedAudio}`,
		sortedAlbumAudioFormats.length > 0 && `Available audio: ${sortedAlbumAudioFormats.join(", ")}`,
		(await album.upc()) && `UPC: ${await album.upc()}`,
		`TIDAL album ID: ${albumId}`,
		`TIDAL URL: https://tidal.com/album/${albumId}`,
		"",
		"TRACK CREDITS",
		"",
	].filter((line): line is string => line !== undefined);

	for (const { item, credits = [] } of creditItems) {
		lines.push(`${formatTrackNumber(item, multipleDiscs)}. ${item.title}`);
		const audioFormats = getAudioFormats(item);
		if (audioFormats.length > 0) lines.push(`    Audio: ${audioFormats.join(", ")}`);
		for (const credit of credits) {
			const contributors = credit.contributors.map(({ name }) => name).filter(Boolean).join(", ");
			if (contributors) lines.push(`    ${credit.type}: ${contributors}`);
		}
		if (item.copyright) lines.push(`    Copyright: ${item.copyright}`);
		lines.push("");
	}

	if (creditItems.length === 0) lines.push("No track credits were provided by TIDAL.", "");
	lines.push("Source: TIDAL", `Generated: ${new Date().toISOString()}`);
	return `${lines.join("\r\n")}\r\n`;
};

export const makeAlbumCreditsText = async (mediaItem: MediaItem, downloadedAudio?: string) => {
	const albumId = mediaItem.tidalItem.album?.id;
	if (albumId === undefined) return;
	const album = await Album.fromId(albumId);
	if (album === undefined) return;
	return makeAlbumCreditsTextForAlbum(album, downloadedAudio);
};
