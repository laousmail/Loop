# Loop Road

Turn the tracks you export from your looper into a loop, build arrangements
from it, and take it on the road.

1. Put your looper's 4–6 track files in a Google Drive folder and set sharing to
   **Anyone with the link**.
2. Paste the folder link into the app.
3. The tracks load into a timeline. Move the **Start** and **End** sliders (or
   drag the handles on the timeline), using the ‹ › buttons for small moves
   (hold them to keep moving), then press **Use this loop**. Nothing to type.
   Tap a track's name in the mixer to rename it.
4. The app offers to make **arrangement B** from A. In B (or C, D…) you can
   turn tracks off, push a track's volume up to 150%, or **double** a track with
   a pitched copy (octave up or down, fifth, fourth, two octaves).
5. In **Song** you set the order, e.g. A ×4 → B ×4, and play it in Song mode.
6. **Take it on the road** renders the song to a WAV that plays with the screen
   locked, over car Bluetooth, and offline. You can also save the file.

## Google Drive API key (one-time)

Browsers can't download from `drive.google.com` links directly (Google blocks
cross-site reads), but the Drive API allows it for public files with a free API
key:

1. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   in a Google Cloud project.
2. Under [Credentials](https://console.cloud.google.com/apis/credentials), select
   **Create credentials → API key**.
3. Restrict the key to the **Google Drive API** and to your site's address
   (HTTP referrer, for example `https://you.github.io/*`).
4. Put it in `js/config.js` as `DEFAULT_DRIVE_API_KEY` and deploy. Everyone
   using the site then just pastes Drive links: the key field disappears from
   Settings, and visitors never see anything about keys.

A key in a website's code is visible to anyone who looks. That's normal for
this kind of key, and step 3's restrictions are what keep it safe: the key
then only reads public Drive files, and only from your site.

Without a built-in key, each person can paste their own key in **Settings**
(gear icon), stored on their device only.

You can also skip Drive and **open audio files from the device**.

## Run it

It's a static site with no build step. ES modules and the service worker need
a real HTTP server, so opening `index.html` as a file won't work:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

### Deploy on GitHub Pages

Push the repo, then go to **Settings → Pages → Deploy from a branch** and pick
the branch and `/ (root)`. Add the Pages URL to your API key's referrer
restrictions. On your phone, open the site and choose **Add to Home Screen** so
it opens like an app.

A link like `https://you.github.io/loop/#drive=<folder link>` opens a folder
directly. The app also updates the address bar to this format, so you can
bookmark a project.

## How it works

| File | What it does |
| --- | --- |
| `js/drive.js` | Parses Drive links, lists the folder, and downloads files through the Drive v3 API, with readable error messages |
| `js/cache.js` | Keeps downloaded tracks in IndexedDB so projects reopen instantly and offline |
| `js/state.js` | Project model (loop, track lengths, arrangements, song), saved in `localStorage` per folder |
| `js/timeline.js` | Canvas waveforms, loop handles, and zoom |
| `js/lanes.js` | Builds what each track plays in one loop, repeating shorter tracks to fill it |
| `js/engine.js` | Web Audio playback. Each track and each double is one looping source that never stops. Arrangements are gain changes ramped exactly on loop boundaries, so tracks can't drift |
| `js/dsp/pitchshift.js` | Loop-aware pitch shifter (phase-vocoder time-stretch, then circular resample). The output is the same length as the loop and loops without a gap, so doubles stay in sync |
| `js/pitch-worker.js` | Runs the pitch shifter off the main thread |
| `js/render.js` | Offline render of one seamless pass of the song, written to a WAV that repeats that pass |
| `sw.js` | Caches the app shell for offline use |

Notes:

- **Tracks of different lengths.** The loop starts out as long as the longest
  track and can't run past it. A shorter track repeats from its own beginning
  until the loop ends, shown faded on the timeline.
- **Sample-accurate loop points.** Loop points snap to whole samples, so a
  track and its pitched double stay locked forever.
- **Locked screen.** Live playback keeps the screen awake while playing.
  Phones stop web audio when the screen locks, which is why the road render
  exists.
