const express = require('express');
const cors = require('cors');
const multer = require('multer');
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
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// Job storage (in-memory for simplicity)
const jobs = new Map();

// Download video from URL
async function downloadVideo(url, outputPath) {
  try {
    console.log(`Downloading: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.writeFile(outputPath, Buffer.from(buffer));
    console.log(`Download completed: ${url}`);
  } catch (error) {
    console.error(`Download failed: ${url}`, error);
    throw error;
  }
}

// Add text overlay to video
function addTextOverlay(inputPath, outputPath, text, alignment) {
  return new Promise((resolve, reject) => {
    // Calculate text position
    let textPosition = '';
    switch (alignment) {
      case 'top':
        textPosition = '(w-text_w)/2:h*0.1';
        break;
      case 'bottom':
        textPosition = '(w-text_w)/2:h*0.85';
        break;
      default: // middle
        textPosition = '(w-text_w)/2:(h-text_h)/2';
        break;
    }

    // Clean and escape text
    const cleanText = text
      .replace(/[^\w\s\-.,!?]/g, '') // Remove emojis and special chars
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .slice(0, 100); // Limit length

    console.log(`Adding text overlay: "${cleanText}"`);

    ffmpeg(inputPath)
      .videoFilters([
        {
          filter: 'drawtext',
          options: {
            text: cleanText,
            fontsize: 32, // Smaller font for less processing
            fontcolor: 'white',
            x: textPosition.split(':')[0],
            y: textPosition.split(':')[1],
            borderw: 2, // Thinner border
            bordercolor: 'black'
          }
        }
      ])
      .outputOptions([
        '-preset', 'ultrafast', // Fast encoding
        '-crf', '28' // Lower quality for speed
      ])
      .output(outputPath)
      .on('end', () => {
        console.log('Text overlay completed');
        resolve();
      })
      .on('error', (error) => {
        console.error('Text overlay failed:', error);
        reject(error);
      })
      .run();
  });
}

// Concatenate videos
function concatenateVideos(ugcPath, demoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('Starting video concatenation...');
    
    ffmpeg()
      .input(ugcPath)
      .input(demoPath)
      .complexFilter([
        // More memory-efficient: smaller resolution for processing
        '[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2[v0]',
        '[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2[v1]',
        'anullsrc=channel_layout=stereo:sample_rate=44100[silent]',
        '[v0][silent][v1][1:a]concat=n=2:v=1:a=1[outv][outa]'
      ])
      .outputOptions([
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast', // Faster encoding, less CPU
        '-crf', '28', // Lower quality, faster processing
        '-c:a', 'aac',
        '-b:a', '128k', // Lower audio bitrate
        '-shortest'
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        console.log('Concatenation progress:', progress.percent);
      })
      .on('end', () => {
        console.log('Video concatenation completed');
        resolve();
      })
      .on('error', (error) => {
        console.error('Concatenation failed:', error);
        reject(error);
      })
      .run();
  });
}

// Simple concatenation - minimal processing
function concatenateVideosSimple(ugcPath, demoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('Starting simple video concatenation...');
    
    // Create a simple list file
    const listContent = `file '${ugcPath}'\nfile '${demoPath}'`;
    const listPath = outputPath + '.list';
    
    fs.writeFileSync(listPath, listContent);
    
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c', 'copy', // Copy streams without re-encoding (fastest)
        '-avoid_negative_ts', 'make_zero'
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        console.log('Simple concatenation progress:', progress.percent);
      })
      .on('end', () => {
        console.log('Simple concatenation completed');
        fs.unlinkSync(listPath); // Clean up list file
        resolve();
      })
      .on('error', (error) => {
        console.error('Simple concatenation failed:', error);
        if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        reject(error);
      })
      .run();
  });
}

// Upload to Cloudflare R2
async function uploadToR2(filePath, fileName) {
  try {
    console.log(`Uploading to R2: ${fileName}`);
    
    const fileBuffer = await fs.readFile(filePath);
    
    const uploadParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `generated-videos/${fileName}`,
      Body: fileBuffer,
      ContentType: 'video/mp4',
    };

    const result = await r2.upload(uploadParams).promise();
    const publicUrl = `${process.env.R2_PUBLIC_URL}/generated-videos/${fileName}`;
    
    console.log(`Upload completed: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error('R2 upload failed:', error);
    throw error;
  }
}

// Process video endpoint
app.post('/process-video', async (req, res) => {
  const jobId = uuidv4();
  
  try {
    const { ugcVideoUrl, productDemoUrl, hook, textAlignment } = req.body;
    
    if (!ugcVideoUrl || !productDemoUrl || !hook || !textAlignment) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Initialize job
    jobs.set(jobId, { status: 'processing', progress: 0 });
    
    // Start processing in background
    processVideoBackground(jobId, { ugcVideoUrl, productDemoUrl, hook, textAlignment });
    
    res.json({ jobId });
    
  } catch (error) {
    console.error('Error starting video processing:', error);
    res.status(500).json({ error: 'Failed to start video processing' });
  }
});

// Get job status endpoint
app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// Background processing function
async function processVideoBackground(jobId, { ugcVideoUrl, productDemoUrl, hook, textAlignment }) {
  try {
    const timestamp = Date.now();
    const ugcTempPath = path.join(TEMP_DIR, `ugc-${timestamp}.mp4`);
    const demoTempPath = path.join(TEMP_DIR, `demo-${timestamp}.mp4`);
    const finalVideoPath = path.join(TEMP_DIR, `final-${timestamp}.mp4`);
    
    // Update progress
    const updateProgress = (progress) => {
      const job = jobs.get(jobId);
      if (job) {
        jobs.set(jobId, { ...job, progress });
      }
    };

    console.log(`Starting minimal processing for job ${jobId}`);
    updateProgress(10);

    // Download UGC video
    await downloadVideo(ugcVideoUrl, ugcTempPath);
    updateProgress(30);

    // Download product demo video
    await downloadVideo(productDemoUrl, demoTempPath);
    updateProgress(50);

    // Simple concatenation - NO TEXT OVERLAY for now
    console.log('Starting simple concatenation...');
    await concatenateVideosSimple(ugcTempPath, demoTempPath, finalVideoPath);
    updateProgress(80);

    // Upload to R2
    const fileName = `generated-ugc-${timestamp}.mp4`;
    const videoUrl = await uploadToR2(finalVideoPath, fileName);
    updateProgress(95);

    // Clean up temp files
    await Promise.all([
      fs.remove(ugcTempPath).catch(() => {}),
      fs.remove(demoTempPath).catch(() => {}),
      fs.remove(finalVideoPath).catch(() => {})
    ]);

    updateProgress(100);

    // Mark job as completed
    jobs.set(jobId, { 
      status: 'completed', 
      progress: 100,
      videoUrl 
    });

    console.log(`Video processing completed for job ${jobId}`);

  } catch (error) {
    console.error(`Video processing failed for job ${jobId}:`, error);
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
  console.log(`Video processing server running on port ${PORT}`);
}); 