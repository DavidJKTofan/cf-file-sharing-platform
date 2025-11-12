document.addEventListener('DOMContentLoaded', () => {
	/* ========= GLOBAL STATE ========= */
	let currentUser = null;
	let currentUpload = null;
	let uploadStartTime = 0;
	let lastUploadedBytes = 0;
	let lastProgressTime = 0;

	const STATS_CACHE_DURATION = 30000;
	let statsCache = null;
	let statsCacheTime = 0;

	/* ========= DOM REFS ========= */
	const userEmailEl = document.getElementById('userEmail');
	const userRolesEl = document.getElementById('userRoles');
	const statusMessage = document.getElementById('statusMessage');

	const progressBar = document.getElementById('progressBar');
	const progressPercent = document.getElementById('progressPercent');
	const uploadedSize = document.getElementById('uploadedSize');
	const totalSize = document.getElementById('totalSize');
	const uploadSpeed = document.getElementById('uploadSpeed');
	const eta = document.getElementById('eta');

	const pauseBtn = document.getElementById('pauseBtn');
	const resumeBtn = document.getElementById('resumeBtn');
	const cancelBtn = document.getElementById('cancelBtn');

	const fileInput = document.getElementById('fileInput');
	const fileNameEl = document.getElementById('fileName');
	const dropZone = document.getElementById('dropZone');

	const enableExpiration = document.getElementById('enableExpiration');
	const expirationSettings = document.getElementById('expirationSettings');
	const expirationInput = document.getElementById('expiration');
	const expirationPreview = document.getElementById('expirationPreview');
	const expirationText = document.getElementById('expirationText');
	const presetButtons = document.querySelectorAll('.preset-btn');

	const hideFromListCheckbox = document.getElementById('hideFromList');
	const recentFilesEl = document.getElementById('recentFiles');

	/* ========= SMALL HELPERS ========= */
	function setText(id, text) {
		const el = document.getElementById(id);
		if (el) el.textContent = text;
	}
	function showStatus(msg, isError = false) {
		if (!statusMessage) return;
		statusMessage.textContent = msg;
		statusMessage.className = `mb-4 p-3 rounded-lg ${
			isError ? 'bg-red-100 text-red-700 border border-red-300' : 'bg-green-100 text-green-700 border border-green-300'
		}`;
		statusMessage.classList.remove('hidden');
		setTimeout(() => statusMessage.classList.add('hidden'), 6000);
	}
	function hideStatus() {
		if (statusMessage) statusMessage.classList.add('hidden');
	}
	function formatFileSize(bytes) {
		if (bytes === 0) return '0 B';
		if (bytes === undefined || bytes === null) return '—';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}
	function formatDate(s) {
		if (!s) return '—';
		try {
			return new Date(s).toLocaleString();
		} catch {
			return s;
		}
	}
	function secondsToHMS(s) {
		if (!isFinite(s)) return '--';
		s = Math.round(s);
		const h = Math.floor(s / 3600),
			m = Math.floor((s % 3600) / 60),
			sec = s % 60;
		return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
	}
	const formatTime = secondsToHMS;
	function escapeHtml(s = '') {
		return String(s).replace(
			/[&<>"'\/]/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;' })[c],
		);
	}

	/* ========= RBAC UI ========= */
	function applyRoleVisibility() {
		const roles = currentUser?.roles || [];
		document.querySelectorAll('[data-required-roles]').forEach((el) => {
			const required = (el.getAttribute('data-required-roles') || '')
				.split(',')
				.map((r) => r.trim())
				.filter(Boolean);
			const allowed = required.length === 0 ? true : required.some((r) => roles.includes(r));
			if (allowed) {
				el.classList.remove('hidden');
				el.style.display = '';
			} else {
				el.classList.add('hidden');
				el.style.display = 'none';
			}
		});
		if (roles.includes('admin')) document.getElementById('roleAccessControls')?.classList.remove('hidden');
	}

	/* ========= USER INFO ========= */
	async function loadUserInfo() {
		try {
			const res = await fetch('/api/debug/jwt');
			if (!res.ok) {
				// try to parse JSON error message if any
				let emsg = 'Failed to load user info';
				try {
					const j = await res.json();
					if (j && j.error) emsg = j.error;
				} catch {}
				throw new Error(emsg);
			}
			const json = await res.json();
			currentUser = json.extractedUser || { email: 'unknown', roles: [] };
			if (userEmailEl) userEmailEl.textContent = currentUser.email || 'unknown';
			if (userRolesEl) userRolesEl.textContent = currentUser.roles && currentUser.roles.length ? currentUser.roles.join(', ') : 'no roles';
			applyRoleVisibility();
		} catch (err) {
			console.error('loadUserInfo', err);
			if (userEmailEl) userEmailEl.textContent = 'error';
			if (userRolesEl) userRolesEl.textContent = 'error';
		}
	}

	/* ========= ANALYTICS ========= */
	async function loadAnalytics() {
		try {
			const now = Date.now();
			if (statsCache && now - statsCacheTime < STATS_CACHE_DURATION) {
				updateAnalyticsUI(statsCache);
				return;
			}
			const isAdmin = (currentUser?.roles || []).includes('admin');
			const endpoint = isAdmin ? '/api/admin/list?includeExpired=true&includeHidden=true' : '/api/list';
			const res = await fetch(endpoint);
			const json = await res.json();
			if (!res.ok && !json.success) throw new Error(json.error || 'failed');
			let stats = json.stats || {};
			if (!json.stats && Array.isArray(json.files)) {
				const files = json.files;
				const totalFiles = files.length;
				const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
				const expiredFiles = files.filter((f) => f.expiration && new Date(f.expiration) <= new Date()).length;
				const hiddenFiles = files.filter((f) => f.hideFromList).length;
				const publicFiles = totalFiles - hiddenFiles;
				const averageSize = totalFiles ? Math.round(totalSize / totalFiles) : 0;
				const largestFileSize = files.reduce((m, f) => Math.max(m, f.size || 0), 0);
				stats = { totalFiles, totalSize, averageSize, largestFileSize, expiredFiles, hiddenFiles, publicFiles };
			}
			statsCache = stats;
			statsCacheTime = now;
			updateAnalyticsUI(stats);
		} catch (err) {
			console.error('loadAnalytics', err);
			showStatus('Failed to load analytics', true);
		}
	}
	function updateAnalyticsUI(stats) {
		setText('totalFilesCount', (stats.totalFiles || 0).toLocaleString());
		setText('totalStorageSize', formatFileSize(stats.totalSize || 0));
		setText('averageFileSize', formatFileSize(stats.averageSize || 0));
		setText('expiredFilesCount', (stats.expiredFiles || 0).toLocaleString());
		setText('hiddenFilesCount', (stats.hiddenFiles || 0).toLocaleString());
		setText('publicFilesCount', (stats.publicFiles || 0).toLocaleString());
		setText('largestFileSize', formatFileSize(stats.largestFileSize || 0));
		const active = (stats.totalFiles || 0) - (stats.expiredFiles || 0);
		setText('activeFilesCount', (active >= 0 ? active : 0).toLocaleString());
		const maxStorage = 10 * 1024 * 1024 * 1024;
		const usagePct = maxStorage ? ((stats.totalSize || 0) / maxStorage) * 100 : 0;
		const bar = document.getElementById('storageProgressBar');
		if (bar) {
			bar.style.width = Math.min(usagePct, 100) + '%';
			if (usagePct > 90) bar.className = 'bg-red-600 h-2 rounded-full transition-all';
			else if (usagePct > 75) bar.className = 'bg-yellow-600 h-2 rounded-full transition-all';
			else bar.className = 'bg-green-600 h-2 rounded-full transition-all';
		}
		setText('storageLimit', formatFileSize(maxStorage) + ' limit');
	}

	/* ========= RECENT FILES ========= */
	async function loadRecentFiles() {
		try {
			if (recentFilesEl) recentFilesEl.innerHTML = '<div class="text-center py-4 text-gray-500">Loading recent files...</div>';
			const isAdmin = (currentUser?.roles || []).includes('admin');
			const endpoint = isAdmin ? '/api/admin/list?includeHidden=true&limit=5' : '/api/list?limit=5';
			const res = await fetch(endpoint);
			const json = await res.json();
			if (!res.ok && !json.success) throw new Error(json.error || 'failed');
			const files = json.files || [];
			if (!files.length) {
				if (recentFilesEl) recentFilesEl.innerHTML = '<div class="text-center py-8 text-gray-500">No files uploaded yet</div>';
				return;
			}
			const html = files
				.map((f) => {
					const isExpired = f.expiration && new Date(f.expiration) <= new Date();
					const badge = isExpired
						? '<span class="px-2 py-1 text-xs bg-red-100 text-red-700 rounded-full">Expired</span>'
						: f.hideFromList
							? '<span class="px-2 py-1 text-xs bg-orange-100 text-orange-700 rounded-full">Hidden</span>'
							: '<span class="px-2 py-1 text-xs bg-green-100 text-green-700 rounded-full">Active</span>';
					return `<div class="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
			        <div class="flex-1 min-w-0">
			          <div class="flex items-center gap-2 mb-1">
			            <p class="text-sm font-medium text-gray-900 truncate">${escapeHtml(f.filename)}</p>${badge}
			          </div>
			          <div class="flex items-center gap-4 text-xs text-gray-500"><span>${formatFileSize(f.size)}</span><span>${formatDate(
									f.uploadedAt,
								)}</span></div>
			        </div>
			        <div class="flex gap-2">${
								!isExpired ? `<a href="${f.downloadUrl}" class="text-blue-600 hover:text-blue-700 text-xs">Download</a>` : ''
							}<button data-action="copy-id" data-file-id="${escapeHtml(
								f.fileId,
							)}" class="text-gray-500 hover:text-gray-700 text-xs">Copy ID</button></div>
			      </div>`;
				})
				.join('');
			if (recentFilesEl) recentFilesEl.innerHTML = html;
		} catch (err) {
			console.error('loadRecentFiles', err);
			if (recentFilesEl) recentFilesEl.innerHTML = '<div class="text-center py-8 text-red-500">Failed to load recent files</div>';
		}
	}

	/* ========= EXPIRATION HELPERS ========= */
	function setMinDateTime() {
		const now = new Date();
		now.setMinutes(now.getMinutes() + 1);
		if (expirationInput) expirationInput.min = now.toISOString().slice(0, 16);
	}
	function updateExpirationPreview() {
		if (!enableExpiration.checked || !expirationInput.value) {
			if (expirationPreview) expirationPreview.classList.add('hidden');
			return;
		}
		try {
			const d = new Date(expirationInput.value);
			if (d <= new Date()) {
				if (expirationText) expirationText.textContent = 'Invalid: Expiration must be in the future';
				if (expirationPreview) expirationPreview.classList.remove('hidden');
				return;
			}
			const diffMs = d.getTime() - Date.now();
			const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
			const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
			const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
			let timeLeft = '';
			if (diffDays > 0) {
				timeLeft = `${diffDays} day${diffDays > 1 ? 's' : ''}`;
				if (diffHours > 0) timeLeft += `, ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
			} else if (diffHours > 0) {
				timeLeft = `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
				if (diffMinutes > 0) timeLeft += `, ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
			} else timeLeft = `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
			if (expirationText)
				expirationText.innerHTML = `<div>File will expire on: <strong>${d.toLocaleString()}</strong></div><div>Time until expiration: <strong>${timeLeft}</strong></div>`;
			if (expirationPreview) expirationPreview.classList.remove('hidden');
		} catch (err) {
			if (expirationText) expirationText.textContent = 'Invalid date format';
			if (expirationPreview) expirationPreview.classList.remove('hidden');
		}
	}

	/* ========= CHECKSUM ========= */
	async function computeChecksum(file) {
		try {
			const arrayBuffer = await file.arrayBuffer();
			const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		} catch (err) {
			console.error('Error computing checksum', err);
			return '';
		}
	}

	/* ========= TUS UPLOAD ========= */
	function showUploadProgress() {
		const up = document.getElementById('uploadProgress');
		if (up) up.classList.remove('hidden');
	}
	function hideUploadProgress() {
		const up = document.getElementById('uploadProgress');
		if (up) up.classList.add('hidden');
		if (progressBar) progressBar.style.width = '0%';
		if (progressPercent) progressPercent.textContent = '0%';
		if (uploadedSize) uploadedSize.textContent = '0 B';
		if (totalSize) totalSize.textContent = '0 B';
		if (uploadSpeed) uploadSpeed.textContent = '0 B/s';
		if (eta) eta.textContent = '--';
	}

	async function startTusUpload(file) {
		showUploadProgress();
		setLoading(true);
		uploadStartTime = Date.now();
		lastUploadedBytes = 0;
		lastProgressTime = Date.now();
		hideStatus();

		try {
			// compute checksum
			showStatus('Computing file checksum...');
			const checksum = await computeChecksum(file);
			hideStatus();

			// Build metadata object (strings)
			const metadata = {
				filename: file.name,
				contentType: file.type || 'application/octet-stream',
				description: (document.getElementById('description')?.value || '').trim(),
				tags: (document.getElementById('tags')?.value || '').trim(),
				hideFromList: hideFromListCheckbox.checked ? 'true' : 'false',
				checksum: checksum || '',
			};

			// Admin-only requiredRole
			const userRoles = currentUser?.roles || [];
			if (userRoles.includes('admin')) {
				const requiredRole = document.getElementById('requiredRole')?.value;
				if (requiredRole) metadata.requiredRole = requiredRole;
			}

			// Expiration if enabled
			if (enableExpiration.checked && expirationInput.value) {
				const expirationDate = new Date(expirationInput.value);
				metadata.expiration = expirationDate.toISOString();
			}

			// strip empty values and pass raw strings (tus-js-client will encode them)
			const tusMetadata = {};
			for (const [k, v] of Object.entries(metadata)) {
				if (v === undefined || v === null || String(v).trim() === '') continue;
				tusMetadata[k] = String(v);
			}

			const options = {
				endpoint: '/api/upload/tus',
				metadata: tusMetadata,
				retryDelays: [0, 3000, 5000, 10000, 20000],
				chunkSize: 10 * 1024 * 1024,
				storeFingerprintForResuming: true,
				removeFingerprintOnSuccess: true,
				onError: (error) => {
					console.error('TUS upload error:', error);
					showStatus(`Upload failed: ${error && error.message ? error.message : String(error)}`, true);
					hideUploadProgress();
					setLoading(false);
					currentUpload = null;
					if (pauseBtn) pauseBtn.classList.add('hidden');
					if (resumeBtn) resumeBtn.classList.add('hidden');
					if (cancelBtn) cancelBtn.classList.add('hidden');
				},
				onProgress: (bytesUploaded, bytesTotal) => {
					const percent = (bytesUploaded / bytesTotal) * 100;
					if (progressBar) progressBar.style.width = percent + '%';
					if (progressPercent) progressPercent.textContent = Math.round(percent) + '%';
					if (uploadedSize) uploadedSize.textContent = formatFileSize(bytesUploaded);
					if (totalSize) totalSize.textContent = formatFileSize(bytesTotal);

					const now = Date.now();
					const timeDiff = (now - lastProgressTime) / 1000;
					const bytesDiff = bytesUploaded - lastUploadedBytes;

					if (timeDiff > 0.5) {
						const speed = bytesDiff / Math.max(timeDiff, 0.001);
						if (uploadSpeed) uploadSpeed.textContent = formatFileSize(speed) + '/s';
						const remainingBytes = bytesTotal - bytesUploaded;
						const etaSeconds = speed > 0 ? remainingBytes / speed : 0;
						if (eta) eta.textContent = formatTime(etaSeconds);
						lastUploadedBytes = bytesUploaded;
						lastProgressTime = now;
					}
				},
				onSuccess: async () => {
					showStatus('File uploaded successfully!');
					hideUploadProgress();
					setLoading(false);
					document.getElementById('uploadForm')?.reset();
					if (fileNameEl) fileNameEl.textContent = '';
					currentUpload = null;
					await loadAnalytics();
					await loadRecentFiles();
					if (pauseBtn) pauseBtn.classList.add('hidden');
					if (resumeBtn) resumeBtn.classList.add('hidden');
					if (cancelBtn) cancelBtn.classList.add('hidden');
				},
			};

			// create upload
			currentUpload = new tus.Upload(file, options);
			currentUpload.start();

			// show pause/cancel button
			if (pauseBtn) pauseBtn.classList.remove('hidden');
			if (cancelBtn) cancelBtn.classList.remove('hidden');
			if (resumeBtn) resumeBtn.classList.add('hidden');
		} catch (err) {
			console.error('Error preparing TUS upload (checksum or metadata):', err);
			showStatus('Failed to start TUS upload: ' + (err && err.message ? err.message : String(err)), true);
			setLoading(false);
			hideUploadProgress();
		}
	}

	/* ========= LEGACY UPLOAD ========= */
	async function startLegacyUpload(file) {
		setLoading(true);
		hideStatus();
		try {
			showStatus('Computing file checksum...');
			const checksum = await computeChecksum(file);
			hideStatus();
			const form = new FormData();
			form.append('file', file);
			form.append('description', (document.getElementById('description')?.value || '').trim());
			form.append('tags', (document.getElementById('tags')?.value || '').trim());
			form.append('hideFromList', hideFromListCheckbox.checked ? 'true' : 'false');
			form.append('checksum', checksum);
			const roles = currentUser?.roles || [];
			if (roles.includes('admin')) {
				const rr = document.getElementById('requiredRole')?.value;
				if (rr) form.append('requiredRole', rr);
			}
			if (enableExpiration.checked && expirationInput.value) form.append('expiration', new Date(expirationInput.value).toISOString());
			const req = await fetch('/api/admin/upload', { method: 'POST', body: form });
			const json = await req.json();
			if (!req.ok || !json.success) throw new Error(json.error || 'upload failed');
			showStatus(`Uploaded (id: ${json.fileId})`);
			document.getElementById('uploadForm')?.reset();
			if (fileNameEl) fileNameEl.textContent = '';
			await loadAnalytics();
			await loadRecentFiles();
		} catch (err) {
			console.error('legacy upload', err);
			showStatus('Upload failed: ' + (err.message || err), true);
		} finally {
			setLoading(false);
		}
	}

	/* ========= UI wiring ========= */
	function copyFileId(id) {
		navigator.clipboard
			.writeText(id)
			.then(() => showStatus('File ID copied'))
			.catch(() => showStatus('Copy failed', true));
	}

	dropZone?.addEventListener('click', () => fileInput?.click());
	dropZone?.addEventListener('dragover', (e) => {
		e.preventDefault();
		dropZone.classList.add('bg-blue-50', 'border-blue-400');
	});
	dropZone?.addEventListener('dragleave', (e) => {
		e.preventDefault();
		dropZone.classList.remove('bg-blue-50', 'border-blue-400');
	});
	dropZone?.addEventListener('drop', (e) => {
		e.preventDefault();
		dropZone.classList.remove('bg-blue-50', 'border-blue-400');
		if (e.dataTransfer.files.length) {
			fileInput.files = e.dataTransfer.files;
			const f = fileInput.files[0];
			if (fileNameEl) fileNameEl.textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
			hideStatus();
		}
	});
	fileInput?.addEventListener('change', () => {
		if (fileInput.files && fileInput.files.length) {
			const f = fileInput.files[0];
			if (fileNameEl) fileNameEl.textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
			hideStatus();
		}
	});

	presetButtons.forEach((btn) =>
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			const hours = Number(btn.getAttribute('data-hours') || 0);
			const d = new Date();
			d.setHours(d.getHours() + hours);
			const year = d.getFullYear(),
				month = String(d.getMonth() + 1).padStart(2, '0'),
				day = String(d.getDate()).padStart(2, '0'),
				hh = String(d.getHours()).padStart(2, '0'),
				mm = String(d.getMinutes()).padStart(2, '0');
			if (expirationInput) expirationInput.value = `${year}-${month}-${day}T${hh}:${mm}`;
			updateExpirationPreview();
			presetButtons.forEach((b) => b.classList.remove('bg-blue-100', 'border-blue-400', 'text-blue-700'));
			btn.classList.add('bg-blue-100', 'border-blue-400', 'text-blue-700');
		}),
	);

	enableExpiration?.addEventListener('change', () => {
		if (expirationSettings) {
			if (enableExpiration.checked) {
				expirationSettings.classList.remove('hidden');
				updateExpirationPreview();
			} else {
				expirationSettings.classList.add('hidden');
				expirationPreview.classList.add('hidden');
				if (expirationInput) expirationInput.value = '';
			}
		}
	});
	expirationInput?.addEventListener('input', updateExpirationPreview);
	expirationInput?.addEventListener('change', updateExpirationPreview);

	document.getElementById('uploadForm')?.addEventListener('submit', async (e) => {
		e.preventDefault();
		hideStatus();
		if (!fileInput.files || fileInput.files.length === 0) {
			showStatus('Please select a file', true);
			return;
		}
		if (enableExpiration.checked && expirationInput.value) {
			const ex = new Date(expirationInput.value);
			if (isNaN(ex.getTime()) || ex <= new Date()) {
				showStatus('Expiration must be in the future', true);
				return;
			}
		}
		const file = fileInput.files[0];
		const method = document.querySelector('input[name="uploadMethod"]:checked')?.value || 'legacy';
		if (method === 'tus') {
			try {
				await startTusUpload(file);
			} catch (err) {
				console.error(err);
				showStatus('TUS start failed', true);
				setLoading(false);
			}
		} else {
			await startLegacyUpload(file);
		}
	});

	pauseBtn?.addEventListener('click', () => {
		if (!currentUpload) return;
		try {
			currentUpload.abort();
			if (pauseBtn) pauseBtn.classList.add('hidden');
			if (resumeBtn) resumeBtn.classList.remove('hidden');
			showStatus('Upload paused');
		} catch (e) {
			console.warn(e);
		}
	});
	resumeBtn?.addEventListener('click', () => {
		if (!currentUpload) return;
		try {
			currentUpload.start();
			if (resumeBtn) resumeBtn.classList.add('hidden');
			if (pauseBtn) pauseBtn.classList.remove('hidden');
			hideStatus();
		} catch (e) {
			console.warn(e);
			showStatus('Resume failed', true);
		}
	});
	cancelBtn?.addEventListener('click', () => {
		if (currentUpload) {
			try {
				currentUpload.abort(true);
			} catch (e) {
				try {
					currentUpload.abort();
				} catch (_) {}
			}
			currentUpload = null;
			hideUploadProgress();
			setLoading(false);
			if (pauseBtn) pauseBtn.classList.add('hidden');
			if (resumeBtn) resumeBtn.classList.add('hidden');
			if (cancelBtn) cancelBtn.classList.add('hidden');
			showStatus('Upload cancelled', true);
			return;
		}
		showStatus('No active resumable upload to cancel', true);
	});

	document.getElementById('refreshStatsBtn')?.addEventListener('click', () => {
		statsCache = null;
		loadAnalytics();
	});
	document.getElementById('refreshRecentBtn')?.addEventListener('click', loadRecentFiles);
	document.getElementById('cleanupExpiredBtn')?.addEventListener('click', cleanupExpiredFiles);
	document.getElementById('cloudflareR2Btn')?.addEventListener('click', async () => {
		try {
			const res = await fetch('/api/admin/r2-info');
			const json = await res.json();
			if (!res.ok || !json.success) {
				showStatus('Failed to get R2 info', true);
				return;
			}
			const url = `https://dash.cloudflare.com/${json.accountId}/r2/default/buckets/${json.bucketName}`;
			window.open(url, '_blank');
		} catch (err) {
			showStatus('Error opening Cloudflare R2 dashboard', true);
		}
	});

	recentFilesEl?.addEventListener('click', (e) => {
		const target = e.target.closest('[data-action="copy-id"]');
		if (target) {
			const fileId = target.dataset.fileId;
			if (fileId) {
				copyFileId(fileId);
			}
		}
	});

	/* ========= FILE ACTIONS (stubs call server handlers) ========= */
	async function cleanupExpiredFiles() {
		if (!confirm('Delete all expired files? This cannot be undone.')) return;
		try {
			const res = await fetch('/api/admin/cleanup', { method: 'POST' });
			const json = await res.json();
			if (res.ok && json.success) {
				showStatus(`Cleanup completed: ${json.deletedCount} deleted`);
				statsCache = null;
				await loadAnalytics();
				await loadRecentFiles();
			} else throw new Error(json.error || 'cleanup failed');
		} catch (err) {
			showStatus('Cleanup failed: ' + (err.message || err), true);
		}
	}

	/* ========= MISC ========= */
	function setLoading(loading) {
		const btn = document.getElementById('submitButton');
		if (btn) {
			btn.disabled = loading;
			btn.textContent = loading ? 'Uploading...' : 'Upload';
		}
	}

	(async function init() {
		setMinDateTime();
		try {
			await loadUserInfo();
			await loadAnalytics();
			await loadRecentFiles();
		} catch (err) {
			console.error('init', err);
			showStatus('Initialization error', true);
		}
	})();
});
