import { AwsClient } from 'aws4fetch';
import { Env } from './../types';

interface UploadResponse {
	success: boolean;
	fileId?: string;
	filename?: string;
	description?: string;
	tags?: string;
	expiration?: string;
	checksum?: string;
	uploadType?: 'direct' | 'multipart';
	downloadUrl?: string;
	signedDownloadUrl?: string;
	hideFromList?: boolean;
	error?: string;
}

// Minimum part size for multipart uploads (5MB as per R2 requirements)
const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB
// Default part size for multipart uploads (10MB for better performance)
const DEFAULT_PART_SIZE = 10 * 1024 * 1024; // 10MB

export async function handleUpload(request: Request, env: Env): Promise<UploadResponse> {
	console.log('handleUpload called');

	try {
		// Check if request has form data
		const contentType = request.headers.get('content-type') || '';
		console.log('Content-Type:', contentType);

		if (!contentType.includes('multipart/form-data')) {
			console.log('Invalid content type');
			return { success: false, error: 'Invalid content type. Expected multipart/form-data' };
		}

		const formData = await request.formData();
		console.log('FormData parsed successfully');

		const file = formData.get('file');
		console.log('File from formData:', file ? 'Found' : 'Not found');

		if (!(file instanceof File)) {
			console.log('File is not a File instance:', typeof file);
			return { success: false, error: 'File is required and must be a valid file' };
		}

		console.log('File details:', {
			name: file.name,
			size: file.size,
			type: file.type,
			sizeMB: Math.round((file.size / 1024 / 1024) * 100) / 100,
		});

		// Enforce max file size from env
		const maxSize = parseInt(String(env.MAX_TOTAL_FILE_SIZE), 10);
		console.log('Max file size:', maxSize);

		if (!isNaN(maxSize) && maxSize > 0 && file.size > maxSize) {
			console.log('File too large:', file.size, 'vs', maxSize);
			return {
				success: false,
				error: `File exceeds maximum allowed size of ${Math.round(maxSize / 1024 / 1024)}MB`,
			};
		}

		const description = (formData.get('description') as string) || '';
		const tags = (formData.get('tags') as string) || '';
		const expiration = (formData.get('expiration') as string) || '';
		const checksum = (formData.get('checksum') as string) || '';
		const hideFromListValue = (formData.get('hideFromList') as string) || 'false';
		const hideFromList = hideFromListValue.toLowerCase() === 'true';

		console.log('Form fields:', { description, tags, expiration, checksum, hideFromList });

		// Validate expiration date if provided (UTC timezone)
		let expirationDate: Date | null = null;
		let expirationSeconds: number | null = null;

		if (expiration) {
			expirationDate = new Date(expiration);
			if (isNaN(expirationDate.getTime()) || expirationDate <= new Date()) {
				return { success: false, error: 'Expiration date must be in the future' };
			}

			// Calculate seconds until expiration for signed URL
			const now = new Date();
			expirationSeconds = Math.floor((expirationDate.getTime() - now.getTime()) / 1000);

			// Ensure minimum 60 seconds and maximum 7 days (604800 seconds)
			expirationSeconds = Math.max(60, Math.min(expirationSeconds, 604800));

			console.log(`Expiration set to ${expirationSeconds} seconds from now`);
		}

		const fileId = crypto.randomUUID();
		const objectKey = `${fileId}/${file.name}`;

		console.log('Generated fileId:', fileId);
		console.log('Object key:', objectKey);

		// Gather CF request metadata
		const cf = (request as any).cf || {};
		const userAgent = request.headers.get('User-Agent') || '';

		const customMetadata: Record<string, string> = {
			fileId,
			description,
			tags,
			expiration: expirationDate ? expirationDate.toISOString() : '',
			// ...(expirationDate ? { expiration: expirationDate.toISOString() } : {}),
			checksum,
			originalName: file.name,
			uploadedAt: new Date().toISOString(),
			hideFromList: hideFromList.toString(),
			asn: cf.asn?.toString() || '',
			country: cf.country || '',
			city: cf.city || '',
			timezone: cf.timezone || '',
			userAgent,
		};

		console.log('Custom metadata:', customMetadata);

		// Check if R2 bucket is available
		if (!env.R2_FILES) {
			console.error('R2_FILES bucket not available');
			return { success: false, error: 'Storage not configured' };
		}

		// Determine upload strategy based on file size
		const maxDirectUpload = parseInt(env.MAX_DIRECT_UPLOAD || '104857600', 10); // Default 100MB
		const useMultipart = file.size > maxDirectUpload;

		console.log(
			`Upload strategy: ${useMultipart ? 'multipart' : 'direct'} (file: ${file.size} bytes, threshold: ${maxDirectUpload} bytes)`
		);

		let uploadResult;

		if (useMultipart) {
			uploadResult = await performMultipartUpload(env.R2_FILES, objectKey, file, customMetadata);
		} else {
			uploadResult = await performDirectUpload(env.R2_FILES, objectKey, file, customMetadata);
		}

		if (!uploadResult.success) {
			return uploadResult;
		}

		// Generate signed download URL if expiration is set and credentials are available
		let signedDownloadUrl: string | undefined;
		let downloadUrl = `/api/download/${fileId}`;

		if (expirationSeconds && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME) {
			try {
				signedDownloadUrl = await generateSignedDownloadUrl(env, objectKey, expirationSeconds);
				console.log('Generated signed download URL with expiration');
				// Use signed URL as primary download method when expiration is set
				downloadUrl = signedDownloadUrl;
			} catch (signError) {
				console.error('Failed to generate signed download URL:', signError);
				console.log('Falling back to regular download URL');
			}
		} else if (expirationDate) {
			console.warn('Expiration date provided but R2 credentials not configured for signed URLs');
		}

		// Store metadata in KV if available
		if (env.FILE_METADATA) {
			const metadata = {
				fileId,
				filename: file.name,
				description,
				tags,
				expiration: expirationDate ? expirationDate.toISOString() : '',
				// ...(expirationDate ? { expiration: expirationDate.toISOString() } : {}),
				checksum,
				uploadedAt: new Date().toISOString(),
				size: file.size,
				contentType: file.type,
				uploadType: useMultipart ? 'multipart' : 'direct',
				downloadUrl,
				signedDownloadUrl,
				expirationSeconds,
				hideFromList,
			};

			try {
				await env.FILE_METADATA.put(fileId, JSON.stringify(metadata));
				console.log('Metadata stored in KV');
			} catch (kvError) {
				console.error('Failed to store metadata in KV:', kvError);
				// Don't fail the upload if KV fails
			}
		}

		console.log('Upload completed successfully');

		return {
			success: true,
			fileId,
			filename: file.name,
			description,
			tags,
			expiration: expirationDate ? expirationDate.toISOString() : undefined,
			checksum,
			uploadType: useMultipart ? 'multipart' : 'direct',
			downloadUrl,
			signedDownloadUrl,
			hideFromList,
		};
	} catch (err) {
		console.error('Upload error:', err);
		return {
			success: false,
			error: `Internal Server Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
		};
	}
}

async function generateSignedDownloadUrl(env: Env, objectKey: string, expiresInSeconds: number): Promise<string> {
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) {
		throw new Error('Missing required R2 credentials for signed URLs');
	}

	// Create AWS client for R2
	const aws = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		region: 'auto',
		service: 's3',
	});

	const r2Endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	const objectUrl = `${r2Endpoint}/${env.R2_BUCKET_NAME}/${objectKey}`;

	console.log(`Generating signed URL for: ${objectUrl} with ${expiresInSeconds}s expiration`);

	try {
		// Create request with X-Amz-Expires query parameter
		const requestUrl = `${objectUrl}?X-Amz-Expires=${expiresInSeconds}`;
		const signedRequest = await aws.sign(new Request(requestUrl), {
			aws: { signQuery: true },
		});

		const signedUrl = signedRequest.url.toString();
		console.log('Generated signed URL successfully');

		return signedUrl;
	} catch (error) {
		console.error('Error generating signed URL:', error);
		throw new Error(`Failed to generate signed download URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

async function performDirectUpload(
	bucket: R2Bucket,
	objectKey: string,
	file: File,
	customMetadata: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
	console.log('Starting direct R2 upload...');

	try {
		const putResult = await bucket.put(objectKey, file.stream(), {
			httpMetadata: {
				contentType: file.type || 'application/octet-stream',
				contentDisposition: `attachment; filename="${file.name}"`,
			},
			customMetadata,
		});

		console.log('Direct R2 upload result:', putResult ? 'Success' : 'Failed');

		if (!putResult) {
			console.error('Direct R2 upload failed - no result returned');
			return { success: false, error: 'Failed to upload file to storage' };
		}

		return { success: true };
	} catch (error) {
		console.error('Direct upload error:', error);
		return {
			success: false,
			error: `Direct upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}

async function performMultipartUpload(
	bucket: R2Bucket,
	objectKey: string,
	file: File,
	customMetadata: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
	console.log('Starting multipart R2 upload...');

	try {
		// Create multipart upload
		const multipartUpload = await bucket.createMultipartUpload(objectKey, {
			httpMetadata: {
				contentType: file.type || 'application/octet-stream',
				contentDisposition: `attachment; filename="${file.name}"`,
			},
			customMetadata,
		});

		console.log('Multipart upload created:', {
			key: multipartUpload.key,
			uploadId: multipartUpload.uploadId,
		});

		// Convert file to array buffer to work with parts
		const fileArrayBuffer = await file.arrayBuffer();
		const fileSize = fileArrayBuffer.byteLength;

		// Calculate part size and number of parts
		const partSize = DEFAULT_PART_SIZE;
		const totalParts = Math.ceil(fileSize / partSize);

		console.log(`Multipart upload plan: ${totalParts} parts of ${Math.round(partSize / 1024 / 1024)}MB each`);

		// Upload parts sequentially (Workers have execution time limits, so parallel might timeout)
		const uploadedParts: R2UploadedPart[] = [];

		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			const start = (partNumber - 1) * partSize;
			const end = Math.min(start + partSize, fileSize);
			const partData = fileArrayBuffer.slice(start, end);

			console.log(`Uploading part ${partNumber}/${totalParts} (${partData.byteLength} bytes)`);

			try {
				const uploadedPart = await multipartUpload.uploadPart(partNumber, partData);
				uploadedParts.push(uploadedPart);
				console.log(`Part ${partNumber} uploaded successfully, etag: ${uploadedPart.etag}`);
			} catch (partError) {
				console.error(`Failed to upload part ${partNumber}:`, partError);
				// Abort the multipart upload on any part failure
				try {
					await multipartUpload.abort();
					console.log('Multipart upload aborted due to part failure');
				} catch (abortError) {
					console.error('Failed to abort multipart upload:', abortError);
				}
				return {
					success: false,
					error: `Failed to upload part ${partNumber}: ${partError instanceof Error ? partError.message : 'Unknown error'}`,
				};
			}
		}

		// Complete the multipart upload
		console.log('Completing multipart upload...');
		const completedUpload = await multipartUpload.complete(uploadedParts);

		console.log('Multipart upload completed:', {
			etag: completedUpload.httpEtag,
			size: completedUpload.size,
		});

		return { success: true };
	} catch (error) {
		console.error('Multipart upload error:', error);
		return {
			success: false,
			error: `Multipart upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
		};
	}
}
