# Speech To Text Transcriber

Upload one or more audio files, send them to the OpenAI Whisper API, review the transcripts in the browser, and download each transcript as `.txt` or `.docx`.

## Features

- Multi-file audio upload with drag-and-drop support
- Upload and processing state messages in the UI
- Automatic chunking for audio files above the Whisper API size limit
- Individual transcript downloads with friendly filenames
- One-click `.zip` download containing all generated `.txt` transcripts
- Optional `.docx` export

## Supported Audio Formats

The OpenAI Whisper API accepts these file types:

- **mp3**, **mp4**, **mpeg**, **mpga**, **m4a**, **wav**, **webm**

Maximum file size is **25 MB** per file. Files larger than 25 MB are automatically split into chunks (requires FFmpeg—see below).

## Platform Support

The app runs on **Windows**, **macOS**, and **Linux**. It uses Node.js and standard system paths, so no OS-specific code changes are needed. The main platform difference is how you install FFmpeg and ensure it is on your `PATH` (see below).

## FFmpeg Setup

FFmpeg is **required only for files larger than 25 MB**. The app uses `ffprobe` to read audio duration and `ffmpeg` to split oversized files into chunks before sending them to the Whisper API. Without FFmpeg, files over 25 MB will be rejected with a "file too big" error.

### Why FFmpeg?

- **ffprobe**: Gets the duration of the audio so the app can split it into segments.
- **ffmpeg**: Splits the file into chunks under 25 MB using stream copy (no re-encoding).

Both must be available on your system `PATH` so the Node.js server can run them.

### Installation

**Windows**

- **Option A (winget):** `winget install ffmpeg`
- **Option B (Chocolatey):** `choco install ffmpeg`
- **Option C (manual):** Download from [ffmpeg.org](https://ffmpeg.org/download.html), extract, and add the `bin` folder (e.g. `C:\ffmpeg\bin`) to your system `PATH`.

After installing, **restart your terminal** (or Cursor/VS Code) so the updated `PATH` is picked up. If `ffmpeg` or `ffprobe` still aren't found, add the FFmpeg `bin` directory to your user or system `PATH` in Windows Settings.

**macOS**

```bash
brew install ffmpeg
```

**Linux (Debian/Ubuntu)**

```bash
sudo apt update && sudo apt install ffmpeg
```

### Verify Installation

Run these in a terminal:

```bash
ffmpeg -version
ffprobe -version
```

If both commands print version info, the app can use FFmpeg for large files. If you see "command not found" or similar, FFmpeg is not on your `PATH` and the app will reject files over 25 MB.

## Requirements

- Node.js 18+
- An OpenAI API key
- FFmpeg + ffprobe (for files over 25 MB)—see above

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Edit `.env` and set `OPENAI_API_KEY`.

4. Start the app:

   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Development

Run the server in watch mode:

```bash
npm run dev
```

## Docker and Render

The included **[`Dockerfile`](Dockerfile)** builds **Node 20**, installs **FFmpeg** (needed for splitting large audio), runs **`npm ci`**, checks **minimum package age** on the registry, and **`npm audit`**. Deploy as a **Web Service** with **Docker** runtime (for example [Render](https://render.com)) and point the start command at the image default (`node server.js`).

- **[`render.yaml`](render.yaml)** is a [Render Blueprint](https://render.com/docs/blueprint-spec) stub: connect the repo, set **Environment** → **OPENAI_API_KEY**, and optionally **API_KEY** for `/api/transcribe`.
- **Port:** the server listens on **`process.env.PORT`** (Render sets this automatically).

Build locally:

```bash
docker build -t node-transcriber .
docker run --rm -p 3000:3000 -e OPENAI_API_KEY=your_key_here node-transcriber
```

## Dependency verification

Project **[`.npmrc`](.npmrc)** enables **`npm audit`** at **moderate** severity and **`engine-strict`** against **`package.json`** `engines`.

- **`npm run verify`** — runs [`scripts/check-minimum-release-age.mjs`](scripts/check-minimum-release-age.mjs) (every locked dependency must have been published on npm at least **`MIN_RELEASE_AGE_DAYS`** ago; default **3** days to balance supply-chain caution with timely security patches) and **`npm audit --audit-level=moderate`**.
- **`MIN_RELEASE_AGE_DAYS`** — stricter value (e.g. `7`) in CI or `.env` when you can accept that **new security releases** may fail the age check until they age in (then temporarily raise the limit or use **`SKIP_MIN_RELEASE_AGE=1`** only as an emergency bypass).

## Workflow API (ZIP in one request)

`POST /api/transcribe` accepts the same multipart fields as the browser upload:

- **Audio field name** — send one or more parts using any of: **`files`** (browser default), **`file`** (Make/Postman), **`audio`**, or **`audio_file`**. Extra file parts with other names are ignored (temp files removed); if nothing matches, you get **400** (“No files uploaded”).
- **`language`** — optional Whisper language code (e.g. `en`).
- **`generate_docx`** — set to `1` to include matching `.docx` files in the ZIP (optional).

On success the response is a **`application/zip`** attachment containing `.txt` transcripts (friendly names inside the archive). If `generate_docx` is enabled, each transcript’s `.docx` is included when present.

**Authentication (recommended for public URLs):** If you set **`API_KEY`** in `.env`, clients must send:

`Authorization: Bearer <API_KEY>`

If `API_KEY` is not set, the endpoint accepts requests without a bearer token (suitable for local development only).

Example with `curl` (replace host and paths):

```bash
curl -sS -X POST "http://localhost:3000/api/transcribe" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "files=@/path/to/audio.m4a" \
  -F "language=en" \
  -o transcripts.zip
```

For long jobs where HTTP timeouts are a problem, use the existing **`POST /upload`** (JSON with transcript metadata), **`GET /status/:jobId`**, and **`POST /download-zip`** flow instead.

## Notes

- `.env`, generated uploads, and generated transcripts are ignored by `.gitignore`.
- The app stores generated transcript files in the local `transcripts/` folder for downloads.
- If every uploaded file is above the Whisper API limit and cannot be split, the server returns a clear error message.

## Security

- Never commit your `.env` file. It contains your API key.
- If you accidentally commit a key to GitHub, rotate it immediately.
- For deployments exposed to the internet, set **`API_KEY`** and call **`/api/transcribe`** with the **`Authorization: Bearer`** header so only trusted clients can use your server (OpenAI usage still goes through your `OPENAI_API_KEY`).
