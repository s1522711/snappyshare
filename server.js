const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_LIMIT_BYTES = (parseFloat(process.env.STORAGE_LIMIT_GB) || 5) * 1024 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Function to calculate total directory size and get all files with their stats
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
          dir: currentPath, // To delete empty uuid dir later
          size: stats.size,
          mtime: stats.mtimeMs // use modification time to sort
        });
      }
    }
  }

  if (fs.existsSync(dirPath)) {
    await walkDir(dirPath);
  }
  return { totalSize, allFiles };
}

// Ensure space for a new file
async function ensureSpace(newFileSize) {
  let { totalSize, allFiles } = await getStorageStats(UPLOADS_DIR);
  
  // Sort files from oldest to newest based on modification time
  allFiles.sort((a, b) => a.mtime - b.mtime);
  
  let i = 0;
  // While adding the new file exceeds limit, delete the oldest
  while (totalSize + newFileSize > STORAGE_LIMIT_BYTES && i < allFiles.length) {
    const fileToRemove = allFiles[i];
    try {
      await fs.promises.unlink(fileToRemove.path);
      totalSize -= fileToRemove.size;
      console.log(`Deleted old file to free space: ${fileToRemove.path}`);
      
      // Attempt to delete parent dir if it's empty
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
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      // Content-Length provides an estimate of the payload size to ensure we have enough space
      const estimatedSize = parseInt(req.headers['content-length'] || '0', 10);
      await ensureSpace(estimatedSize);
      
      const fileId = uuidv4();
      const destPath = path.join(UPLOADS_DIR, fileId);
      fs.mkdirSync(destPath, { recursive: true });
      req.fileId = fileId; // save to req for later use
      cb(null, destPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // We want the exact original name
    // Replacing spaces with dashes or leaving them is fine. Let's keep original name.
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileId = req.fileId;
  const filename = req.file.originalname;
  // Construct the direct URL
  const fileUrl = `${req.protocol}://${req.get('host')}/${fileId}/${encodeURIComponent(filename)}`;
  
  res.json({ url: fileUrl, fileId, filename });
});

// Serve the uploaded files directly matching /:uuid/:filename
app.get('/:uuid/:filename', (req, res) => {
  const { uuid, filename } = req.params;
  const filePath = path.join(UPLOADS_DIR, uuid, filename);
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, filename);
  } else {
    res.status(404).send('File not found or has been deleted to free space.');
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.message.includes('Storage limit reached')) {
    return res.status(507).json({ error: 'Storage limit reached. Cannot free enough space.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
