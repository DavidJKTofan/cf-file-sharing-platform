-- Migration: 2_create_files_table
-- Created: 2025-12-06T12:00:00Z

--
-- Table: files
--
CREATE TABLE files (
    id TEXT PRIMARY KEY NOT NULL,
    filename TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    size INTEGER NOT NULL,
    contentType TEXT NOT NULL,
    uploadedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expiration TEXT,
    checksum TEXT,
    uploadType TEXT NOT NULL CHECK(uploadType IN ('tus', 'direct')),
    hideFromList INTEGER NOT NULL DEFAULT 0, -- Boolean: 0 for false, 1 for true
    requiredRole TEXT,
    ownerId TEXT,
    r2Key TEXT NOT NULL
);

--
-- Indexes
--
CREATE INDEX idx_files_ownerId ON files (ownerId);
CREATE INDEX idx_files_uploadedAt ON files (uploadedAt);
CREATE INDEX idx_files_expiration ON files (expiration);
CREATE INDEX idx_files_requiredRole ON files (requiredRole);

