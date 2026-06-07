const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Mutex } = require('async-mutex');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_LIMIT_BYTES = (parseFloat(process.env.STORAGE_LIMIT_GB) || 5) * 1024 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const storageMutex = new Mutex();

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Trust reverse proxies (e.g. Nginx) to properly set req.protocol and req.ip
app.set('trust proxy', 1);

// Security Headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Calculate storage stats
async function getStorageStats(dirPath) {
  let totalSize = 0;
  let allFiles = [];

  async function walkDir(currentPath) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else {
        const stats = await fs.promises.stat(fullPath);
        totalSize += stats.size;
        allFiles.push({
          path: fullPath,
          dir: currentPath,
          size: stats.size,
          mtime: stats.mtimeMs
        });
      }
    }
  }

  if (fs.existsSync(dirPath)) {
    await walkDir(dirPath);
  }
  return { totalSize, allFiles };
}

// Ensure space sequentially using mutex
async function ensureSpace(newFileSize) {
  return await storageMutex.runExclusive(async () => {
    let { totalSize, allFiles } = await getStorageStats(UPLOADS_DIR);
    
    // Sort oldest first
    allFiles.sort((a, b) => a.mtime - b.mtime);
    
    let i = 0;
    while (totalSize + newFileSize > STORAGE_LIMIT_BYTES && i < allFiles.length) {
      const fileToRemove = allFiles[i];
      try {
        await fs.promises.unlink(fileToRemove.path);
        totalSize -= fileToRemove.size;
        console.log(`Deleted old file to free space: ${fileToRemove.path}`);
        
        // Cleanup empty parent dir
        const parentFiles = await fs.promises.readdir(fileToRemove.dir);
        if (parentFiles.length === 0) {
          await fs.promises.rmdir(fileToRemove.dir);
        }
      } catch (e) {
        console.error(`Error deleting old file ${fileToRemove.path}:`, e);
      }
      i++;
    }
    
    if (totalSize + newFileSize > STORAGE_LIMIT_BYTES) {
      throw new Error('Storage limit reached and cannot be freed');
    }
  });
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Conservative estimate based on headers. Multer limits will enforce max bounds.
      const estimatedSize = parseInt(req.headers['content-length'] || '0', 10);
      await ensureSpace(estimatedSize);
      
      const fileId = uuidv4();
      const destPath = path.join(UPLOADS_DIR, fileId);
      fs.mkdirSync(destPath, { recursive: true });
      req.fileId = fileId;
      cb(null, destPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(file.originalname);
    cb(null, safeFilename);
  }
});

// Configure Multer with max file size limit to prevent abuse
const upload = multer({
  storage,
  limits: {
    fileSize: STORAGE_LIMIT_BYTES // Absolute maximum single file size bounds
  }
});

// Upload Endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileId = req.fileId;
  const safeFilename = path.basename(req.file.originalname);
  
  // Construct direct URL correctly using secure trust proxy logic
  const fileUrl = `${req.protocol}://${req.get('host')}/${fileId}/${encodeURIComponent(safeFilename)}`;
  res.json({ url: fileUrl, fileId, filename: safeFilename });
});

// Serve File Route
app.get('/:uuid/:filename', (req, res) => {
  const uuid = req.params.uuid;
  // Sanitize filename and strictly construct path inside UPLOADS_DIR
  const safeFilename = path.basename(req.params.filename);
  
  // Basic validation for uuid format to prevent unexpected behavior
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    return res.status(400).send('Invalid file ID format.');
  }

  const filePath = path.join(UPLOADS_DIR, uuid, safeFilename);
  
  // Double-check path traversal just in case
  if (!filePath.startsWith(UPLOADS_DIR)) {
    return res.status(403).send('Forbidden');
  }
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, safeFilename);
  } else {
    res.status(404).send('File not found or has been deleted to free space.');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.message && err.message.includes('Storage limit reached')) {
    return res.status(507).json({ error: 'Storage limit reached. Cannot free enough space.' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
