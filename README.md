# Atasa Audio Processor

YouTube video'larından ses çıkarma ve transkripsiyon servisi.

## Endpoints

### `POST /extract`
YouTube videosundan MP3 çıkarır.

```json
{
  "videoId": "dQw4w9WgXcQ"
}
```

### `POST /transcribe`
Ses dosyasını metne çevirir. OpenAI Whisper veya AssemblyAI kullanabilirsiniz.

```json
{
  "videoId": "dQw4w9WgXcQ",
  "provider": "openai",  // veya "assemblyai"
  "apiKey": "sk-xxx",
  "language": "tr"
}
```

### `GET /audio/:videoId`
MP3 dosyasını indirir.

### `GET /status/:jobId`
İşlem durumunu kontrol eder.

## Kurulum

```bash
npm install
npm start
```

## Railway Deployment

1. Railway'de yeni servis oluştur
2. Bu repo'yu bağla
3. Deploy et

## Gereksinimler

- Node.js 18+
- ffmpeg
- yt-dlp (python)
