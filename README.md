# Dizzoo TidaLuna Plugins

Two practical plugins for the [TidaLuna](https://github.com/Inrixia/TidaLuna)
desktop client mod: **Song Downloader Deluxe** and **Spotify CSV Importer**.

## Installation

1. Install TidaLuna and open TIDAL.
2. Open **Luna Settings → Plugin Store**.
3. Add this store URL:

   ```text
   https://github.com/dizzoo-debug/dizzoo-tidaluna-plugins/releases/download/latest/store.json
   ```

4. Install and enable the plugins you want.

## Plugins

### Song Downloader Deluxe

An enhanced TIDAL download and local music-library management plugin.

- Downloads individual tracks and complete albums.
- Supports Lossless, Hi-Res and actual Dolby Atmos releases.
- Separates Atmos downloads from standard stereo albums.
- Skips audio files that already exist.
- Saves album artwork and detailed TIDAL credits.
- Supports separate single-disc and multi-disc folder layouts.
- Zero-pads track numbers for correct file ordering.
- Automatically downloads newly favorited tracks and albums.
- Resumes missing Collection album downloads after TIDAL restarts.
- Retries temporary server failures with fresh playback URLs.
- Provides configurable audio, cover and credits filenames.
- Ignores personalized radio-station favorites.

Song Downloader Deluxe is based on the original Song Downloader plugin by
[Inrixia](https://github.com/Inrixia/luna-plugins/tree/master/plugins/SongDownloader),
extended and maintained by Dizzoo.

### Spotify CSV Importer

Imports Spotify CSV exports directly into TIDAL playlists.

> Export playlists with [Exportify](https://exportify.net). Only Exportify CSV
> files are tested; CSVs from other export tools are untested.

- Imports one or multiple CSV files at once.
- Creates one TIDAL playlist for every selected file.
- Preserves the original track order.
- Matches tracks by ISRC when available.
- Falls back to artist, title, album and duration matching.
- Understands Spotify local-track metadata when present.
- Can optionally add matched tracks to TIDAL My Collection.
- Produces a CSV report for tracks that could not be matched.
- Displays progress and supports cancellation.

When **Add imported tracks to My Collection** is enabled, Song Downloader
Deluxe can automatically download the newly imported favorites.

## Responsible use

Use these plugins only with content and accounts you are authorized to use.
Users are responsible for complying with TIDAL's terms, applicable licences,
and local law. These plugins are independent community projects and are not
affiliated with or endorsed by TIDAL.

## Development

```bash
pnpm install
pnpm run watch
```

`pnpm run build` creates the production plugins and `store.json` in `dist/`.
Pushing to `master` publishes the contents of `dist/` to the GitHub `latest`
release automatically.

## Licence and credits

Licensed under [GNU AGPL-3.0](LICENSE). See [NOTICE.md](NOTICE.md) for upstream
credits and attribution.
