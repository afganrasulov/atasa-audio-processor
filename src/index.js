import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import 'dotenv/config';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Temp directory for audio files
const AUDIO_DIR = path.join(os.tmpdir(), 'atasa-audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Atasa Audio Processor',
  version: '1.1.0',
  endpoints: {
    'POST /extract': 'Extract audio from YouTube video',
    'POST /transcribe': 'Transcribe audio with AssemblyAI or OpenAI',
    'GET /audio/:id': 'Get audio file',
    'GET /status/:id': 'Check processing status'
  }
}));

// In-memory job storage
const jobs = new Map();

// =====================
// FALLBACK AUDIO EXTRACTION
// =====================
async function extractAudio(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(AUDIO_DIR, `${videoId}.mp3`);

  // Remove old file if exists
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const methods = [
    {
      name: 'bestaudio',
      cmd: `yt-dlp -f bestaudio -x --audio-format mp3 --audio-quality 128K -o "${outputPath}" "${url}"`,
      timeout: 300000
    },
    {
      name: 'no-format-select',
      cmd: `yt-dlp -x --audio-format mp3 --audio-quality 128K --no-check-certificates -o "${outputPath}" "${url}"`,
      timeout: 300000
    },
    {
      name: 'geo-bypass',
      cmd: `yt-dlp -x --audio-format mp3 --audio-quality 128K --geo-bypass --extractor-retries 5 --force-ipv4 --sleep-interval 2 --no-check-certificates -o "${outputPath}" "${url}"`,
      timeout: 420000
    }
  ];

  const errors = [];

  for (let i = 0; i < methods.length; i++) {
    const method = methods[i];
    console.log(`🎵 [${i + 1}/${methods.length}] Trying "${method.name}" for ${videoId}...`);
    try {
      // Clean up partial file from previous attempt
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

      await execAsync(method.cmd, { timeout: method.timeout });

      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        if (stats.size > 1000) { // Minimum 1KB to be valid
          console.log(`✅ Audio extracted with "${method.name}": ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          return { outputPath, method: method.name, fileSize: stats.size };
        }
        console.log(`⚠️ "${method.name}" produced too small file (${stats.size} bytes), trying next...`);
        fs.unlinkSync(outputPath);
      } else {
        console.log(`⚠️ "${method.name}" did not create output file, trying next...`);
      }
    } catch (error) {
      const shortError = error.message.split('\n')[0].substring(0, 200);
      console.log(`⚠️ "${method.name}" failed: ${shortError}`);
      errors.push(`${method.name}: ${shortError}`);
      // Clean up partial downloads
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      // Also clean any .part files
      const partFile = outputPath + '.part';
      if (fs.existsSync(partFile)) fs.unlinkSync(partFile);
    }
  }

  throw new Error(`All ${methods.length} extraction methods failed:\n${errors.join('\n')}`);
}

// =====================
// EXTRACT AUDIO ENDPOINT
// =====================
app.post('/extract', async (req, res) => {
  const { videoId, youtubeUrl } = req.body;
  const id = videoId || youtubeUrl?.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)?.[1];

  if (!id) return res.status(400).json({ error: 'videoId or youtubeUrl required' });

  const jobId = `${id}-${Date.now()}`;

  jobs.set(jobId, { status: 'processing', videoId: id, audioPath: null, error: null });
  res.json({ success: true, jobId, status: 'processing' });

  // Background processing
  (async () => {
    try {
      const result = await extractAudio(id);
      jobs.set(jobId, {
        status: 'completed',
        videoId: id,
        audioPath: result.outputPath,
        fileSize: result.fileSize,
        method: result.method,
        error: null
      });
    } catch (error) {
      console.error(`❌ Extraction failed for ${id}:`, error.message);
      jobs.set(jobId, { status: 'failed', videoId: id, audioPath: null, error: error.message });
    }
  })();
});

// =====================
// GET AUDIO FILE
// =====================
app.get('/audio/:videoId', (req, res) => {
  const { videoId } = req.params;
  const audioPath = path.join(AUDIO_DIR, `${videoId}.mp3`);

  if (!fs.existsSync(audioPath)) {
    return res.status(404).json({ error: 'Audio not found' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp3"`);
  fs.createReadStream(audioPath).pipe(res);
});

// =====================
// CHECK STATUS
// =====================
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// =====================
// TRANSCRIBE
// =====================
app.post('/transcribe', async (req, res) => {
  const { videoId, provider, apiKey, language } = req.body;

  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
  if (!['assemblyai', 'openai'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be assemblyai or openai' });
  }

  const audioPath = path.join(AUDIO_DIR, `${videoId}.mp3`);
  const jobId = `transcribe-${videoId}-${Date.now()}`;

  // Check if audio exists, if not extract first
  if (!fs.existsSync(audioPath)) {
    jobs.set(jobId, { status: 'extracting', videoId, transcript: null, error: null });
    res.json({ success: true, jobId, status: 'extracting' });

    // Extract then transcribe
    (async () => {
      try {
        console.log(`🎵 Extracting audio for ${videoId} (with fallback chain)...`);
        await extractAudio(videoId);

        jobs.set(jobId, { status: 'transcribing', videoId, transcript: null, error: null });

        const transcript = await transcribeAudio(audioPath, provider, apiKey, language || 'tr');
        jobs.set(jobId, { status: 'completed', videoId, transcript, error: null });

      } catch (error) {
        console.error(`❌ Failed for ${videoId}:`, error.message);
        jobs.set(jobId, { status: 'failed', videoId, transcript: null, error: error.message });
      }
    })();
  } else {
    // Audio exists, just transcribe
    jobs.set(jobId, { status: 'transcribing', videoId, transcript: null, error: null });
    res.json({ success: true, jobId, status: 'transcribing' });

    (async () => {
      try {
        console.log(`🎙️ Transcribing existing audio for ${videoId}...`);
        const transcript = await transcribeAudio(audioPath, provider, apiKey, language || 'tr');
        jobs.set(jobId, { status: 'completed', videoId, transcript, error: null });
      } catch (error) {
        console.error(`❌ Transcription failed for ${videoId}:`, error.message);
        jobs.set(jobId, { status: 'failed', videoId, transcript: null, error: error.message });
      }
    })();
  }
});

// =====================
// TRANSCRIPTION FUNCTIONS
// =====================

async function transcribeAudio(audioPath, provider, apiKey, language) {
  if (provider === 'openai') {
    return transcribeWithOpenAI(audioPath, apiKey, language);
  } else {
    return transcribeWithAssemblyAI(audioPath, apiKey, language);
  }
}

async function transcribeWithOpenAI(audioPath, apiKey, language) {
  console.log(`🎙️ Transcribing with OpenAI Whisper...`);

  // Read file as buffer
  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = path.basename(audioPath);

  // Create multipart form data manually
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

  const formParts = [];

  // Add file part
  formParts.push(
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
    `Content-Type: audio/mpeg\r\n\r\n`
  );

  const filePartHeader = Buffer.from(formParts.join(''));
  const filePartFooter = Buffer.from('\r\n');

  // Add other fields
  const fields = [
    ['model', 'whisper-1'],
    ['language', language],
    ['response_format', 'text']
  ];

  let fieldsPart = '';
  for (const [key, value] of fields) {
    fieldsPart += `--${boundary}\r\n`;
    fieldsPart += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    fieldsPart += `${value}\r\n`;
  }
  fieldsPart += `--${boundary}--\r\n`;

  const fieldsBuffer = Buffer.from(fieldsPart);

  // Combine all parts
  const body = Buffer.concat([filePartHeader, fileBuffer, filePartFooter, fieldsBuffer]);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: body
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(errorMessage);
  }

  const transcript = await response.text();
  console.log(`✅ OpenAI transcription completed (${transcript.length} chars)`);
  return transcript;
}

async function transcribeWithAssemblyAI(audioPath, apiKey, language) {
  console.log(`🎙️ Transcribing with AssemblyAI...`);

  // 1. Upload file
  console.log(`📤 Uploading to AssemblyAI...`);
  const fileData = fs.readFileSync(audioPath);

  const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/octet-stream'
    },
    body: fileData
  });

  const uploadData = await uploadResponse.json();
  if (!uploadData.upload_url) throw new Error('Upload failed');
  console.log(`✅ Upload successful`);

  // 2. Start transcription
  console.log(`📝 Starting transcription...`);
  const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: uploadData.upload_url,
      language_code: language
    })
  });

  const transcriptData = await transcriptResponse.json();
  if (transcriptData.error) throw new Error(transcriptData.error);

  const transcriptId = transcriptData.id;
  console.log(`📝 Transcript job: ${transcriptId}`);

  // 3. Poll for result
  let completed = false;
  let attempts = 0;
  const maxAttempts = 120; // 10 min max

  while (!completed && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;

    const checkResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { 'Authorization': apiKey }
    });
    const checkData = await checkResponse.json();

    if (checkData.status === 'completed') {
      console.log(`✅ AssemblyAI transcription completed (${checkData.text?.length || 0} chars)`);
      return checkData.text;
    } else if (checkData.status === 'error') {
      throw new Error(checkData.error || 'Transcription failed');
    }

    if (attempts % 6 === 0) console.log(`Polling ${attempts}: ${checkData.status}`);
  }

  throw new Error('Transcription timeout');
}

// =====================
// CLEANUP OLD FILES (every hour)
// =====================
setInterval(() => {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();

  try {
    fs.readdirSync(AUDIO_DIR).forEach(file => {
      const filePath = path.join(AUDIO_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted old file: ${file}`);
      }
    });
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }

  // Clean old jobs
  for (const [jobId, job] of jobs.entries()) {
    const timestamp = parseInt(jobId.split('-').pop());
    if (now - timestamp > maxAge) {
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Atasa Audio Processor on port ${PORT}`);
});
