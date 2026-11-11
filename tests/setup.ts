// Environment must be set before any app module (config/env) is imported.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://placeholder/test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789abcdef';
process.env.MEDIA_SIGNING_SECRET = 'test-media-secret-0123456789abcdef0123456789abcdef';
process.env.STORAGE_DRIVER = 'local';
process.env.CLIENT_ORIGINS = 'http://localhost:5173';
process.env.PUBLIC_API_URL = 'http://localhost:4000';
