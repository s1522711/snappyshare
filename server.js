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

class StorageLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageLimitError';
  }
}

const storageMutex = new Mutex();

// In-memory storage state to avoid O(n) directory walks on every upload
const storageState = {
  totalSize: 0,
  allFiles: [],
  initialized: false
};

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

// Calculate storage stats ONCE at startup
async function initStorageStats() {
  if (storageState.initialized) return;
  
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

  if (fs.existsSync(UPLOADS_DIR)) {
    await walkDir(UPLOADS_DIR);
  }
  
  // Sort oldest first
  allFiles.sort((a, b) => a.mtime - b.mtime);
  
  storageState.totalSize = totalSize;
  storageState.allFiles = allFiles;
  storageState.initialized = true;
}

// Ensure space sequentially using mutex and running cache
async function ensureSpace(newFileSize) {
  return await storageMutex.runExclusive(async () => {
    if (!storageState.initialized) {
      await initStorageStats();
    }
    
    let i = 0;
    while (storageState.totalSize + newFileSize > STORAGE_LIMIT_BYTES && i < storageState.allFiles.length) {
      const fileToRemove = storageState.allFiles[i];
      try {
        await fs.promises.unlink(fileToRemove.path);
        storageState.totalSize -= fileToRemove.size;
        
        console.log(JSON.stringify({
          event: 'delete',
          filename: path.basename(fileToRemove.path),
          size: fileToRemove.size,
          timestamp: new Date().toISOString(),
          reason: 'storage_pressure'
        }));
        
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
    
    // Remove deleted files from array
    if (i > 0) {
      storageState.allFiles.splice(0, i);
    }
    
    if (storageState.totalSize + newFileSize > STORAGE_LIMIT_BYTES) {
      throw new StorageLimitError('Storage limit reached and cannot be freed');
    }
  });
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Prevent Content-Length spoofing by capping the estimated size
      const rawSize = parseInt(req.headers['content-length'] || '0', 10);
      const estimatedSize = Math.min(rawSize, STORAGE_LIMIT_BYTES);
      
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
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileId = req.fileId;
  const safeFilename = path.basename(req.file.originalname);
  
  // Track the actual file stored in the running cache
  const fullPath = path.join(UPLOADS_DIR, fileId, safeFilename);
  try {
    const stats = await fs.promises.stat(fullPath);
    await storageMutex.runExclusive(() => {
      storageState.totalSize += stats.size;
      storageState.allFiles.push({
        path: fullPath,
        dir: path.join(UPLOADS_DIR, fileId),
        size: stats.size,
        mtime: stats.mtimeMs
      });
    });
  } catch (err) {
    console.error("Error updating cache for new file", err);
  }

  // Audit Log
  console.log(JSON.stringify({
    event: 'upload',
    ip: req.ip,
    filename: safeFilename,
    fileId: fileId,
    size: req.file.size,
    timestamp: new Date().toISOString()
  }));
  
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
    // Generic error message to prevent info disclosure
    res.status(404).send('File not found.');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof StorageLimitError) {
    return res.status(507).json({ error: 'Storage limit reached. Cannot free enough space.' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Pre-initialize cache
initStorageStats().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize storage stats", err);
  process.exit(1);
});

module.exports = app; // export for testing
