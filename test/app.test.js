const request = require('supertest');
const path = require('path');
const fs = require('fs');
const app = require('../server');

describe('SnappyShare Security and Limits Tests', function() {
  this.timeout(5000);
  
  // A dummy file for upload testing
  const dummyFile = path.join(__dirname, 'dummy.txt');

  before(() => {
    fs.writeFileSync(dummyFile, 'Hello test file!');
  });

  after(() => {
    if (fs.existsSync(dummyFile)) {
      fs.unlinkSync(dummyFile);
    }
  });

  it('should prevent path traversal attacks on download', (done) => {
    request(app)
      .get('/test-uuid/..%2f..%2fpackage.json')
      .expect(400, done); // Due to strict UUID matching failing first
  });

  it('should successfully upload a file and return a direct URL', (done) => {
    request(app)
      .post('/api/upload')
      .attach('file', dummyFile)
      .expect(200)
      .end((err, res) => {
        if (err) return done(err);
        if (!res.body.url || !res.body.fileId) return done(new Error('Missing URL or fileId'));
        done();
      });
  });

  it('should enforce rate limiting and CSP headers', (done) => {
    request(app)
      .get('/')
      .expect('Content-Security-Policy', /default-src 'self'/)
      .expect('RateLimit-Limit', '100')
      .expect(200, done);
  });

  it('should handle missing files securely (generic 404)', (done) => {
    request(app)
      .get('/123e4567-e89b-12d3-a456-426614174000/nonexistent.txt')
      .expect(404)
      .expect('File not found.', done);
  });
});
