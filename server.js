const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Mutex, withTimeout } = require('async-mutex');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Config Validation (L-06, L-07)
const storageLimitGb = Math.max(0.1, parseFloat(process.env.STORAGE_LIMIT_GB) || 5);
const STORAGE_LIMIT_BYTES = storageLimitGb * 1024 * 1024 * 1024;

const maxFileSizeGb = Math.max(0.001, parseFloat(process.env.MAX_FILE_SIZE_GB) || 1);
const MAX_FILE_SIZE_BYTES = maxFileSizeGb * 1024 * 1024 * 1024;

const UPLOADS_DIR = path.join(__dirname, 'uploads');

class StorageLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageLimitError';
  }
}

// Mutex Timeout (M-01)
const storageMutex = withTimeout(new Mutex(), 10000, new Error('Mutex timeout'));

const storageState = {
  totalSize: 0,
  allFiles: [],
  initialized: false
};

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Trust proxy Opt-in (M-04)
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

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

// Split Rate Limiting (M-05)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});

// Dotfile Ignore (I-04)
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'ignore' }));

// Initialize Stats
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
  
  allFiles.sort((a, b) => a.mtime - b.mtime);
  storageState.totalSize = totalSize;
  storageState.allFiles = allFiles;
  storageState.initialized = true;
}

// Atomic Space Reservation (H-01)
async function reserveSpace(newFileSize) {
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
        
        const parentFiles = await fs.promises.readdir(fileToRemove.dir);
        if (parentFiles.length === 0) {
          await fs.promises.rmdir(fileToRemove.dir);
        }
      } catch (e) {
        console.error(`Error deleting old file ${fileToRemove.path}:`, e);
      }
      i++;
    }
    
    if (i > 0) {
      storageState.allFiles.splice(0, i);
    }
    
    if (storageState.totalSize + newFileSize > STORAGE_LIMIT_BYTES) {
      throw new StorageLimitError('Storage limit reached and cannot be freed');
    }
    
    // Reserve space atomically before write
    storageState.totalSize += newFileSize;
  });
}

function sanitizeFilename(originalName) {
  let safe = originalName || '';
  if (!safe) throw new Error('Filename is empty');
  if (safe.includes('\0')) throw new Error('Invalid filename (contains null byte)');
  
  // Normalize backslashes (L-03)
  safe = safe.replace(/\\/g, '/');
  
  // Normalize unicode to NFC, get basename, slice to 255 chars (L-01, L-05)
  safe = path.basename(safe).normalize('NFC').slice(0, 255);
  
  if (!safe) throw new Error('Filename is empty after sanitization');
  return safe;
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const rawLength = parseInt(req.headers['content-length'] || '0', 10);
      
      // Fix NaN/Negative bypass (C-01, C-02)
      if (!Number.isFinite(rawLength) || rawLength < 0) {
        return cb(new Error('Invalid Content-Length'));
      }
      
      const estimatedSize = Math.min(rawLength, STORAGE_LIMIT_BYTES);
      
      // Atomic reservation (H-01)
      await reserveSpace(estimatedSize);
      req.estimatedSize = estimatedSize; // Save for reconciliation
      
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
    try {
      const safeFilename = sanitizeFilename(file.originalname);
      cb(null, safeFilename);
    } catch (err) {
      cb(err);
    }
  }
});

// Multer Limits (M-07, L-07)
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    fieldSize: 1024,      // 1KB max per non-file field
    fields: 5,            // max 5 non-file fields
    parts: 10,            // max 10 parts total
  }
});

app.post('/api/upload', uploadLimiter, upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    // Rollback reservation if no file was uploaded but reservation was somehow made
    if (req.estimatedSize) {
      await storageMutex.runExclusive(() => { storageState.totalSize -= req.estimatedSize; });
    }
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileId = req.fileId;
  const safeFilename = sanitizeFilename(req.file.originalname);
  const fullPath = path.join(UPLOADS_DIR, fileId, safeFilename);
  
  try {
    const stats = await fs.promises.stat(fullPath);
    
    // Reconcile atomic space reservation
    const difference = stats.size - req.estimatedSize;
    
    await storageMutex.runExclusive(() => {
      storageState.totalSize += difference; // Correct the initial estimation
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

  console.log(JSON.stringify({
    event: 'upload',
    ip: req.ip,
    filename: safeFilename,
    fileId: fileId,
    size: req.file.size,
    timestamp: new Date().toISOString()
  }));
  
  // Host Header Phishing prevention (H-03)
  const BASE_URL = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const fileUrl = `${BASE_URL}/${fileId}/${encodeURIComponent(safeFilename)}`;
  
  res.json({ url: fileUrl, fileId, filename: safeFilename });
});

app.get('/:uuid/:filename', downloadLimiter, (req, res) => {
  const uuid = req.params.uuid;
  
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    return res.status(400).send('Invalid request.');
  }

  try {
    const safeFilename = sanitizeFilename(req.params.filename);
    const filePath = path.join(UPLOADS_DIR, uuid, safeFilename);
    
    if (!filePath.startsWith(UPLOADS_DIR)) {
      return res.status(403).send('Forbidden');
    }
    
    if (fs.existsSync(filePath)) {
      res.download(filePath, safeFilename);
    } else {
      res.status(404).send('File not found.');
    }
  } catch (err) {
    return res.status(400).send('Invalid request.');
  }
});

// Error handling middleware
app.use(async (err, req, res, next) => {
  // Empty Directory Cleanup (M-02) and Mutex Reservation Rollback
  if (req.estimatedSize) {
    try {
      await storageMutex.runExclusive(() => {
        storageState.totalSize -= req.estimatedSize;
      });
      if (req.fileId) {
        const dirPath = path.join(UPLOADS_DIR, req.fileId);
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error('Error during cleanup rollback:', e);
    }
  }

  if (err instanceof StorageLimitError) {
    return res.status(507).json({ error: 'Storage limit reached. Cannot free enough space.' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large.' });
  }
  if (err.message === 'Invalid Content-Length' || err.message.includes('Invalid filename')) {
    return res.status(400).json({ error: err.message });
  }
  
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initStorageStats().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize storage stats", err);
  process.exit(1);
});

module.exports = app;
