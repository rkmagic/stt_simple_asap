require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
const JSZip = require("jszip");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();
const port = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
const transcriptsDir = path.join(__dirname, "transcripts");
const jobs = new Map();

// OpenAI Whisper API limit is 25 MB (26214400 bytes)
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(transcriptsDir, { recursive: true });

const upload = multer({ dest: uploadDir });

/** UI uses "files"; many HTTP clients (e.g. Make) default to "file". */
const MAX_AUDIO_FILES = 50;
const uploadAudio = upload.fields([
  { name: "files", maxCount: MAX_AUDIO_FILES },
  { name: "file", maxCount: MAX_AUDIO_FILES },
  { name: "audio", maxCount: MAX_AUDIO_FILES },
]);

function getUploadedAudioFiles(req) {
  const raw = req.files;
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  const out = [];
  for (const name of ["files", "file", "audio"]) {
    const chunk = raw[name];
    if (Array.isArray(chunk)) {
      out.push(...chunk);
    }
  }
  return out;
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function transcribeWithOpenAI(filePath, language) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in the environment.");
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");
  if (language) {
    form.append("language", language);
  }

  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
    }
  );

  return response.data.text || "";
}

async function createDocx(filePath, title, text) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph(text),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
}

async function getDurationSeconds(inputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nk=1:nw=1",
      inputPath,
    ]);
    const value = parseFloat(stdout);
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    console.error("ffprobe error:", error.message);
    return null;
  }
}

function scheduleJobCleanup(jobId) {
  const existingJob = jobs.get(jobId);
  if (!existingJob) {
    return;
  }

  clearTimeout(existingJob.cleanupTimer);
  existingJob.cleanupTimer = setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS);
}

function upsertJob(jobId, updates = {}) {
  const existingJob = jobs.get(jobId) || {
    id: jobId,
    status: "queued",
    message: "Waiting for server to receive files.",
    detail: "",
    progress: 0,
    totalItems: 0,
    completedItems: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cleanupTimer: null,
  };

  const nextJob = {
    ...existingJob,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  jobs.set(jobId, nextJob);
  scheduleJobCleanup(jobId);
  return nextJob;
}

function serializeJob(job) {
  if (!job) {
    return null;
  }

  const { cleanupTimer, ...safeJob } = job;
  return safeJob;
}

function sanitizeDownloadName(value, fallbackName) {
  const candidate = path
    .basename(String(value || "").trim())
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return candidate || fallbackName;
}

function ensureExtension(filename, extension) {
  return filename.toLowerCase().endsWith(extension) ? filename : `${filename}${extension}`;
}

function createUniqueName(filename, usedNames) {
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }

  const parsed = path.parse(filename);
  let counter = 2;
  let nextName = `${parsed.name} (${counter})${parsed.ext}`;

  while (usedNames.has(nextName)) {
    counter += 1;
    nextName = `${parsed.name} (${counter})${parsed.ext}`;
  }

  usedNames.add(nextName);
  return nextName;
}

async function splitIntoChunksIfNeeded(file, oversizeFiles) {
  // If file already under limit, just use it as-is.
  if (typeof file.size !== "number" || file.size <= MAX_FILE_BYTES) {
    return [{ path: file.path, labelSuffix: null }];
  }

  const duration = await getDurationSeconds(file.path);
  if (!duration || duration <= 0) {
    // If we can't get duration and the file is over the limit, mark it oversize.
    if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) {
      oversizeFiles.push({
        name: file.originalname || "audio",
        sizeBytes: file.size,
      });
      return [];
    }
    // Otherwise, fall back to processing as a single file.
    return [{ path: file.path, labelSuffix: null }];
  }

  // Estimate how many chunks we need based on size vs. limit,
  // with a small safety factor.
  const approxCount = Math.ceil((file.size / MAX_FILE_BYTES) * 1.2);
  const chunkCount = Math.max(2, approxCount);
  const segmentTime = Math.max(30, Math.ceil(duration / chunkCount)); // at least 30s per chunk

  const ext =
    path.extname(file.originalname || file.path) ||
    path.extname(file.path) ||
    ".m4a";
  const baseName = file.filename || crypto.randomUUID();
  const pattern = path.join(uploadDir, `${baseName}-chunk-%03d${ext}`);

  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file.path,
      "-f",
      "segment",
      "-segment_time",
      String(segmentTime),
      "-c",
      "copy",
      pattern,
    ]);
  } catch (error) {
    console.error("ffmpeg segment error:", error.message);
    // If splitting failed and the file is over the limit, mark it oversize
    // so we don't keep sending it to the OpenAI API and hitting 413 errors.
    if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) {
      oversizeFiles.push({
        name: file.originalname || "audio",
        sizeBytes: file.size,
      });
      return [];
    }
    // Otherwise, fall back to processing as a single file.
    return [{ path: file.path, labelSuffix: null }];
  }

  const chunks = [];
  for (let i = 0; ; i += 1) {
    const chunkPath = path.join(
      uploadDir,
      `${baseName}-chunk-${String(i).padStart(3, "0")}${ext}`
    );
    if (!fs.existsSync(chunkPath)) {
      break;
    }
    const stats = fs.statSync(chunkPath);
    if (!stats.size) {
      fs.unlink(chunkPath, () => {});
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) {
      oversizeFiles.push({
        name: `${file.originalname || "audio"} (part ${i + 1})`,
        sizeBytes: stats.size,
      });
      fs.unlink(chunkPath, () => {});
      continue;
    }
    chunks.push({ path: chunkPath, labelSuffix: ` (part ${i + 1})` });
  }

  if (chunks.length === 0) {
    // No usable chunks under the limit.
    oversizeFiles.push({
      name: file.originalname || "audio",
      sizeBytes: file.size,
    });
  }

  return chunks;
}

/** When API_KEY is set, POST /api/transcribe requires Authorization: Bearer <API_KEY>. */
function optionalApiKey(req, res, next) {
  const key = process.env.API_KEY;
  if (!key || !String(key).trim()) {
    return next();
  }
  const auth = req.headers.authorization || "";
  const match = /^Bearer\s+(\S+)/i.exec(auth);
  const token = match ? match[1] : "";
  if (token !== String(key).trim()) {
    return res.status(401).json({
      error:
        "Unauthorized. Send header Authorization: Bearer <API_KEY> matching the API_KEY environment variable.",
    });
  }
  return next();
}

async function transcribeUploadedFiles(files, { language, generateDocx, jobId }) {
  const items = [];
  const oversizeFiles = [];
  let totalItems = files.length;
  let completedItems = 0;
  const lang = (language || "").trim();
  const trackJob = typeof jobId === "string" && jobId.length > 0;

  const job = (updates) => {
    if (trackJob) {
      upsertJob(jobId, updates);
    }
  };

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const originalFilename = file.originalname || "audio";

      job({
        status: "processing",
        message: "Preparing audio for transcription.",
        detail: `Checking ${originalFilename} (${fileIndex + 1} of ${files.length}).`,
        progress: Math.max(
          5,
          Math.min(
            90,
            Math.round((completedItems / Math.max(totalItems, 1)) * 100)
          )
        ),
        totalItems,
        completedItems,
      });

      const chunks = await splitIntoChunksIfNeeded(file, oversizeFiles);
      if (chunks.length > 1) {
        totalItems += chunks.length - 1;
        job({
          status: "processing",
          message: "Audio split into smaller parts.",
          detail: `${originalFilename} was split into ${chunks.length} parts for the API.`,
          progress: Math.max(
            5,
            Math.min(
              90,
              Math.round((completedItems / Math.max(totalItems, 1)) * 100)
            )
          ),
          totalItems,
          completedItems,
        });
      }

      if (!chunks || chunks.length === 0) {
        fs.unlink(file.path, () => {});
        continue;
      }

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const partLabel =
          chunk.labelSuffix || (chunks.length > 1 ? ` (part ${index + 1})` : "");
        const displayName = `${originalFilename}${partLabel}`;
        const id = crypto.randomUUID();

        job({
          status: "processing",
          message: "Transcription request sent to OpenAI.",
          detail: `${displayName} (${completedItems + 1} of ${totalItems}).`,
          progress: Math.max(
            10,
            Math.min(
              92,
              Math.round((completedItems / Math.max(totalItems, 1)) * 100)
            )
          ),
          totalItems,
          completedItems,
        });

        const transcriptText = await transcribeWithOpenAI(
          chunk.path,
          lang || undefined
        );

        const txtFilename = `${id}.txt`;
        const txtPath = path.join(transcriptsDir, txtFilename);
        fs.writeFileSync(txtPath, transcriptText, "utf8");

        let docxFilename = null;
        if (generateDocx) {
          docxFilename = `${id}.docx`;
          const docxPath = path.join(transcriptsDir, docxFilename);
          await createDocx(docxPath, displayName, transcriptText);
        }

        items.push({
          id,
          originalFilename: displayName,
          transcriptText,
          txtFilename,
          docxFilename,
        });

        completedItems += 1;
        job({
          status: "processing",
          message: "Transcript received from OpenAI.",
          detail: `${displayName} is ready.`,
          progress: Math.max(
            15,
            Math.min(
              97,
              Math.round((completedItems / Math.max(totalItems, 1)) * 100)
            )
          ),
          totalItems,
          completedItems,
        });

        if (chunk.path && chunk.path !== file.path) {
          fs.unlink(chunk.path, () => {});
        }
      }

      if (fs.existsSync(file.path)) {
        fs.unlink(file.path, () => {});
      }
    }

    return { items, oversizeFiles, totalItems, completedItems };
  } catch (error) {
    error.transcribeState = { completedItems, totalItems };
    throw error;
  }
}

async function buildZipBufferFromItems(items, { includeDocx }) {
  const zip = new JSZip();
  const usedNames = new Set();

  for (const item of items) {
    const txtPath = path.join(transcriptsDir, item.txtFilename);
    if (!fs.existsSync(txtPath)) {
      continue;
    }

    const requestedName = sanitizeDownloadName(
      item.originalFilename,
      item.txtFilename
    );
    const txtArchiveName = createUniqueName(
      ensureExtension(requestedName, ".txt"),
      usedNames
    );
    zip.file(txtArchiveName, fs.readFileSync(txtPath, "utf8"));

    if (includeDocx && item.docxFilename) {
      const docxPath = path.join(transcriptsDir, item.docxFilename);
      if (fs.existsSync(docxPath)) {
        const docxArchiveName = createUniqueName(
          `${path.parse(txtArchiveName).name}.docx`,
          usedNames
        );
        zip.file(docxArchiveName, fs.readFileSync(docxPath));
      }
    }
  }

  if (usedNames.size === 0) {
    throw new Error("No transcript files to include in the archive.");
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

app.post("/upload", uploadAudio, async (req, res) => {
  const generateDocx = req.body.generate_docx === "1";
  const language = (req.body.language || "").trim();
  const requestedJobId = (req.body.job_id || "").trim();
  const jobId = requestedJobId || crypto.randomUUID();
  const uploadedFiles = getUploadedAudioFiles(req);

  if (!uploadedFiles.length) {
    upsertJob(jobId, {
      status: "failed",
      message: "No files were received.",
      detail: "Choose at least one audio file and try again.",
      progress: 0,
    });
    return res.status(400).json({ error: "No files uploaded." });
  }

  upsertJob(jobId, {
    status: "processing",
    message: "Files received by server.",
    detail: `${uploadedFiles.length} file(s) ready for processing.`,
    progress: 5,
    totalItems: uploadedFiles.length,
    completedItems: 0,
  });

  try {
    const { items, oversizeFiles, totalItems, completedItems } =
      await transcribeUploadedFiles(uploadedFiles, {
        language,
        generateDocx,
        jobId,
      });

    if (oversizeFiles.length > 0 && items.length === 0) {
      upsertJob(jobId, {
        status: "failed",
        message: "Files were received, but none could be sent to OpenAI.",
        detail:
          "Each file or generated chunk was over the Whisper API size limit of about 25 MB.",
        progress: 100,
        totalItems,
        completedItems,
      });
      return res.status(400).json({
        error:
          "One or more files are too large for the OpenAI Whisper API (max ~25 MB per file). Please trim or compress them and try again.",
        oversizeFiles,
        maxBytes: MAX_FILE_BYTES,
      });
    }

    const completionDetail =
      oversizeFiles.length > 0
        ? `${items.length} transcript(s) ready. ${oversizeFiles.length} file(s) were skipped because they were too large.`
        : `${items.length} transcript(s) ready to download.`;

    const finalJob = upsertJob(jobId, {
      status: "completed",
      message: "Transcription complete.",
      detail: completionDetail,
      progress: 100,
      totalItems,
      completedItems,
    });

    res.json({ job: serializeJob(finalJob), items, language, oversizeFiles });
  } catch (error) {
    console.error(
      "Transcription error:",
      error.response?.data || error.message
    );
    const status = error.response?.status || 500;
    const apiMessage = error.response?.data?.error?.message;
    const state = error.transcribeState || {};
    const totalItems = state.totalItems ?? uploadedFiles.length;
    const completedItems = state.completedItems ?? 0;
    upsertJob(jobId, {
      status: "failed",
      message: "Transcription failed.",
      detail: apiMessage || error.message || "Failed to transcribe audio.",
      progress: Math.max(
        5,
        Math.min(
          99,
          Math.round((completedItems / Math.max(totalItems, 1)) * 100)
        )
      ),
      totalItems,
      completedItems,
    });
    res.status(status).json({
      error: apiMessage || error.message || "Failed to transcribe audio.",
    });
  }
});

app.post(
  "/api/transcribe",
  optionalApiKey,
  uploadAudio,
  async (req, res) => {
    const generateDocx = req.body.generate_docx === "1";
    const language = (req.body.language || "").trim();
    const uploadedFiles = getUploadedAudioFiles(req);

    if (!uploadedFiles.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    try {
      const { items, oversizeFiles } = await transcribeUploadedFiles(
        uploadedFiles,
        {
          language,
          generateDocx,
          jobId: null,
        }
      );

      if (oversizeFiles.length > 0 && items.length === 0) {
        return res.status(400).json({
          error:
            "One or more files are too large for the OpenAI Whisper API (max ~25 MB per file). Please trim or compress them and try again.",
          oversizeFiles,
          maxBytes: MAX_FILE_BYTES,
        });
      }

      const buffer = await buildZipBufferFromItems(items, {
        includeDocx: generateDocx,
      });
      const archiveFilename = `transcripts-${new Date()
        .toISOString()
        .slice(0, 10)}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${archiveFilename}"`
      );
      res.setHeader("X-Transcript-Count", String(items.length));
      if (oversizeFiles.length > 0) {
        res.setHeader(
          "X-Oversize-Warning",
          `${oversizeFiles.length} file(s) skipped (too large).`
        );
      }
      res.send(buffer);
    } catch (error) {
      console.error(
        "API transcribe error:",
        error.response?.data || error.message
      );
      const status = error.response?.status || 500;
      const apiMessage = error.response?.data?.error?.message;
      res.status(status).json({
        error: apiMessage || error.message || "Failed to transcribe audio.",
      });
    }
  }
);

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  res.json(serializeJob(job));
});

app.post("/download-zip", async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  if (files.length === 0) {
    return res.status(400).json({ error: "No transcript files requested." });
  }

  const zip = new JSZip();
  const usedNames = new Set();

  for (const file of files) {
    const filename = path.basename(String(file?.filename || ""));
    if (!filename || path.extname(filename).toLowerCase() !== ".txt") {
      continue;
    }

    const filePath = path.join(transcriptsDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const requestedName = sanitizeDownloadName(file?.downloadName, filename);
    const archiveName = createUniqueName(
      ensureExtension(requestedName, ".txt"),
      usedNames
    );

    zip.file(archiveName, fs.readFileSync(filePath, "utf8"));
  }

  if (usedNames.size === 0) {
    return res.status(404).json({ error: "No transcript files were found." });
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const archiveFilename = `transcripts-${new Date().toISOString().slice(0, 10)}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${archiveFilename}"`
  );
  res.send(buffer);
});

app.get("/download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(transcriptsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found.");
  }

  const downloadName = sanitizeDownloadName(req.query.name, filename);
  res.download(filePath, downloadName);
});

app.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError)) {
    return next(err);
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      error: "Unexpected multipart field for file upload.",
      hint:
        'Use field name "files" (browser default), "file" (common in Make/Postman), or "audio" for each audio part.',
    });
  }
  return res.status(400).json({ error: err.message, code: err.code });
});

app.listen(port, () => {
  console.log(
    `Node transcriber app listening at http://localhost:${port} (pid: ${process.pid})`
  );
});

