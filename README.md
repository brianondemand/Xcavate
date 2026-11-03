# Xcavate

A userscript that downloads **images, videos and GIFs** from X (formerly Twitter) posts in one click, in the best quality X offers. It has a download queue, optional ZIP bundling, GIF conversion and custom file names.

> **Disclaimer:** Xcavate is an independent project. It is not affiliated with, endorsed by, or connected to X Corp.

> **Status:** early release. X changes its site often, so please report anything that breaks (see [Troubleshooting](#troubleshooting)).

---

## Features

- **One-click download** from a button in each post's action row, next to bookmark and share.
- **Original-quality images.** Photos are requested at their original size, with automatic fallbacks to smaller sizes if X refuses it. Xcavate saves the original JPG or PNG instead of a re-encoded WebP.
- **Best-quality video.** It picks the highest-bitrate MP4 that X provides, using resolution as a tie-breaker.
- **GIFs your way.** X serves GIFs as MP4. Save them as the original MP4 (best quality, default) or convert them to a real GIF in your browser, with High or Standard quality.
- **Download queue.** Parallel downloads (1 to 6), live progress on the button, cancel and retry.
- **ZIP bundling.** Posts with several files can be saved as a single ZIP.
- **Custom file names.** Use variables such as `{handle}`, `{id}` and `{date}`, with an optional regex replace and a live preview.
- **Download memory.** Optionally remember which posts you already downloaded and ask before downloading them again.
- **Draggable floating button.** Open the Tasks and Settings panel from a button you can move anywhere. Its position is remembered.
- **Dark mode.** The interface follows your system theme, and the post button matches X's own icon colours.

---

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open `xcavate.user.js` in this repository and click **Raw**. Your userscript manager will offer to install it.
3. Open [x.com](https://x.com/) and log in.

The script runs on `x.com`, `twitter.com` and `m.x.com`.

---

## Usage

### Download a post's media

1. Find a post that has images, video or a GIF.
2. Click the **download icon** in the post's action row.
3. The icon shows progress while it downloads. Click the **×** next to it to cancel.
4. When it finishes the icon turns into a check mark.

If a post has several files and ZIP bundling is on, you get one ZIP. Otherwise the files are saved one by one.

### The floating button

A round button sits on the right side of the screen.

- **Click** it to open the panel.
- **Drag** it to move it. Xcavate remembers where you put it.
- **Tasks tab:** current and recent downloads, with what quality was saved, plus Cancel and Retry.
- **Settings tab:** everything described below.

### Shortcuts and menu

| Action | How |
|---|---|
| Open or close the panel | `Alt` + `X` |
| Close the panel | `Esc` |
| Show or hide the floating button | Tampermonkey menu → **Xcavate: show / hide floating button** |
| Turn network capture on or off | Tampermonkey menu → **Xcavate: toggle network capture** (reloads the page) |

---

## Settings

| Setting | What it does |
|---|---|
| Bundle multiple files into a ZIP | Saves multi-file posts as one ZIP. |
| Save GIF posts as | **MP4** is the original and best quality. **GIF** converts in your browser and is slower. |
| GIF conversion quality | **High** (up to 720 px, 15 fps) or **Standard** (up to 480 px, 10 fps). Only used when saving as GIF. |
| Remember downloaded posts | Marks posts you already downloaded and asks before repeating. |
| Parallel downloads | 1 to 6 files at once. More is faster but uses more bandwidth and memory. |
| Download timeout | How long to wait for a file before giving up. |
| Capture media from X network responses | Lets Xcavate read the media addresses X already loads. Turn it off only if X gets stuck on its loading logo. |
| Show the floating button | Hide the round button if you prefer the menu or `Alt` + `X`. |

### File naming

Names are built from a template. Variables:

| Variable | Meaning |
|---|---|
| `{handle}` | The author's @handle |
| `{name}` | The author's display name |
| `{id}` | The post ID |
| `{date}` | The post date and time |
| `{text}` | The first words of the post |
| `{type}` | `image`, `video`, `gif` or `zip` |
| `{file}` | The original file name |
| `{index}` | The file number within the post |

The default is `{handle}_{id}`. If a post has several files and your template has no `{index}`, a number is added automatically so names don't clash.

You can also add a **regex replace** (for example, replace runs of spaces or underscores). Invalid or risky patterns are rejected and not saved.

---

## How it works

- **Capture.** X's own responses contain the real media addresses. Xcavate reads them as they load and remembers them by post.
- **Lookup.** If a post's media wasn't captured, Xcavate asks X for it using your logged-in session, so it can download the original rather than the thumbnail shown on the timeline.
- **Download.** Files go through a queue. Images are requested at original size. Videos use the highest-quality MP4. Multi-file posts can be packed into a ZIP, and GIFs can be converted.

---

## Known limitations

- Works only with content **your logged-in account can already see**.
- X may also offer some videos as a higher-resolution streaming version. Xcavate downloads the best **MP4** that X provides and does not download streaming versions.
- GIF conversion happens in your browser and can use a lot of memory, especially on High quality.
- ZIP files are built in memory. Very large downloads fall back to saving files separately, about 384 MB on desktop and 128 MB on mobile.
- Browsers may ask permission to download multiple files. ZIP bundling avoids this.
- X changes its site and internal API often, which can break things until the script is updated.

---

## Troubleshooting

**The download button doesn't appear.**
It only appears on posts with media. Reload the page. If it still doesn't show on posts that have media, copy the debug info and open an issue.

**"No downloadable media found."**
For video, play it once and try again. Check that **Capture media from X network responses** is on in Settings.

**X gets stuck on its loading logo.**
Turn off network capture from the Tampermonkey menu (the page reloads). Downloads will still work using the lookup method.

**A video fails to download.**
Try again after a moment. If it keeps failing, copy the debug info. Some Firefox setups with Violentmonkey may not pass your X login correctly; Tampermonkey is recommended.

**File names look wrong.**
Check the preview in Settings. If your regex has no effect, it may have been rejected as invalid or risky.

**Reporting a bug:** open **Settings** → **Copy debug info** and paste it into a new GitHub issue with a short description of what you did. The report contains the script version, browser, your settings, counters and recent log lines. It never contains usernames, post text or URLs.

---

## Privacy

- Xcavate talks only to X and its media hosts (`x.com`, `twimg.com`, `video.twimg.com`, `pbs.twimg.com`, `abs.twimg.com`).
- It has no analytics, no tracking and no servers of its own.
- To look up a post, it uses your existing X login session. That is the same access the X website already has.
- Your settings, the "downloaded posts" list (up to 5,000 post IDs) and a cached lookup identifier are stored by your userscript manager on your computer.

---

## Responsible use

Use Xcavate to save content you own or have permission to keep. Downloading other people's media may be restricted by copyright law and by X's Terms of Service. Respect creators' rights and don't republish content without permission. You are responsible for how you use this tool.

---

## Credits

Xcavate is a media-only derivative of **BetterX** by 流萤可爱捏 (Iskongkongyo), released under the MIT license. Everything except the media download feature was removed, and the download pipeline was reworked and extended.

---

## License

[MIT](LICENSE). Keep the original copyright notice and license text when you publish or redistribute this project.
