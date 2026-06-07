document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const progressContainer = document.getElementById('upload-progress-container');
    const fileNameDisplay = document.getElementById('file-name-display');
    const progressText = document.getElementById('progress-text');
    const progressBar = document.getElementById('progress-bar');
    const resultContainer = document.getElementById('result-container');
    const fileUrlInput = document.getElementById('file-url');
    const copyBtn = document.getElementById('copy-btn');
    const uploadAnotherBtn = document.getElementById('upload-another-btn');
    const errorMessage = document.getElementById('error-message');

    // Drag and Drop Events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });

    function highlight() {
        dropZone.classList.add('dragover');
    }

    function unhighlight() {
        dropZone.classList.remove('dragover');
    }

    dropZone.addEventListener('drop', handleDrop, false);

    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    }

    fileInput.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            uploadFile(files[0]);
        }
    }

    function resetUI() {
        dropZone.classList.remove('hidden');
        progressContainer.classList.add('hidden');
        resultContainer.classList.add('hidden');
        errorMessage.classList.add('hidden');
        fileInput.value = ''; // clear
    }

    uploadAnotherBtn.addEventListener('click', resetUI);

    copyBtn.addEventListener('click', () => {
        fileUrlInput.select();
        navigator.clipboard.writeText(fileUrlInput.value).catch(err => {
            console.error('Failed to copy: ', err);
        });
        
        // Visual feedback
        const originalHTML = copyBtn.innerHTML;
        copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2ecc71" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
            copyBtn.innerHTML = originalHTML;
        }, 2000);
    });

    function uploadFile(file) {
        // Update UI
        dropZone.classList.add('hidden');
        errorMessage.classList.add('hidden');
        progressContainer.classList.remove('hidden');
        fileNameDisplay.textContent = file.name;
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);

        // Upload progress
        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percentComplete + '%';
                progressText.textContent = percentComplete + '%';
            }
        };

        xhr.onload = function() {
            if (xhr.status === 200) {
                try {
                    const response = JSON.parse(xhr.responseText);
                    progressContainer.classList.add('hidden');
                    resultContainer.classList.remove('hidden');
                    fileUrlInput.value = response.url;
                    if (typeof fetchStats === 'function') fetchStats();
                } catch(e) {
                    showError('Invalid server response');
                }
            } else {
                let msg = 'An error occurred during upload.';
                try {
                    const response = JSON.parse(xhr.responseText);
                    if (response.error) msg = response.error;
                } catch(e) {}
                showError(msg);
            }
        };

        xhr.onerror = function() {
            showError('Network error occurred.');
        };

        xhr.send(formData);
    }

    function showError(msg) {
        progressContainer.classList.add('hidden');
        dropZone.classList.remove('hidden');
        errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
    }

    // Storage Stats Logic
    const storageStatsContainer = document.getElementById('storage-stats');
    const storageUsedEl = document.getElementById('storage-used');
    const storageLimitEl = document.getElementById('storage-limit');
    const storageBarFillEl = document.getElementById('storage-bar');

    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function fetchStats() {
        fetch('/api/stats')
            .then(res => res.json())
            .then(data => {
                const used = data.totalSize;
                const limit = data.limit;
                
                storageUsedEl.textContent = formatBytes(used);
                storageLimitEl.textContent = formatBytes(limit);
                
                let percent = (used / limit) * 100;
                if (percent > 100) percent = 100;
                
                storageBarFillEl.style.width = percent + '%';
                
                // Change color if approaching limit
                if (percent > 90) {
                    storageBarFillEl.style.background = 'linear-gradient(90deg, #f39c12, #e74c3c)';
                } else {
                    storageBarFillEl.style.background = 'linear-gradient(90deg, #3498db, #2ecc71)';
                }
                
                storageStatsContainer.classList.remove('hidden');
            })
            .catch(err => console.error('Failed to fetch storage stats', err));
    }

    // Fetch initial stats
    fetchStats();
});
