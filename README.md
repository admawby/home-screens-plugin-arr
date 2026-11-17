# Arr Stack: a Home Screens plugin

Your *arr media stack on a [Home Screens](https://homescreens.dev) wall display. One module, four views:

| View | Shows | Reads |
|---|---|---|
| **Upcoming releases** | The next N days of episodes, movies and albums, grouped by day, with posters and a state for each: *Downloaded*, *Missing*, *Downloading*, *Partial*, or the air time | Sonarr, Radarr, Lidarr calendars (+ their queues for "Downloading") |
| **Recently added** | What was imported lately, newest first, with quality | Sonarr / Radarr / Lidarr history |
| **Download queue** | Progress bars, time left, and queue speed; stuck imports flagged as *Needs attention* | Sonarr / Radarr / Lidarr queues, SABnzbd (matched to the *arr item by download id) |
| **Seerr requests** | Recent requests with who asked and their status (*Needs approval*, *Requested*, *Partial*, *Available*) | Seerr, Overseerr or Jellyseerr |

Each view has a **list** layout (good for tall modules and portrait screens) and a **poster cards** layout (good for wide strips and landscape screens). **Auto** picks one from the module's shape. Text, colours, font, border and blur all follow the editor's Style panel.

Add the module as many times as you like, one per view. Connection details are set once for the whole plugin.

## Setup

1. Install the plugin (see [Installing](#installing)).
2. **Plugins → Installed → Arr Stack → Plugin settings**: enter the URL of each app you use, including any URL base, for example `http://192.168.1.10:8989`. Leave the others empty.
3. Drag an **Arr Stack** module onto a screen, click it, and under **Secrets** paste the API key for each app (*Settings → General → API Key* in Sonarr, Radarr, Lidarr and Seerr; *Config → General → API Key* in SABnzbd).
4. Pick a view under **Show**.

If an app refuses the request, the module says so in its footer. The usual causes:

- *API key rejected*: wrong key, or the key for a different app.
- *bad request (check AllowedHosts)*: recent Sonarr, Radarr and Lidarr versions only answer host names in their `AllowedHosts` list. Use the app's IP address, or add the name you used to that list.
- *address blocked by the proxy*: the URL resolves to an address Home Screens never proxies, such as a cloud metadata IP.

## How it talks to your apps

Every request goes through the Home Screens hub's plugin proxy:

- API keys are stored as plugin **secrets** on the hub and added to requests server-side. They never reach the browser on the wall.
- Your apps are on your LAN, so the plugin declares the `localNetwork` permission and `"allowedDomains": ["*"]`. The proxy requires both to reach private addresses. In practice the plugin only calls the URLs you enter.
- Posters come from each app's own resized MediaCover copies (`poster-250.jpg`) through the same proxy, so the wall needs no route to your apps and no internet. Set **Posters from** to *remote* to use TheTVDB / TMDB instead. Seerr posters always come from TMDB.
- The proxy allows 240 requests a minute per plugin across all displays. Posters load only when they're visible on screen and are cached for the life of the tab. A rate-limited request is retried after 20 seconds, and the module keeps showing its last good data meanwhile.

## Installing

Not in the Home Screens registry (yet). Two ways:

- **Install from URL**: in the editor's plugin browser, **Install from URL…** with the `plugin.tar.gz` of a release. The URL has to be HTTPS (or `http://localhost` for testing).
- **Developer mode**: `npm run dev`, then paste `http://<your-machine>:5173` in the editor's **Developer** tab. Dev plugins only load in the editor and its Preview, not on `/display`.

## Development

```bash
npm install
npm test           # unit tests for the API normalizers
npm run typecheck
npm run build      # dist/bundle.js
npm run package    # plugin.tar.gz + its SHA-256
```

`src/normalize.ts` turns raw app JSON into items, and has no network code, so it's what the tests cover. `src/data.ts` does the proxy calls, `src/images.ts` the poster cache, and `src/index.tsx` the display. The **Demo data** toggle renders sample items, which is handy for trying layouts and for an empty queue.

CI runs typecheck, tests and build on every push. Pushing a `v*` tag whose version matches `manifest.json` builds `plugin.tar.gz` and attaches it to a GitHub release, with the SHA-256 in the notes.

## License

MIT
