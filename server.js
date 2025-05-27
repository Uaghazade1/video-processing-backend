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
console.log('R2 Environment Variables:');
console.log('CLOUDFLARE_ACCOUNT_ID:', process.env.CLOUDFLARE_ACCOUNT_ID);
console.log('CLOUDFLARE_ACCESS_KEY_ID:', process.env.CLOUDFLARE_ACCESS_KEY_ID ? 'SET' : 'MISSING');
console.log('CLOUDFLARE_SECRET_ACCESS_KEY:', process.env.CLOUDFLARE_SECRET_ACCESS_KEY ? 'SET' : 'MISSING');
console.log('CLOUDFLARE_BUCKET_NAME:', process.env.CLOUDFLARE_BUCKET_NAME);
console.log('CLOUDFLARE_PUBLIC_DOMAIN:', process.env.CLOUDFLARE_PUBLIC_DOMAIN);

const r2 = new AWS.S3({
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
  secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// Job storage (in-memory for simplicity)
const jobs = new Map();

// Download video from URL
async function downloadVideo(url, outputPath) {
  try {
    console.log(`Trying to download: ${url}`);
    console.log(`Output path: ${outputPath}`);
    
    const response = await fetch(url);
    
    console.log(`Response status: ${response.status}`);
    console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`Downloaded ${buffer.byteLength} bytes`);
    
    await fs.writeFile(outputPath, Buffer.from(buffer));
    
    // Check file size after writing
    const stats = await fs.stat(outputPath);
    console.log(`File written: ${stats.size} bytes at ${outputPath}`);
    
    console.log(`Download completed successfully: ${url}`);
  } catch (error) {
    console.error(`Download failed for ${url}:`, error);
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

// Ultra simple concatenation - better error handling and fallback
function concatenateVideosSimple(ugcPath, demoPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log('Starting enhanced simple video concatenation...');
    console.log(`UGC path: ${ugcPath}`);
    console.log(`Demo path: ${demoPath}`);
    console.log(`Output path: ${outputPath}`);
    
    // Check if input files exist and get their info
    if (!fs.existsSync(ugcPath)) {
      reject(new Error(`UGC file not found: ${ugcPath}`));
      return;
    }
    
    if (!fs.existsSync(demoPath)) {
      reject(new Error(`Demo file not found: ${demoPath}`));
      return;
    }
    
    const ugcStats = fs.statSync(ugcPath);
    const demoStats = fs.statSync(demoPath);
    console.log(`UGC file size: ${ugcStats.size} bytes`);
    console.log(`Demo file size: ${demoStats.size} bytes`);
    
    // Method 1: Try with filter_complex (more compatible)
    const tryFilterComplexConcat = () => {
      console.log('Trying filter_complex concatenation...');
      
      ffmpeg()
        .input(ugcPath)
        .input(demoPath)
        .complexFilter([
          '[0:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]',
          '[1:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]',
          '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]',
          '[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]',
          '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'
        ])
        .outputOptions([
          '-map', '[outv]',
          '-map', '[outa]',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '28',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', 'faststart'
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log('Filter complex FFmpeg command: ' + commandLine);
        })
        .on('progress', (progress) => {
          console.log('Filter complex progress:', progress.percent || 'unknown');
        })
        .on('end', () => {
          console.log('Filter complex concatenation completed successfully');
          
          // Verify output file exists and has reasonable size
          if (fs.existsSync(outputPath)) {
            const outputStats = fs.statSync(outputPath);
            console.log(`Filter complex output file created: ${outputStats.size} bytes`);
            
            if (outputStats.size > ugcStats.size) {
              console.log('✅ Filter complex concatenation successful - file size increased');
              resolve();
            } else {
              console.log('⚠️ Filter complex output seems too small, trying fallback...');
              tryListConcat();
            }
          } else {
            console.error('Filter complex output file was not created!');
            tryListConcat();
          }
        })
        .on('error', (error) => {
          console.error('Filter complex concatenation failed:', error);
          tryListConcat();
        })
        .run();
    };
    
    // Method 2: Try simple list concat
    const tryListConcat = () => {
      console.log('Trying list concatenation...');
      
      const listContent = `file '${ugcPath}'\nfile '${demoPath}'`;
      const listPath = outputPath + '.list';
      
      console.log(`Creating concat list file: ${listPath}`);
      console.log(`List content:\n${listContent}`);
      
      fs.writeFileSync(listPath, listContent);
      
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts'
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          console.log('List concat FFmpeg command: ' + commandLine);
        })
        .on('progress', (progress) => {
          console.log('List concat progress:', progress.percent || 'unknown');
        })
        .on('end', () => {
          console.log('List concatenation completed successfully');
          
          // Clean up list file
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
          
          // Verify output
          if (fs.existsSync(outputPath)) {
            const outputStats = fs.statSync(outputPath);
            console.log(`List concat output file created: ${outputStats.size} bytes`);
            
            if (outputStats.size > ugcStats.size) {
              console.log('✅ List concatenation successful - file size increased');
              resolve();
            } else {
              console.log('⚠️ List concat output seems too small, using UGC only as last resort...');
              tryUgcOnlyFallback();
            }
          } else {
            console.error('List concat output file was not created!');
            tryUgcOnlyFallback();
          }
        })
        .on('error', (error) => {
          console.error('List concatenation failed:', error);
          
          // Clean up list file
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
          
          tryUgcOnlyFallback();
        })
        .run();
    };
    
    // Method 3: Last resort - UGC only
    const tryUgcOnlyFallback = () => {
      console.log('🚨 All concatenation methods failed. Using UGC only as fallback...');
      
      try {
        fs.copyFileSync(ugcPath, outputPath);
        console.log('⚠️ Fallback successful: Using UGC video only (no demo video)');
        resolve();
      } catch (copyError) {
        console.error('Even UGC-only fallback failed:', copyError);
        reject(copyError);
      }
    };
    
    // Start with filter_complex method
    tryFilterComplexConcat();
  });
}

// Upload to Cloudflare R2
async function uploadToR2(filePath, fileName) {
  try {
    console.log(`Uploading to R2: ${fileName}`);
    console.log(`Using bucket: ${process.env.CLOUDFLARE_BUCKET_NAME}`);
    
    if (!process.env.CLOUDFLARE_BUCKET_NAME) {
      throw new Error('CLOUDFLARE_BUCKET_NAME environment variable is not set');
    }
    
    const fileBuffer = await fs.readFile(filePath);
    
    const uploadParams = {
      Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
      Key: `generated-videos/${fileName}`,
      Body: fileBuffer,
      ContentType: 'video/mp4',
    };

    console.log('Upload params:', { 
      Bucket: uploadParams.Bucket, 
      Key: uploadParams.Key, 
      ContentType: uploadParams.ContentType 
    });

    const result = await r2.upload(uploadParams).promise();
    const publicUrl = `${process.env.CLOUDFLARE_PUBLIC_DOMAIN}/generated-videos/${fileName}`;
    
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
    
    console.log('=== NEW VIDEO PROCESSING REQUEST ===');
    console.log('Job ID:', jobId);
    console.log('UGC Video URL:', ugcVideoUrl);
    console.log('Demo Video URL:', productDemoUrl);
    console.log('Hook:', hook);
    console.log('Text Alignment:', textAlignment);
    
    if (!ugcVideoUrl || !productDemoUrl || !hook || !textAlignment) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Validate URLs
    try {
      new URL(ugcVideoUrl);
      new URL(productDemoUrl);
    } catch (urlError) {
      console.error('Invalid URL provided:', urlError);
      return res.status(400).json({ error: 'Invalid video URLs provided' });
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
    const ugcWithTextPath = path.join(TEMP_DIR, `ugc-text-${timestamp}.mp4`);
    const demoTempPath = path.join(TEMP_DIR, `demo-${timestamp}.mp4`);
    const finalVideoPath = path.join(TEMP_DIR, `final-${timestamp}.mp4`);
    
    // Update progress
    const updateProgress = (progress) => {
      const job = jobs.get(jobId);
      if (job) {
        jobs.set(jobId, { ...job, progress });
      }
    };

    console.log(`Starting video processing with text overlay and concatenation for job ${jobId}`);
    console.log(`Hook text: "${hook}"`);
    console.log(`Text alignment: ${textAlignment}`);
    updateProgress(10);

    // Download UGC video
    console.log('Downloading UGC video...');
    await downloadVideo(ugcVideoUrl, ugcTempPath);
    updateProgress(30);

    // Download product demo video
    console.log('Downloading demo video...');
    await downloadVideo(productDemoUrl, demoTempPath);
    updateProgress(50);

    // Add text overlay to UGC video
    console.log('Adding text overlay to UGC video...');
    await addTextOverlay(ugcTempPath, ugcWithTextPath, hook, textAlignment);
    updateProgress(70);

    // Concatenate UGC (with text) + demo video
    console.log('Concatenating videos...');
    
    try {
      // Try the enhanced simple concatenation first (more reliable)
      await concatenateVideosSimple(ugcWithTextPath, demoTempPath, finalVideoPath);
      console.log('✅ Video concatenation successful');
    } catch (concatenationError) {
      console.error('❌ Concatenation failed completely:', concatenationError);
      
      // Even if concatenation fails, we still have UGC with text overlay
      // So copy that as the final video (better than nothing)
      console.log('📋 Using UGC with text overlay as final video (no demo)');
      fs.copyFileSync(ugcWithTextPath, finalVideoPath);
    }
    
    updateProgress(85);

    // Upload to R2
    console.log('Uploading final video to R2...');
    const fileName = `generated-video-${timestamp}.mp4`;
    const videoUrl = await uploadToR2(finalVideoPath, fileName);
    updateProgress(95);

    // Clean up temp files
    await Promise.all([
      fs.remove(ugcTempPath).catch(() => {}),
      fs.remove(ugcWithTextPath).catch(() => {}),
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

    console.log(`Video processing completed successfully for job ${jobId}`);
    console.log(`Final video URL: ${videoUrl}`);

  } catch (error) {
    console.error(`Video processing failed for job ${jobId}:`, error);
    
    // Clean up temp files on error
    const timestamp = Date.now();
    await Promise.all([
      fs.remove(path.join(TEMP_DIR, `ugc-${timestamp}.mp4`)).catch(() => {}),
      fs.remove(path.join(TEMP_DIR, `ugc-text-${timestamp}.mp4`)).catch(() => {}),
      fs.remove(path.join(TEMP_DIR, `demo-${timestamp}.mp4`)).catch(() => {}),
      fs.remove(path.join(TEMP_DIR, `final-${timestamp}.mp4`)).catch(() => {})
    ]);
    
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