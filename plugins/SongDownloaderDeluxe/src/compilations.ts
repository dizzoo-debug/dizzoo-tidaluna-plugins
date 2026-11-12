import { TidalApi, type Album } from "@luna/lib";

import { hasUnofficialWords, labelDiffers, matchesManualList, mostlyOtherArtists } from "./compilationRules";

/**
 * TIDAL's artist page lists compilations apart from albums, EPs and live albums; the album object itself
 * only says "ALBUM". The page (pages/artist) has a "Compilations" module with the artist's own
 * compilations and an "Albums" module with the studio albums, whose ℗/© lines tell the artist's labels.
 * Asked once per artist (memoized); a "show more" compilation list is paged through.
 */
type PagedList = { items?: any[]; totalNumberOfItems?: number; dataApiPath?: string };
type ArtistPage = { rows?: { modules?: { type?: string; title?: string; pagedList?: PagedList }[] }[] };
type ArtistReleases = { compilationIds: Set<string>; albumCopyrights: string[] };

const byArtist = new Map<string, Promise<ArtistReleases>>();
const albumOf = (item: any) => item?.item ?? item;

const getArtistReleases = (artistId: string | number) => {
	const key = String(artistId);
	let releases = byArtist.get(key);
	if (releases === undefined) {
		releases = (async () => {
			const page = await TidalApi.fetch<ArtistPage>(`https://desktop.tidal.com/v1/pages/artist?artistId=${key}&${TidalApi.queryArgs()}`);
			const modules = (page?.rows ?? []).flatMap((row) => row.modules ?? []).filter((m) => m.type === "ALBUM_LIST");
			const section = (name: RegExp) => modules.find((m) => name.test(String(m.title ?? "").trim()))?.pagedList;
			const compilations = section(/^compilations?$/i);
			const compilationIds = new Set((compilations?.items ?? []).map((item) => String(albumOf(item).id)));
			const total = compilations?.totalNumberOfItems ?? compilationIds.size;
			for (let offset = compilationIds.size; compilations?.dataApiPath && offset < total && offset < 500; offset += 50) {
				const more = await TidalApi.fetch<PagedList>(`https://desktop.tidal.com/v1/${compilations.dataApiPath}?limit=50&offset=${offset}&${TidalApi.queryArgs()}`);
				const items = more?.items ?? [];
				for (const item of items) compilationIds.add(String(albumOf(item).id));
				if (items.length === 0) break;
			}
			const albumCopyrights = (section(/^albums$/i)?.items ?? []).map((item) => albumOf(item).copyright).filter(Boolean);
			return { compilationIds, albumCopyrights };
		})();
		// A failed lookup is not remembered, so the next download asks again.
		releases.catch(() => byArtist.delete(key));
		byArtist.set(key, releases);
	}
	return releases;
};

/**
 * Why a release credited to one artist belongs in "!Compilations", or undefined when it stays with the
 * artist. Checked in order of cost: words in the title, the user's list, the album's own track list
 * (memoized by Luna, already loaded for album downloads), then the artist page for the label.
 */
export const otherCompilationReason = async (album: Album, manualList: string | undefined) => {
	let tidalAlbum: any = album.tidalAlbum;
	const artistNames: string[] = tidalAlbum.artists?.map((a: { name: string }) => a.name).filter(Boolean) ?? [];
	const artist = tidalAlbum.artist?.name ?? artistNames[0];
	if (hasUnofficialWords(tidalAlbum.title, tidalAlbum.version)) return "unofficial release (title)";
	if (tidalAlbum.copyright === undefined) tidalAlbum = { ...tidalAlbum, ...((await TidalApi.album(album.id).catch(() => undefined)) ?? {}) };
	if (matchesManualList(manualList, { artist, title: tidalAlbum.title, copyright: tidalAlbum.copyright })) return "on the user's !Compilations list";

	const items = (await TidalApi.albumItems(album.id).catch(() => undefined)) ?? [];
	const trackArtists = items.map((item: any) => (albumOf(item).artists ?? []).map((a: { name: string }) => a.name));
	if (artistNames.length > 0 && mostlyOtherArtists(artistNames, trackArtists)) return "mostly other artists' tracks";

	const artistId = tidalAlbum.artist?.id ?? tidalAlbum.artists?.[0]?.id;
	if (artistId === undefined) return undefined;
	const releases = await getArtistReleases(artistId).catch(() => undefined);
	if (releases?.compilationIds.has(String(album.id)) && labelDiffers(tidalAlbum.copyright, releases.albumCopyrights)) return "unofficial release (label)";
	return undefined;
};
