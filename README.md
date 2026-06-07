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
   The application uses a `.env` file for configuration. By default, it sets a storage limit of 5 GB. If you want to change it, create or edit the `.env` file in the root directory:
   ```env
   STORAGE_LIMIT_GB=5
   PORT=3000
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
