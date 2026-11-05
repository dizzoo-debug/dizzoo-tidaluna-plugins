# Song Downloader Deluxe

Advanced TIDAL downloading and music-library organization for TidaLuna.

## Highlights

- Track and full-album downloads with Lossless, Hi-Res and Dolby Atmos support.
- Automatic Atmos separation and dedicated multi-disc folder formatting.
- Existing-file detection, padded track numbers, cover art and album credits.
- Automatic download of newly favorited tracks and albums.
- Startup scan that resumes missing albums from My Collection.
- Deferred retries for temporary TIDAL playback and server failures.
- Manual album-credit download from an album context menu.

## Default library layout

The default root is `D:\!My Music`. Single-disc albums use
`Album Artist/Album Artist - Album (year) [variant]/01 - Artist - Title.ext`;
multi-disc albums add a `CD1`, `CD2`, ... directory. TIDAL releases whose album
artist is `Various Artists` are grouped under that branch. Recognized soundtrack
releases are grouped under `!OST`. Deluxe, Super Deluxe and Remastered editions
are normalized into bracketed suffixes, while `[Atmos]` is added only after the
delivered stream confirms Dolby Atmos.

The plugin organizes new downloads; it does not move, delete, deduplicate or
transcode files already in a library.

## Attribution

Based on the original
[Song Downloader by Inrixia](https://github.com/Inrixia/luna-plugins/tree/master/plugins/SongDownloader).
Extended and maintained by Dizzoo under GNU AGPL-3.0.

## Responsible use

Use the plugin only with content you are authorized to access. You are
responsible for complying with TIDAL's terms, applicable licences, and local
law.
