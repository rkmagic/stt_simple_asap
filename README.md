# Node Whisper Transcriber

Upload one or more audio files, send them to the OpenAI Whisper API, review the transcripts in the browser, and download each transcript as `.txt` or `.docx`.

## Features

- Multi-file audio upload with drag-and-drop support
- Upload and processing state messages in the UI
- Automatic chunking for audio files above the Whisper API size limit
- Individual transcript downloads with friendly filenames
- One-click `.zip` download containing all generated `.txt` transcripts
- Optional `.docx` export

## Requirements

- Node.js 18+
- An OpenAI API key
- `ffmpeg` and `ffprobe` installed and available on your `PATH` if you want large files to be split automatically

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
