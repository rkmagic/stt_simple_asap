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

## Notes

- `.env`, generated uploads, and generated transcripts are ignored by `.gitignore`.
- The app stores generated transcript files in the local `transcripts/` folder for downloads.
- If every uploaded file is above the Whisper API limit and cannot be split, the server returns a clear error message.

## Security

- Never commit your `.env` file. It contains your API key.
- If you accidentally commit a key to GitHub, rotate it immediately.
