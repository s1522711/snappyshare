# SnappyShare

SnappyShare is a secure, visually stunning, and lightweight temporary file sharing web application. Upload your files instantly, and SnappyShare will generate a unique, direct download link for you. 

The application is designed to be self-hosted and features automatic storage management to ensure your server never runs out of space.

## Features

- **Sleek & Modern UI**: Built with a dark mode glassmorphism aesthetic, featuring dynamic background orbs and smooth micro-animations.
- **Drag-and-Drop Uploads**: Easily upload files by dragging them right onto the homepage.
- **Real-time Progress**: Visual upload progress tracking.
- **Auto-Cleanup Logic**: Files are automatically managed. If the server reaches the storage limit, the oldest files are automatically deleted to make room for new uploads.
- **Direct URLs**: Files are stored and served under secure, randomly generated UUID paths (e.g. `/{uuid}/{filename}`).

## Installation

1. **Clone the repository** (if applicable) or navigate to the project directory:
   ```bash
   cd snappyshare
   ```

2. **Install dependencies**:
   Ensure you have [Node.js](https://nodejs.org/) installed, then run:
   ```bash
   npm install
   ```

3. **Configuration**:
   The application uses a `.env` file for configuration. Create or edit the `.env` file in the root directory:
   ```env
   # The port the server will listen on (default: 3000)
   PORT=3247

   # Total maximum storage capacity in Gigabytes before old files are auto-deleted (default: 5)
   STORAGE_LIMIT_GB=5

   # Maximum allowed size for a single file upload in Gigabytes (default: 1)
   MAX_FILE_SIZE_GB=1

   # Set to "true" if running behind a reverse proxy (like Nginx) to correctly resolve client IP addresses
   TRUST_PROXY=true

   # The base URL used for generating download links (optional, falls back to the Host header if omitted)
   BASE_URL=https://yourdomain.com
   ```

## Usage

Start the server using Node:

```bash
npm start
# or
node server.js
```

Then, open your web browser and navigate to:
`http://localhost:3000`

## Technologies Used

- **Backend**: Node.js, Express, Multer (for multipart file uploads), UUID
- **Frontend**: Vanilla HTML5, CSS3, JavaScript (AJAX)

## Terms of Service
The application includes a Terms of Service enforcing that users must not upload copyrighted material without permission, malicious software, or contents commonly accepted to be illegal and/or immoral. By default, it is linked in the homepage footer.
