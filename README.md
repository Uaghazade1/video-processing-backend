# Video Processing Backend

UGC video creation için FFmpeg backend servisi.

## Railway Deployment

1. **GitHub'a push edin:**
```bash
git init
git add .
git commit -m "Initial video processing backend"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

2. **Railway'de deploy edin:**
   - Railway.app'e gidin
   - "Deploy from GitHub repo" seçin
   - Bu repo'yu seçin
   - Environment variables ekleyin:

```
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=your-bucket-name
R2_PUBLIC_URL=https://your-public-url.com
```

3. **Deploy URL'ini alın:**
   - Railway size bir URL verecek: `https://your-app.railway.app`
   - Bu URL'i main app'inizde kullanın

## API Endpoints

### POST /process-video
Video processing başlatır.

**Request:**
```json
{
  "ugcVideoUrl": "https://...",
  "productDemoUrl": "https://...",
  "hook": "Your hook text",
  "textAlignment": "middle"
}
```

**Response:**
```json
{
  "jobId": "uuid-job-id"
}
```

### GET /job-status/:jobId
İş durumunu kontrol eder.

**Response:**
```json
{
  "status": "completed",
  "progress": 100,
  "videoUrl": "https://..."
}
```

## Local Development

```bash
npm install
npm run dev
```

Environment variables için `.env` dosyası oluşturun. 