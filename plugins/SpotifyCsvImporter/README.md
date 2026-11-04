# Spotify CSV Importer

Import Spotify CSV exports as TIDAL playlists without rebuilding them by hand.

## Supported CSV source

Export your playlists with [Exportify](https://exportify.net). The importer is
built and tested against Exportify CSV files (columns such as `Track URI`,
`ISRC`, `Track Name`, `Album Name`, `Artist Name(s)`, `Release Date`,
`Duration (ms)`). CSV files from other export tools are **untested** and may
import with poorer matches or not at all.

## Features

- Select several CSV files and create one TIDAL playlist per file.
- Preserve the original row and track order.
- Match by ISRC first, then by title, artist, album and duration.
- Read Spotify local-track metadata where available.
- Optionally add every matched track to TIDAL My Collection.
- Write a `.tidal-unmatched.csv` report next to each source CSV.
- Show progress and allow cancellation.

Enable **Add imported tracks to My Collection** before importing if you want
Song Downloader Deluxe to process the newly added favorites automatically.
