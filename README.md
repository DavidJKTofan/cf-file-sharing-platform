# CloudVault - File Sharing Platform

A serverless file sharing platform built on Cloudflare's edge infrastructure with resumable uploads, role-based access control, and automatic expiration.

## Features

- **TUS Resumable Uploads** - Upload large files with automatic resume on network failures
- **Role-Based Access Control** - Admin, SME, and User tiers with granular permissions
- **File Expiration** - Optional automatic cleanup of expired files
- **Smart Organization** - Tags and descriptions for easy discovery
- **Global CDN** - Files served from 300+ edge locations via R2
- **Zero Trust Security** - JWT-based authentication with Cloudflare Access
- **Real-time Dashboard** - Monitor storage usage and file statistics

## Architecture

- **Frontend**: Vanilla JavaScript, HTML5, Tailwind CSS
- **Backend**: Cloudflare Workers (TypeScript) with Hono framework
- **File Storage**: Cloudflare R2 Object Storage
- **Metadata**: Cloudflare D1 (SQLite)
- **Upload State**: Cloudflare Durable Objects (SQLite-backed)
- **Authentication**: Cloudflare Access

## Quick Start

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DavidJKTofan/cloudflare-file-sharing-platform)

### Prerequisites

- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) and npm
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Configuration

#### 1. Environment Variables (wrangler.jsonc)

```jsonc
{
	"vars": {
		"MAX_DIRECT_UPLOAD": "100000000", // 100MB - max size for non-TUS uploads
		"MAX_TOTAL_FILE_SIZE": "5000000000", // 5GB - max size for any upload
		"R2_BUCKET_NAME": "your-bucket-name",
		"ENVIRONMENT": "production",
		"APP_URL": "https://your-domain.com"
	}
}
```

#### 2. Required Secrets

**For Downloads ([Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)):**

```bash
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID
```

**Get R2 Credentials:**

1. Cloudflare Dashboard → R2 → Manage R2 API Tokens
2. Create token with "Object Read & Write" permissions
3. Account ID is in dashboard URL: `dash.cloudflare.com/<ACCOUNT_ID>/r2`

**Development (.dev.vars):**

```bash
R2_ACCESS_KEY_ID="your_access_key"
R2_SECRET_ACCESS_KEY="your_secret_key"
R2_ACCOUNT_ID="your_account_id"
DEV_USER_EMAIL="admin@example.com"
DEV_USER_ROLES="admin,sme,user"
```

#### 3. Database Setup

```bash
# Create D1 database
wrangler d1 create file-sharing-platform-db

# Run migrations
wrangler d1 migrations apply DB --env development
wrangler d1 migrations apply DB --env production
```

### Deploy

```bash
# Build CSS
npm run build:css

# Deploy to production
npm run deploy

# Or development
npm run dev
```

## Configuration Options

### Upload Limits

| Setting               | Default | Description                                  |
| --------------------- | ------- | -------------------------------------------- |
| `MAX_DIRECT_UPLOAD`   | 100MB   | Max file size for legacy multipart uploads   |
| `MAX_TOTAL_FILE_SIZE` | 5GB     | Max file size for any upload (TUS or direct) |

**Note**: Files over `MAX_DIRECT_UPLOAD` automatically use TUS resumable upload protocol.

### File Expiration

**Admin-Controlled:** Expiration is optional and set by the admin during upload:

- Set custom expiration date/time
- Quick presets: 1 hour, 1 day, 3 days, 1 week
- Leave unset for permanent files (no expiration)

**TUS Session Expiration:** Separate from file expiration

- Upload sessions expire after 7 days if not completed
- Prevents orphaned upload state in Durable Objects
- Does not affect the file's expiration date

### Download Methods

**Production (with R2 credentials):**

- Generates [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) (`302` redirect to R2)
- No egress charges
- 10-minute default expiration of the Presigned URL (configurable in `download.ts`)

**Development (or missing credentials):**

- Streams directly through Worker
- Useful for testing without credentials

### Role-Based Access

**Roles** (configured in D1 `user_roles` table):

- `admin` - Full access: upload, delete, view all files, manage users
- `sme` - Subject Matter Expert: upload files, view all files
- `user` - Basic access: view public files, download
- `public` / _None_ - Unauthenticated: view public files only

**File Access Control:**

- Admin can set `requiredRole` when uploading
- Files without `requiredRole` are public
- `hideFromList` makes files accessible only via direct link / _Direct File Access_

## Frontend Features

### Admin Dashboard (`/admin.html`)

- **File Upload** - TUS or legacy multipart
- **Upload Progress** - Real-time with pause/resume
- **Statistics** - Total files, storage used, avg/largest size
- **Recent Files** - Last 5 uploaded files
- **Cleanup** - Remove expired files

### File Manager (`/download.html`)

- **Browse Files** - Paginated table with sorting
- **Search** - Filter by filename, description, tags
- **Metadata Display:**
  - Upload date/time (desktop)
  - Expiration countdown (desktop)
  - Description (tablet+)
  - Tags (tablet+)
- **Direct Access** - Download by file ID
- **Responsive** - Mobile-friendly with adaptive columns

## API Reference

### Public Endpoints

#### GET `/api/list`

List publicly visible files (excludes hidden/expired)

**Query Parameters:**

- `search` - Search term
- `limit` - Max results (1-100, default: 50)
- `cursor` - Pagination cursor
- `sortBy` - Column name (default: uploadedAt)
- `sortOrder` - asc/desc (default: desc)

#### GET `/api/download/:fileId`

Download file by ID (redirects to presigned URL or streams)

### Admin Endpoints (Protected)

#### POST `/api/admin/upload`

Upload file with metadata (multipart/form-data)

**Form Fields:**

- `file` - File to upload
- `description` - Optional description (max 1000 chars)
- `tags` - Comma-separated tags (max 500 chars)
- `expiration` - ISO 8601 date string (optional)
- `hideFromList` - Boolean (default: false)
- `requiredRole` - Role required to access (admin only)

#### POST `/api/upload/tus`

Create TUS resumable upload session

**Headers:**

- `Upload-Length` - File size in bytes
- `Upload-Metadata` - Base64-encoded metadata pairs

#### PATCH `/api/upload/tus/:uploadId`

Upload file chunk

**Headers:**

- `Upload-Offset` - Current upload position
- `Content-Type` - application/offset+octet-stream

#### GET `/api/admin/list`

List all files with statistics

**Query Parameters:**

- Same as `/api/list`
- `includeExpired` - Include expired files (default: true)
- `includeHidden` - Include hidden files (default: true)

#### POST `/api/admin/cleanup`

Delete all expired files

## Security

### Protected Paths ([Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) Required!)

- `/admin` - Admin dashboard
- `/api/admin/*` - Admin APIs
- `/api/upload/tus` - TUS uploads
- `/api/debug/jwt` - JWT debugging

### Public Paths

- `/` - Landing page
- `/download.html` - File browser
- `/api/list` - Public file listing
- `/api/download/*` - File downloads (role-checked)

### Recommendations

1. **Enable Cloudflare Access** for `/admin` and `/api/admin/*`
2. **Configure rate limiting** for `/api/download/*`
3. **Enable [malicious upload detection](https://developers.cloudflare.com/waf/detections/malicious-uploads/)** in WAF, if possible
4. **Create WAF [exceptions](https://developers.cloudflare.com/waf/managed-rules/waf-exceptions/)**, if needed
5. **Rotate R2 API tokens** periodically

## Monitoring

### Key Metrics

```bash
# View real-time logs
wrangler tail --env production

# Check recent uploads
wrangler d1 execute DB --env production \
  --command "SELECT id, filename, uploadedAt FROM files ORDER BY uploadedAt DESC LIMIT 10"

# Storage statistics
wrangler d1 execute DB --env production \
  --command "SELECT COUNT(*) as count, SUM(size) as total_bytes FROM files"

# Find orphaned files
wrangler d1 execute DB --env production \
  --command "SELECT id, filename FROM files WHERE ownerId IS NULL"
```

### Log Prefixes

- `[TUS]` - TUS upload operations
- `[DO]` - Durable Object state management
- `[UPLOAD]` - Direct upload operations
- `[DOWNLOAD]` - Download operations
- `[LIST]` - File listing queries
- `[STATS]` - Statistics calculation

## Troubleshooting

### Downloads Return 500 Error

**Symptom:** "Download service temporarily unavailable"

**Solution:**

1. Configure R2 secrets: `wrangler secret put R2_ACCESS_KEY_ID`
2. Verify in logs: `wrangler tail | grep "R2 credentials"`

### Empty Checksums in Database

**Cause:** Only affects files uploaded before checksum fix

**Solution:** Upload new files (existing files will keep `{}`)

### Files Not Appearing After Upload

**Check:**

1. D1 write verification in logs
2. Frontend stats cache (30s expiration)
3. Browser console for errors

### TypeScript Errors

```bash
# Run type checker
npm run typecheck

# Common fixes
npm install
npm run build:css
```

## Project Structure

```
├── public/                    # Static assets
│   ├── admin.html            # Admin dashboard HTML
│   ├── download.html         # File download page HTML
│   ├── favicon.ico           # Favicon
│   ├── favicon.png           # Favicon PNG
│   ├── index.html            # Landing page HTML
│   ├── logo.png              # Project logo
│   ├── tailwind.css          # Compiled Tailwind CSS
│   ├── images/               # Frontend images
│   │   ├── admin-dashboard.png
│   │   ├── file-manager-public.png
│   │   └── file-manager.png
│   └── js/                   # Frontend JavaScript
│       ├── admin.js          # Admin dashboard logic
│       └── download.js       # File browser logic
├── src/                      # Cloudflare Worker source
│   ├── index.ts              # Worker entry point & routes
│   ├── types.ts              # TypeScript type definitions
│   ├── config.ts             # Configuration with Zod validation
│   ├── auth.ts               # Authentication middleware
│   ├── logger.ts             # Structured logging
│   ├── api/                  # API handlers
│   │   ├── download.ts       # File download logic
│   │   ├── list.ts           # File listing logic
│   │   ├── upload-tus.ts     # TUS resumable uploads
│   │   └── upload.ts         # Direct multipart uploads
│   └── durable/              # Durable Object classes
│       └── TusUploadHandler.ts  # TUS state (SQLite)
├── migrations/               # D1 database migrations
│   ├── 0001_create_user_roles.sql
│   └── 0002_create_files_table.sql
├── .editorconfig             # Editor configuration
├── .gitignore                # Git ignore rules
├── .prettierrc               # Prettier configuration
├── input.css                 # Tailwind CSS input
├── LICENSE                   # Project license
├── package.json              # Dependencies and scripts
├── README.md                 # Project documentation
├── tailwind.config.js        # Tailwind CSS config
├── tsconfig.json             # TypeScript configuration
├── worker-configuration.d.ts # Worker type definitions
└── wrangler.jsonc            # Cloudflare Wrangler config
```

## License

MIT License - see LICENSE file

## Disclaimer

**For educational purposes only.** Not intended for production use without proper security review. Always implement appropriate security measures, rate limiting, and access controls before deploying to production.
