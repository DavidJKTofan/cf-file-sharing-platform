document.addEventListener('DOMContentLoaded', () => {
	// State
	let currentSort = { col: 'uploadedAt', asc: false };
	let allFiles = [];
	let filteredFiles = [];
	let userRoles = []; // roles from /api/debug/jwt
	let isAdmin = false;
	let userEmail = null;

	// DOM refs
	const fileTable = document.getElementById('fileTable');
	const searchBox = document.getElementById('searchBox');
	const statusMessage = document.getElementById('statusMessage');
	const loadingIndicator = document.getElementById('loadingIndicator');
	const emptyState = document.getElementById('emptyState');
	const totalFiles = document.getElementById('totalFiles');
	const refreshBtn = document.getElementById('refreshBtn');
	const clearSearchBtn = document.getElementById('clearSearchBtn');
	const userEmailDisplay = document.getElementById('userEmailDisplay');
	const userRolesDisplay = document.getElementById('userRolesDisplay');
	const userRolePill = document.getElementById('userRolePill');

	// Utility
	function showStatus(message, isError = false) {
		if (!statusMessage) return;
		statusMessage.textContent = message;
		statusMessage.className = `mb-4 p-3 rounded-lg ${
			isError ? 'bg-red-100 text-red-700 border border-red-300' : 'bg-green-100 text-green-700 border border-green-300'
		}`;
		statusMessage.classList.remove('hidden');
		setTimeout(() => statusMessage.classList.add('hidden'), 5000);
	}

	function formatFileSize(bytes) {
		if (!bytes && bytes !== 0) return '—';
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}

	function formatDate(dateString) {
		if (!dateString) return 'Unknown';
		try {
			return new Date(dateString).toLocaleString();
		} catch {
			return 'Invalid Date';
		}
	}

	function truncateText(text, maxLength = 50) {
		if (!text) return '';
		return text.length <= maxLength ? text : text.substring(0, maxLength) + '...';
	}

	function formatExpiration(expirationString) {
		if (!expirationString) return '<span class="text-slate-400 text-xs">Never</span>';
		try {
			const expirationDate = new Date(expirationString);
			const now = new Date();
			if (expirationDate <= now) {
				return '<span class="badge badge-danger text-[10px] py-0.5">⚠️ EXPIRED</span>';
			}
			const diffMs = expirationDate.getTime() - now.getTime();
			const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
			const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
			const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
			let countdown = '',
				colorClass = 'text-emerald-600';
			if (diffDays > 7) {
				countdown = `${diffDays} days`;
				colorClass = 'text-emerald-600';
			} else if (diffDays > 1) {
				countdown = `${diffDays} days, ${diffHours}h`;
				colorClass = 'text-amber-600';
			} else if (diffDays === 1) {
				countdown = `1 day, ${diffHours}h`;
				colorClass = 'text-orange-600';
			} else if (diffHours > 0) {
				countdown = `${diffHours}h ${diffMinutes}m`;
				colorClass = 'text-red-600';
			} else {
				countdown = `${diffMinutes}m`;
				colorClass = 'text-red-700';
			}
			return `<div class="text-xs"><div class="${colorClass} font-semibold">⏰ ${countdown}</div><div class="text-slate-500">${expirationDate.toLocaleString()}</div></div>`;
		} catch (e) {
			return '<span class="text-slate-400 text-xs">Invalid Date</span>';
		}
	}

	function updateCountdowns() {
		const rows = document.querySelectorAll('#fileTable tr');
		rows.forEach((row, idx) => {
			const file = filteredFiles[idx];
			if (!file) return;
			if (file.expiration) {
				const cell = row.cells[4]; // expiration column (filename, size, description, tags, expiration)
				if (cell) {
					const iconAndContent = cell.querySelector('div');
					if (iconAndContent) {
						const contentDiv = iconAndContent.querySelector('div:last-child');
						if (contentDiv) {
							contentDiv.innerHTML = formatExpiration(file.expiration);
						}
					}
				}
			}
		});
	}
	setInterval(updateCountdowns, 60000);

	// Determine appropriate endpoint based on role
	function getListEndpoint() {
		if (isAdmin) {
			return '/api/admin/list?includeHidden=true&includeExpired=true';
		}
		return '/api/list';
	}

	async function loadUserRoles() {
		try {
			const res = await fetch('/api/debug/jwt', { credentials: 'same-origin' });
			if (!res.ok) {
				// treat as unauthenticated/public
				userRoles = [];
				isAdmin = false;
				userEmail = null;
				userEmailDisplay.textContent = 'Public';
				userRolePill.textContent = 'Public';
				return;
			}
			const json = await res.json();
			const extracted = json.extractedUser || null;
			if (extracted && Array.isArray(extracted.roles)) {
				userRoles = extracted.roles;
				isAdmin = userRoles.includes('admin');
				userEmail = extracted.email || null;
				userEmailDisplay.textContent = userEmail || 'Authenticated';
				userRolePill.textContent = userRoles.join(', ');
				return;
			}
			// fallback to raw payload roles
			const raw = json.rawJwtPayload || null;
			if (raw && Array.isArray(raw.roles)) {
				userRoles = raw.roles;
				isAdmin = userRoles.includes('admin');
				userEmail = raw.email || null;
				userEmailDisplay.textContent = userEmail || 'Authenticated';
				userRolePill.textContent = userRoles.join(', ');
				return;
			}

			// nothing meaningful
			userRoles = [];
			isAdmin = false;
			userEmail = null;
			userEmailDisplay.textContent = 'Public';
			userRolePill.textContent = 'Public';
		} catch (err) {
			console.warn('Failed to fetch /api/debug/jwt', err);
			userRoles = [];
			isAdmin = false;
			userEmail = null;
			userEmailDisplay.textContent = 'Public';
			userRolePill.textContent = 'Public';
		}
	}

	// Load files from API
	async function loadFiles(searchQuery = '') {
		try {
			loadingIndicator.classList.remove('hidden');
			emptyState.classList.add('hidden');
			fileTable.innerHTML = '';

			// refresh roles so UI and endpoint selection are current
			await loadUserRoles();

			const base = getListEndpoint();
			const url = new URL(base, window.location.origin);
			if (searchQuery) url.searchParams.set('search', searchQuery);

			console.log('Fetching files from:', url.toString());
			const response = await fetch(url.toString(), { credentials: 'same-origin' });
			const result = await response.json();
			console.log('API Response:', result);

			if (!response.ok || result.success === false) {
				throw new Error(result.error || 'Failed to load files');
			}

			allFiles = result.files || [];
			filteredFiles = [...allFiles];
			updateFileStats();
			sortFiles(currentSort.col, currentSort.asc); // will also render
		} catch (error) {
			console.error('Error loading files:', error);
			showStatus(`Error loading files: ${error.message}`, true);
			fileTable.innerHTML = '';
			emptyState.classList.remove('hidden');
		} finally {
			loadingIndicator.classList.add('hidden');
		}
	}

	// Update file statistics
	function updateFileStats() {
		const totalSize = allFiles.reduce((sum, f) => sum + (f.size || 0), 0);
		const expiredCount = allFiles.filter((file) => file.expiration && new Date(file.expiration) <= new Date()).length;
		let statsText = `${filteredFiles.length} files (${formatFileSize(totalSize)} total)`;
		if (expiredCount > 0) statsText += ` • ${expiredCount} expired`;
		totalFiles.textContent = statsText;
	}

	// Render table
	function renderFiles() {
		fileTable.innerHTML = '';
		if (filteredFiles.length === 0) {
			emptyState.classList.remove('hidden');
			return;
		}
		emptyState.classList.add('hidden');

		filteredFiles.forEach((file) => {
			const row = document.createElement('tr');
			const isExpired = file.expiration && new Date(file.expiration) <= new Date();
			row.className = isExpired ? 'bg-red-50/50 border-l-2 border-red-400' : '';

			const uploadTypeBadge =
				file.uploadType === 'multipart'
					? '<span class="badge badge-info ml-2 text-[10px] py-0.5">Multipart</span>'
					: '';

			row.innerHTML = `
        <td class="px-6 py-4">
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-slate-800 truncate">${escapeHtml(file.filename || 'Unknown')}</div>
              <div class="text-xs text-slate-500 mt-1 truncate">ID: ${escapeHtml(file.fileId)} ${uploadTypeBadge}</div>
              ${
								file.description
									? `<div class="lg:hidden mt-2 text-xs text-slate-600 italic line-clamp-2" title="${escapeHtml(file.description)}">
                      <svg class="w-3 h-3 text-indigo-400 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      ${escapeHtml(truncateText(file.description, 80))}
                    </div>`
									: ''
							}
            </div>
          </div>
        </td>
        <td class="px-6 py-4"><span class="font-mono text-sm text-slate-700">${formatFileSize(file.size)}</span></td>
        <td class="px-6 py-4 hidden lg:table-cell bg-indigo-50/30">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span class="text-slate-700 text-sm font-medium" title="${escapeHtml(file.description || '')}">${escapeHtml(
					truncateText(file.description || 'No description'),
				)}</span>
          </div>
        </td>
        <td class="px-6 py-4 hidden lg:table-cell bg-purple-50/30">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.98 1.98 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <div class="flex flex-wrap gap-1.5">
              ${
								file.tags
									? escapeHtml(file.tags)
											.split(',')
											.map(
												(t) =>
													`<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-700 border border-purple-200">${escapeHtml(
														t.trim(),
													)}</span>`,
											)
											.join('')
									: '<span class="text-slate-400 text-xs font-medium">No tags</span>'
							}
            </div>
          </div>
        </td>
        <td class="px-6 py-4 hidden sm:table-cell bg-amber-50/30">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>${formatExpiration(file.expiration)}</div>
          </div>
        </td>
        <td class="px-6 py-4 hidden sm:table-cell bg-emerald-50/30">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span class="text-sm font-semibold text-slate-700">${formatDate(file.uploadedAt)}</span>
          </div>
        </td>
        <td class="px-6 py-4 text-right">
          <div class="flex gap-2 justify-end">
            ${
							isExpired
								? '<span class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-700 text-xs font-medium rounded-lg border border-red-200">🚫 Expired</span>'
								: `<a href="${file.downloadUrl}?filename=${encodeURIComponent(
										file.filename,
								  )}" target="_blank" class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-xs font-medium rounded-lg hover:from-indigo-600 hover:to-purple-700 transition shadow-sm">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download
                  </a>`
						}
            <button data-action="copy-id" data-file-id="${escapeHtml(
							file.fileId,
						)}" class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-200 transition">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy ID
            </button>
          </div>
        </td>
      `;
			fileTable.appendChild(row);
		});
	}

	// Copy file ID
	function copyFileId(fileId) {
		navigator.clipboard
			.writeText(fileId)
			.then(() => showStatus('File ID copied to clipboard!'))
			.catch(() => showStatus('Failed to copy file ID', true));
	}

	// Sort
	function sortFiles(column, ascending) {
		filteredFiles.sort((a, b) => {
			let valA = a[column] || '';
			let valB = b[column] || '';
			if (column === 'size') {
				valA = a.size || 0;
				valB = b.size || 0;
			} else if (column === 'uploadedAt' || column === 'expiration') {
				valA = a[column] ? new Date(a[column]).getTime() : 0;
				valB = b[column] ? new Date(b[column]).getTime() : 0;
			} else {
				valA = String(valA).toLowerCase();
				valB = String(valB).toLowerCase();
			}
			if (valA < valB) return ascending ? -1 : 1;
			if (valA > valB) return ascending ? 1 : -1;
			return 0;
		});
		renderFiles();
	}

	// Search
	function performSearch() {
		const term = searchBox.value.toLowerCase().trim();
		if (!term) {
			filteredFiles = [...allFiles];
		} else {
			filteredFiles = allFiles.filter((file) =>
				`${file.filename} ${file.description || ''} ${file.tags || ''}`.toLowerCase().includes(term),
			);
		}
		updateFileStats();
		sortFiles(currentSort.col, currentSort.asc);
	}

	// Event wiring
	refreshBtn.addEventListener('click', () => {
		searchBox.value = '';
		loadFiles();
	});
	clearSearchBtn.addEventListener('click', () => {
		searchBox.value = '';
		performSearch();
	});
	searchBox.addEventListener('input', performSearch);

	document.querySelectorAll('thead th[data-col]').forEach((th) => {
		th.addEventListener('click', () => {
			const column = th.getAttribute('data-col');
			const ascending = currentSort.col === column ? !currentSort.asc : true;
			currentSort = { col: column, asc: ascending };
			document.querySelectorAll('.sort-indicator').forEach((ind) => (ind.textContent = '↕️'));
			const indicator = th.querySelector('.sort-indicator');
			if (indicator) indicator.textContent = ascending ? '↑' : '↓';
			sortFiles(column, ascending);
		});
	});

	document.getElementById('retrieveForm').addEventListener('submit', (e) => {
		e.preventDefault();
		const fileId = (document.getElementById('fileId').value || '').trim();
		if (fileId) window.open(`/api/download/${encodeURIComponent(fileId)}`, '_blank');
	});

	fileTable.addEventListener('click', (e) => {
		const target = e.target.closest('[data-action="copy-id"]');
		if (target) {
			const fileId = target.dataset.fileId;
			if (fileId) {
				copyFileId(fileId);
			}
		}
	});

	// Escaping helper
	function escapeHtml(s) {
		return String(s || '').replace(
			/[&<>"'\/]/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;' })[c],
		);
	}

	// Init
	loadFiles();
});
