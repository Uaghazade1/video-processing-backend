const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Temp directory
const TEMP_DIR = '/tmp';

// Cloudflare R2 Configuration
const r2 = new AWS.S3({
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// Job storage
const jobs = new Map();

// Download video from URL
async function downloadVideo(url, outputPath) {
  console.log(`📥 Downloading: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  
  const buffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(buffer));
  
  const stats = await fs.stat(outputPath);
  console.log(`✅ Downloaded: ${stats.size} bytes to ${outputPath}`);
}

// Add text overlay to video
function addTextOverlay(inputPath, outputPath, text, alignment) {
  return new Promise((resolve, reject) => {
    const cleanText = text.replace(/['"]/g, '');
    const lines = wrapText(cleanText, 25);
    const lineSpacing = 50; // Define line spacing

    const baseY =
      alignment === 'top' ? 120 :
      alignment === 'bottom' ? 'h-200' :
      '(h/2 - ' + ((lines.length - 1) * lineSpacing) / 2 + ')';

    console.log(`📝 Adding multiline centered text overlay (${alignment})`);

    const drawtextFilters = lines.map((line, i) => ({
      filter: 'drawtext',
      options: {
        text: line, // Use individual line, not formattedText
        fontfile: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        fontsize: 42,
        fontcolor: 'white',
        x: '(w-text_w)/2',
        y: `(${baseY})+${i * lineSpacing}`,
        borderw: 4,
        bordercolor: 'black',
        shadowcolor: 'black',
        shadowx: 2,
        shadowy: 2,
        box: 1,
        boxcolor: 'black@0.3',
        boxborderw: 15,
      },
    }));

    ffmpeg(inputPath)
      .videoFilters(drawtextFilters)
      .outputOptions(['-preset', 'fast', '-crf', '23'])
      .output(outputPath)
      .on('end', () => {
        console.log('✅ Text overlay completed and centered');
        resolve();
      })
      .on('error', (error) => {
        console.error('❌ Text overlay failed:', error.message);
        reject(error);
      })
      .run();
  });
}

// Helper function to wrap text into multiple lines
function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + word).length > maxCharsPerLine) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine = word + ' ';
      }
    } else {
      currentLine += word + ' ';
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }

  return lines.slice(0, 3); // sadece array döndür
}

// ROBUST concat that handles audio/video format differences
function concatenateVideos(ugcPath, demoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('🔗 Starting ROBUST video concatenation...');
    console.log(`  UGC: ${ugcPath}`);
    console.log(`  Demo: ${demoPath}`);
    console.log(`  Output: ${outputPath}`);

    // First, let's normalize both videos to have compatible formats
    const normalizedUgcPath = ugcPath.replace('.mp4', '_normalized.mp4');
    const normalizedDemoPath = demoPath.replace('.mp4', '_normalized.mp4');

    // Step 1: Normalize UGC video
    normalizeVideo(ugcPath, normalizedUgcPath)
      .then(() => {
        console.log('✅ UGC video normalized');
        // Step 2: Normalize Demo video
        return normalizeVideo(demoPath, normalizedDemoPath);
      })
      .then(() => {
        console.log('✅ Demo video normalized');
        // Step 3: Simple concat of normalized videos
        return simpleConcat(normalizedUgcPath, normalizedDemoPath, outputPath);
      })
      .then(() => {
        console.log('✅ Videos concatenated successfully');
        // Cleanup normalized files
        fs.remove(normalizedUgcPath).catch(() => {});
        fs.remove(normalizedDemoPath).catch(() => {});
        resolve();
      })
      .catch((error) => {
        console.error('❌ Concatenation process failed:', error.message);
        // Cleanup on failure
        fs.remove(normalizedUgcPath).catch(() => {});
        fs.remove(normalizedDemoPath).catch(() => {});
        reject(error);
      });
  });
}

// Normalize a single video (ensure audio track, standard format)
function normalizeVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`🔧 Normalizing video: ${path.basename(inputPath)}`);
    
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '128k',
        '-shortest',
        '-f', 'mp4',
        '-movflags', '+faststart'
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        console.log(`🚀 Normalize command: ${cmd.substring(0, 100)}...`);
      })
      .on('end', () => {
        console.log(`✅ Normalized: ${path.basename(outputPath)}`);
        resolve();
      })
      .on('error', (error) => {
        console.error(`❌ Normalize failed for ${path.basename(inputPath)}:`, error.message);
        reject(error);
      })
      .run();
  });
}

// Simple concatenation of two normalized videos
function simpleConcat(video1Path, video2Path, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('🔗 Simple concat of normalized videos...');
    
    const listContent = `file '${video1Path}'\nfile '${video2Path}'`;
    const listPath = path.join(TEMP_DIR, `concat-${Date.now()}.txt`);
    
    fs.writeFileSync(listPath, listContent);
    console.log(`📝 Concat list created`);

    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c', 'copy',  // Since videos are already normalized, just copy
        '-movflags', '+faststart'
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        console.log(`🚀 Concat command: ${cmd.substring(0, 100)}...`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`⏳ Concat progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        fs.remove(listPath); // cleanup
        console.log('✅ Simple concatenation completed!');
        
        if (fs.existsSync(outputPath)) {
          const outputStats = fs.statSync(outputPath);
          console.log(`📊 Final output size: ${(outputStats.size / 1024 / 1024).toFixed(2)}MB`);
          resolve();
        } else {
          reject(new Error('Output file was not created'));
        }
      })
      .on('error', (error) => {
        fs.remove(listPath); // cleanup
        console.error('❌ Simple concat failed:', error.message);
        reject(error);
      })
      .run();
  });
}

// Upload to R2
async function uploadToR2(filePath, fileName) {
  console.log(`📤 Uploading to R2: ${fileName}`);
  
  const fileBuffer = await fs.readFile(filePath);
  const uploadParams = {
    Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
    Key: `generated-videos/${fileName}`,
    Body: fileBuffer,
    ContentType: 'video/mp4',
  };

  const result = await r2.upload(uploadParams).promise();
  const publicUrl = `${process.env.CLOUDFLARE_PUBLIC_DOMAIN}/generated-videos/${fileName}`;
  
  console.log(`✅ Upload completed: ${publicUrl}`);
  return publicUrl;
}

// Process video endpoint
app.post('/process-video', async (req, res) => {
  const jobId = uuidv4();
  console.log(`\n🎬 NEW JOB: ${jobId}`);
  
  const { ugcVideoUrl, productDemoUrl, hook, textAlignment } = req.body;
  
  if (!ugcVideoUrl || !productDemoUrl || !hook || !textAlignment) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Initialize job
  jobs.set(jobId, { status: 'processing', progress: 0 });
  
  // Start processing
  processVideo(jobId, { ugcVideoUrl, productDemoUrl, hook, textAlignment });
  
  res.json({ jobId });
});

// Get job status
app.get('/job-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Main processing function
async function processVideo(jobId, { ugcVideoUrl, productDemoUrl, hook, textAlignment }) {
  const updateProgress = (progress) => {
    const job = jobs.get(jobId);
    if (job) jobs.set(jobId, { ...job, progress });
  };

  try {
    console.log(`\n🎯 Processing job ${jobId}`);
    console.log(`📝 Hook: "${hook}"`);
    console.log(`📍 Position: ${textAlignment}`);

    const timestamp = Date.now();
    const ugcPath = path.join(TEMP_DIR, `ugc-${timestamp}.mp4`);
    const ugcWithTextPath = path.join(TEMP_DIR, `ugc-text-${timestamp}.mp4`);
    const demoPath = path.join(TEMP_DIR, `demo-${timestamp}.mp4`);
    const finalPath = path.join(TEMP_DIR, `final-${timestamp}.mp4`);

    // Step 1: Download UGC
    updateProgress(10);
    await downloadVideo(ugcVideoUrl, ugcPath);

    // Step 2: Download Demo
    updateProgress(30);
    await downloadVideo(productDemoUrl, demoPath);

    // Step 3: Add text to UGC
    updateProgress(50);
    await addTextOverlay(ugcPath, ugcWithTextPath, hook, textAlignment);

    // Step 4: Concatenate UGC+text with Demo
    updateProgress(70);
    await concatenateVideos(ugcWithTextPath, demoPath, finalPath);

    // Step 5: Upload final video
    updateProgress(90);
    const fileName = `generated-${timestamp}.mp4`;
    const videoUrl = await uploadToR2(finalPath, fileName);

    // Cleanup
    await Promise.all([
      fs.remove(ugcPath),
      fs.remove(ugcWithTextPath), 
      fs.remove(demoPath),
      fs.remove(finalPath)
    ]);

    // Mark complete
    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl
    });

    console.log(`🎉 JOB COMPLETED: ${jobId}`);
    console.log(`🔗 Video URL: ${videoUrl}`);

  } catch (error) {
    console.error(`💥 JOB FAILED: ${jobId}`, error);
    jobs.set(jobId, {
      status: 'failed',
      progress: 0,
      error: error.message
    });
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Video processing server running on port ${PORT}`);
  console.log(`📝 Environment check:`);
  console.log(`  - R2 Account ID: ${process.env.CLOUDFLARE_ACCOUNT_ID ? 'SET' : 'MISSING'}`);
  console.log(`  - R2 Access Key: ${process.env.CLOUDFLARE_ACCESS_KEY_ID ? 'SET' : 'MISSING'}`);
  console.log(`  - R2 Bucket: ${process.env.CLOUDFLARE_BUCKET_NAME || 'MISSING'}`);
  console.log(`  - R2 Domain: ${process.env.CLOUDFLARE_PUBLIC_DOMAIN || 'MISSING'}`);
}); 