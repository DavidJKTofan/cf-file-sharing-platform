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
		if (!expirationString) return '<span class="text-gray-400 text-xs">Never</span>';
		try {
			const expirationDate = new Date(expirationString);
			const now = new Date();
			if (expirationDate <= now) {
				return '<span class="text-red-600 font-medium text-xs">⚠️ EXPIRED</span>';
			}
			const diffMs = expirationDate.getTime() - now.getTime();
			const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
			const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
			const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
			let countdown = '',
				colorClass = 'text-green-600';
			if (diffDays > 7) {
				countdown = `${diffDays} days`;
				colorClass = 'text-green-600';
			} else if (diffDays > 1) {
				countdown = `${diffDays} days, ${diffHours}h`;
				colorClass = 'text-yellow-600';
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
			return `<div class="text-xs"><div class="${colorClass} font-medium">⏰ ${countdown}</div><div class="text-gray-500">${expirationDate.toLocaleString()}</div></div>`;
		} catch (e) {
			return '<span class="text-gray-400 text-xs">Invalid Date</span>';
		}
	}

	function updateCountdowns() {
		const rows = document.querySelectorAll('#fileTable tr');
		rows.forEach((row, idx) => {
			const file = filteredFiles[idx];
			if (!file) return;
			if (file.expiration) {
				const cell = row.cells[4]; // expiration column
				if (cell) cell.innerHTML = formatExpiration(file.expiration);
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
			row.className = `hover:bg-gray-50 transition ${isExpired ? 'bg-red-50 border-l-4 border-red-400' : ''}`;

			const uploadTypeBadge =
				file.uploadType === 'multipart'
					? '<span class="inline-block px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded-full ml-1">Multipart</span>'
					: '';

			row.innerHTML = `
        <td class="px-4 py-3 border-b">
          <div class="font-medium text-gray-900">${escapeHtml(file.filename || 'Unknown')}</div>
          <div class="text-xs text-gray-500">ID: ${escapeHtml(file.fileId)} ${uploadTypeBadge}</div>
        </td>
        <td class="px-4 py-3 border-b"><span class="font-mono text-sm">${formatFileSize(file.size)}</span></td>
        <td class="px-4 py-3 border-b"><span class="text-gray-700" title="${escapeHtml(file.description || '')}">${escapeHtml(
					truncateText(file.description || ''),
				)}</span></td>
        <td class="px-4 py-3 border-b">
          <div class="flex flex-wrap gap-1">
            ${
							file.tags
								? escapeHtml(file.tags)
										.split(',')
										.map(
											(t) =>
												`<span class="inline-block px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">${escapeHtml(
													t.trim(),
												)}</span>`,
										)
										.join('')
								: '<span class="text-gray-400 text-xs">No tags</span>'
						}
          </div>
        </td>
        <td class="px-4 py-3 border-b">${formatExpiration(file.expiration)}</td>
        <td class="px-4 py-3 border-b"><span class="text-sm text-gray-600">${formatDate(file.uploadedAt)}</span></td>
        <td class="px-4 py-3 border-b">
          <div class="flex gap-2">
            ${
							isExpired
								? '<span class="px-3 py-1 bg-red-100 text-red-700 text-xs rounded-sm border">🚫 Expired</span>'
								: `<a href="${file.downloadUrl}" target="_blank" class="inline-block px-3 py-1 bg-blue-600 text-white text-xs rounded-sm hover:bg-blue-700 transition">📥 Download</a>`
						}
            <button data-action="copy-id" data-file-id="${escapeHtml(
							file.fileId,
						)}" class="px-3 py-1 bg-gray-500 text-white text-xs rounded-sm hover:bg-gray-600 transition">📋 Copy ID</button>
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
