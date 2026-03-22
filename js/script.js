// 100gram - Google Sign-In (Google Identity Services) + per-user chat storage

const GOOGLE_CLIENT_ID = '637219421031-95g7dthgs5n6jfecqqgrmtccbu0l6rtv.apps.googleusercontent.com';

let currentUser = null;   // { id, name, username }
let currentChatId = null;
let chats = [];
let messages = {};
let pendingDeleteChatId = null;
let currentTab = 'dm';

// ── Nicknames ────────────────────────────────────────────────────────────────
// Stored globally so uniqueness is checked across all users on this device.
// Key: "usernames" → { username: userId }
function getAllUsernames() {
    try { return JSON.parse(localStorage.getItem('usernames') || '{}'); } catch { return {}; }
}
function saveAllUsernames(map) {
    localStorage.setItem('usernames', JSON.stringify(map));
}
function isUsernameTaken(username, excludeUserId = null) {
    const map = getAllUsernames();
    const owner = map[username.toLowerCase()];
    if (!owner) return false;
    if (excludeUserId && owner === excludeUserId) return false;
    return true;
}
function reserveUsername(username, userId) {
    const map = getAllUsernames();
    // Release old username of this user
    for (const key of Object.keys(map)) {
        if (map[key] === userId) { delete map[key]; break; }
    }
    map[username.toLowerCase()] = userId;
    saveAllUsernames(map);
}
function getUserByUsername(username) {
    const map = getAllUsernames();
    const userId = map[username.toLowerCase()];
    if (!userId) return null;
    // Try to load their profile
    try {
        const stored = localStorage.getItem(`user_${userId}`);
        if (stored) return JSON.parse(stored);
    } catch {}
    return { id: userId };
}
function saveUserProfile(user) {
    localStorage.setItem(`user_${user.id}`, JSON.stringify(user));
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    loadCurrentUser();
    initGoogleSignIn();

    if (currentUser) {
        updateUserUI();
        showApp();
        loadChats();
    } else {
        showLoginOverlay('Sign in with Google to access your chats.');
    }
});

function bindUI() {
    document.getElementById('sendButton').addEventListener('click', sendMessage);
    document.getElementById('createChatButton').addEventListener('click', onCreateChatClick);
    document.getElementById('createChatConfirm').addEventListener('click', createChatFromModal);
    document.getElementById('createChatCancel').addEventListener('click', closeCreateChatModal);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // Search: chats + messages
    document.getElementById('chatSearch').addEventListener('input', onSearch);

    document.getElementById('authButton').addEventListener('click', () => {
        if (currentUser) {
            logout();
        } else {
            showLoginOverlay('Sign in with Google to access your chats.');
            google.accounts.id.prompt();
        }
    });

    // Delete chat modal
    document.getElementById('deleteChatConfirm').addEventListener('click', confirmDeleteChat);
    document.getElementById('deleteChatCancel').addEventListener('click', () => {
        document.getElementById('deleteChatModal').classList.add('hidden');
        pendingDeleteChatId = null;
    });

    // Nickname modal (first-time setup)
    document.getElementById('nicknameInput').addEventListener('input', debounce(validateNickname, 300));
    document.getElementById('nicknameConfirm').addEventListener('click', saveNickname);

    // Edit nickname modal
    document.getElementById('editNicknameInput').addEventListener('input', debounce(validateEditNickname, 300));
    document.getElementById('editNicknameConfirm').addEventListener('click', saveEditNickname);
    document.getElementById('editNicknameCancel').addEventListener('click', () => {
        document.getElementById('editNicknameModal').classList.add('hidden');
    });

    // DM user search in new chat modal
    document.getElementById('dmUsernameInput').addEventListener('input', debounce(searchDMUser, 300));
}

// ── Google Sign-In ────────────────────────────────────────────────────────────
let _googleInitAttempts = 0;
function initGoogleSignIn() {
    if (!window.google?.accounts?.id) {
        if (++_googleInitAttempts < 10) { setTimeout(initGoogleSignIn, 200); return; }
        showLoginOverlay('Google Sign-In failed to load. Check your connection.');
        return;
    }
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: true,
        cancel_on_tap_outside: false
    });
    google.accounts.id.renderButton(
        document.getElementById('googleSignInButton'),
        { theme: 'outline', size: 'large', width: '100%' }
    );
    google.accounts.id.prompt();
}

function handleCredentialResponse(response) {
    try {
        const payload = parseJwt(response.credential);
        const isNew = !localStorage.getItem(`user_${payload.sub}`);

        currentUser = {
            id: payload.sub,
            name: payload.name || payload.email || 'User',
            username: null
        };

        // Check if user already has a saved profile (returning user)
        const savedProfile = localStorage.getItem(`user_${payload.sub}`);
        if (savedProfile) {
            const prof = JSON.parse(savedProfile);
            currentUser.username = prof.username || null;
        }

        saveCurrentUser();
        saveUserProfile(currentUser);
        updateUserUI();
        showApp();
        loadChats();

        // If first login or no username yet → show nickname setup
        if (!currentUser.username) {
            openNicknameModal();
        }
    } catch (err) {
        console.error('Google sign-in parsing error', err);
        showLoginOverlay('Sign in failed. Please try again.');
    }
}

function parseJwt(token) {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(
        atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    ));
}

function loadCurrentUser() {
    const stored = localStorage.getItem('currentUser');
    if (!stored) return;
    try { currentUser = JSON.parse(stored); } catch { localStorage.removeItem('currentUser'); }
}

function saveCurrentUser() {
    if (!currentUser) return;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

function logout() {
    currentUser = null; currentChatId = null; chats = []; messages = {};
    localStorage.removeItem('currentUser');
    google.accounts.id.disableAutoSelect();
    updateUserUI();
    showLoginOverlay('Signed out. Sign in again to restore your chats.');
}

function showLoginOverlay(message) {
    document.getElementById('authOverlay').querySelector('.auth-message').textContent = message;
    document.getElementById('authOverlay').classList.remove('hidden');
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('app').style.display = 'flex';
    document.getElementById('authOverlay').classList.add('hidden');
}

function updateUserUI() {
    const authButton = document.getElementById('authButton');
    const userInfo   = document.getElementById('userInfo');
    if (currentUser) {
        authButton.textContent = 'Sign out';
        const label = currentUser.username ? `@${currentUser.username}` : (currentUser.name || currentUser.id);
        userInfo.textContent = label;
        userInfo.style.cursor = 'pointer';
        userInfo.title = 'Click to change username';
        userInfo.onclick = () => openEditNicknameModal();
    } else {
        authButton.textContent = 'Sign in';
        userInfo.textContent   = 'Not signed in';
        userInfo.style.cursor  = 'default';
        userInfo.onclick       = null;
    }
}

// ── Nickname (first-time) ─────────────────────────────────────────────────────
function openNicknameModal() {
    document.getElementById('nicknameInput').value = '';
    document.getElementById('nicknameStatus').textContent = '';
    document.getElementById('nicknameConfirm').disabled = true;
    document.getElementById('nicknameModal').classList.remove('hidden');
}

function validateNickname() {
    const val    = document.getElementById('nicknameInput').value.trim().toLowerCase();
    const status = document.getElementById('nicknameStatus');
    const btn    = document.getElementById('nicknameConfirm');

    if (!val || val.length < 3) {
        status.textContent = 'Min 3 characters'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    if (!/^[a-z0-9_]+$/.test(val)) {
        status.textContent = 'Only letters, numbers, _'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    if (isUsernameTaken(val, currentUser.id)) {
        status.textContent = '@' + val + ' is already taken'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    status.textContent = '@' + val + ' is available ✓'; status.className = 'nickname-status ok';
    btn.disabled = false;
}

function saveNickname() {
    const val = document.getElementById('nicknameInput').value.trim().toLowerCase();
    if (!val || isUsernameTaken(val, currentUser.id)) return;
    currentUser.username = val;
    reserveUsername(val, currentUser.id);
    saveCurrentUser();
    saveUserProfile(currentUser);
    updateUserUI();
    document.getElementById('nicknameModal').classList.add('hidden');
    // Re-render messages so sender labels update
    loadMessages();
}

// ── Edit Nickname ─────────────────────────────────────────────────────────────
function openEditNicknameModal() {
    document.getElementById('editNicknameInput').value = currentUser.username || '';
    document.getElementById('editNicknameStatus').textContent = '';
    document.getElementById('editNicknameConfirm').disabled = false;
    document.getElementById('editNicknameModal').classList.remove('hidden');
}

function validateEditNickname() {
    const val    = document.getElementById('editNicknameInput').value.trim().toLowerCase();
    const status = document.getElementById('editNicknameStatus');
    const btn    = document.getElementById('editNicknameConfirm');

    if (!val || val.length < 3) {
        status.textContent = 'Min 3 characters'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    if (!/^[a-z0-9_]+$/.test(val)) {
        status.textContent = 'Only letters, numbers, _'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    if (isUsernameTaken(val, currentUser.id)) {
        status.textContent = '@' + val + ' is already taken'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    status.textContent = val === currentUser.username ? 'Current username' : '@' + val + ' is available ✓';
    status.className = 'nickname-status ok';
    btn.disabled = false;
}

function saveEditNickname() {
    const val = document.getElementById('editNicknameInput').value.trim().toLowerCase();
    if (!val || isUsernameTaken(val, currentUser.id)) return;

    currentUser.username = val;
    reserveUsername(val, currentUser.id);
    saveCurrentUser();
    saveUserProfile(currentUser);
    updateUserUI();
    document.getElementById('editNicknameModal').classList.add('hidden');

    // All messages now show the new username — re-render
    loadMessages();
    renderChatList();
}

// ── Chat creation ─────────────────────────────────────────────────────────────
function onCreateChatClick() {
    if (!currentUser) { showLoginOverlay('Sign in to create chats.'); return; }
    openCreateChatModal();
}

function openCreateChatModal() {
    document.getElementById('newChatModal').classList.remove('hidden');
    document.getElementById('dmUsernameInput').value = '';
    document.getElementById('dmSearchResult').innerHTML = '';
    document.getElementById('groupNameInput').value = '';
    switchTab('dm');
}

function closeCreateChatModal() {
    document.getElementById('newChatModal').classList.add('hidden');
}

window.switchTab = function(tab) {
    currentTab = tab;
    document.getElementById('dmTab').classList.toggle('hidden', tab !== 'dm');
    document.getElementById('groupTab').classList.toggle('hidden', tab !== 'group');
    document.getElementById('tabDM').classList.toggle('active', tab === 'dm');
    document.getElementById('tabGroup').classList.toggle('active', tab === 'group');
};

function searchDMUser() {
    const val = document.getElementById('dmUsernameInput').value.trim().replace(/^@/, '').toLowerCase();
    const result = document.getElementById('dmSearchResult');
    if (!val) { result.innerHTML = ''; return; }

    const user = getUserByUsername(val);
    if (!user) {
        result.innerHTML = `<span class="dm-not-found">User @${val} not found</span>`;
        return;
    }
    if (user.id === currentUser.id) {
        result.innerHTML = `<span class="dm-not-found">That's you 😄</span>`;
        return;
    }
    result.innerHTML = `
        <div class="dm-found-user">
            <span class="dm-avatar">${(user.username || user.name || '?')[0].toUpperCase()}</span>
            <span>@${user.username || user.id}</span>
        </div>`;
}

function createChatFromModal() {
    if (currentTab === 'dm') {
        const val = document.getElementById('dmUsernameInput').value.trim().replace(/^@/, '').toLowerCase();
        if (!val) return;
        const targetUser = getUserByUsername(val);
        if (!targetUser || targetUser.id === currentUser.id) return;

        // Avoid duplicate DMs
        const existing = chats.find(c => c.type === 'dm' && c.withUserId === targetUser.id);
        if (existing) { closeCreateChatModal(); selectChat(existing.id); return; }

        const chatId = 'dm_' + Date.now();
        const newChat = {
            id: chatId,
            name: targetUser.username ? '@' + targetUser.username : (targetUser.name || 'User'),
            type: 'dm',
            withUserId: targetUser.id
        };
        chats.push(newChat);
        messages[chatId] = [];
        saveChats(); saveMessages();
        renderChatList(); selectChat(chatId); closeCreateChatModal();

    } else {
        const groupName = document.getElementById('groupNameInput').value.trim();
        if (!groupName) return;

        const chatId = 'group_' + Date.now();
        chats.push({ id: chatId, name: groupName, type: 'group' });
        messages[chatId] = [];
        saveChats(); saveMessages();
        renderChatList(); selectChat(chatId); closeCreateChatModal();
    }
}

// ── Delete chat ───────────────────────────────────────────────────────────────
function openDeleteChatModal(chatId) {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    pendingDeleteChatId = chatId;
    document.getElementById('deleteChatName').textContent = `"${chat.name}" will be removed for you.`;
    document.getElementById('deleteChatModal').classList.remove('hidden');
}

function confirmDeleteChat() {
    if (!pendingDeleteChatId) return;
    chats = chats.filter(c => c.id !== pendingDeleteChatId);
    delete messages[pendingDeleteChatId];
    if (currentChatId === pendingDeleteChatId) {
        currentChatId = chats[0]?.id || null;
    }
    saveChats(); saveMessages();
    renderChatList();
    if (currentChatId) selectChat(currentChatId);
    else {
        document.querySelector('.chat-name').textContent = 'Select a chat';
        document.getElementById('messages').innerHTML = '';
        document.getElementById('messageInputContainer').style.display = 'none';
    }
    document.getElementById('deleteChatModal').classList.add('hidden');
    pendingDeleteChatId = null;
}

// ── Chat list ─────────────────────────────────────────────────────────────────
function loadChats() {
    if (!currentUser) return;
    const storedChats = localStorage.getItem(`chats_${currentUser.id}`);
    if (storedChats) chats = JSON.parse(storedChats);

    const storedMessages = localStorage.getItem(`messages_${currentUser.id}`);
    if (storedMessages) messages = JSON.parse(storedMessages);

    if (chats.length === 0) {
        const chatId = 'group_' + Date.now();
        chats.push({ id: chatId, name: 'General', type: 'group' });
        messages[chatId] = [];
        saveChats(); saveMessages();
    }
    if (!currentChatId) currentChatId = chats[0].id;
    renderChatList();
    selectChat(currentChatId);
}

function saveChats() {
    if (!currentUser) return;
    localStorage.setItem(`chats_${currentUser.id}`, JSON.stringify(chats));
}

function saveMessages() {
    if (!currentUser) return;
    localStorage.setItem(`messages_${currentUser.id}`, JSON.stringify(messages));
}

function renderChatList() {
    const chatList = document.getElementById('chatList');
    const query    = document.getElementById('chatSearch').value.trim().toLowerCase();
    // When searching, hide normal list (search results shown separately)
    chatList.innerHTML = '';

    chats
        .filter(c => !query || c.name.toLowerCase().includes(query))
        .forEach(chat => {
            const lastMsg = (messages[chat.id] || []).slice(-1)[0];
            const preview = lastMsg ? lastMsg.text : 'No messages yet';
            const time    = lastMsg ? formatTime(lastMsg.timestamp) : '';

            const item = document.createElement('div');
            item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');

            const avatar = document.createElement('div');
            avatar.className = 'chat-item-avatar';
            avatar.textContent = chat.name.slice(0, 2).toUpperCase();

            const body = document.createElement('div');
            body.className = 'chat-item-body';
            body.innerHTML = `<div class="chat-item-title">${escapeHtml(chat.name)}</div>
                              <div class="chat-item-subtitle">${escapeHtml(preview)}</div>`;

            const timeEl = document.createElement('div');
            timeEl.className = 'chat-item-time';
            timeEl.textContent = time;

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'chat-delete-btn';
            delBtn.title = 'Delete chat';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openDeleteChatModal(chat.id);
            });

            item.appendChild(avatar);
            item.appendChild(body);
            item.appendChild(timeEl);
            item.appendChild(delBtn);
            item.addEventListener('click', () => selectChat(chat.id));
            chatList.appendChild(item);
        });
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch() {
    const query   = document.getElementById('chatSearch').value.trim().toLowerCase();
    const panel   = document.getElementById('searchResults');

    if (!query) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        renderChatList();
        return;
    }

    // Chat name hits
    const chatHits = chats.filter(c => c.name.toLowerCase().includes(query));

    // Message hits
    const msgHits = [];
    chats.forEach(chat => {
        (messages[chat.id] || []).forEach((msg, idx) => {
            if (msg.text.toLowerCase().includes(query)) {
                msgHits.push({ chat, msg, idx });
            }
        });
    });

    // Render
    let html = '';

    if (chatHits.length) {
        html += `<div class="search-section-label">Chats</div>`;
        chatHits.forEach(c => {
            html += `<div class="search-hit" data-chat="${c.id}">
                       <span class="search-hit-title">${highlight(escapeHtml(c.name), query)}</span>
                     </div>`;
        });
    }

    if (msgHits.length) {
        html += `<div class="search-section-label">Messages</div>`;
        msgHits.slice(0, 20).forEach(({ chat, msg }) => {
            const sender = msg.senderName || msg.sender || '';
            html += `<div class="search-hit" data-chat="${chat.id}">
                       <span class="search-hit-chat">${escapeHtml(chat.name)}</span>
                       <span class="search-hit-msg">${highlight(escapeHtml(msg.text), query)}</span>
                     </div>`;
        });
    }

    if (!chatHits.length && !msgHits.length) {
        html = `<div class="search-empty">No results for "${escapeHtml(query)}"</div>`;
    }

    panel.innerHTML = html;
    panel.classList.remove('hidden');

    // Click to open chat
    panel.querySelectorAll('.search-hit').forEach(el => {
        el.addEventListener('click', () => {
            const chatId = el.dataset.chat;
            selectChat(chatId);
            document.getElementById('chatSearch').value = '';
            panel.classList.add('hidden');
            panel.innerHTML = '';
            renderChatList();
        });
    });
}

function highlight(str, query) {
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return str.replace(re, '<mark>$1</mark>');
}

// ── Messages ──────────────────────────────────────────────────────────────────
function selectChat(chatId) {
    currentChatId = chatId;
    renderChatList();
    loadMessages();
    const chat = chats.find(c => c.id === chatId);
    document.querySelector('.chat-name').textContent = chat ? chat.name : '';
    document.getElementById('messageInputContainer').style.display = 'flex';
}

function loadMessages() {
    const container = document.getElementById('messages');
    container.innerHTML = '';
    if (!currentChatId || !messages[currentChatId]) {
        document.getElementById('messageInputContainer').style.display = 'none';
        return;
    }

    messages[currentChatId].forEach(msg => {
        const isSent = msg.sender === currentUser?.id;
        const wrapper = document.createElement('div');
        wrapper.className = `message ${isSent ? 'sent' : 'received'}`;

        // Sender name: always look up current username in case it changed
        let senderLabel = '';
        if (!isSent) {
            const profile = localStorage.getItem(`user_${msg.sender}`);
            if (profile) {
                const p = JSON.parse(profile);
                senderLabel = p.username ? '@' + p.username : (p.name || msg.senderName || 'User');
            } else {
                senderLabel = msg.senderName || 'User';
            }
            const senderEl = document.createElement('div');
            senderEl.className = 'message-sender';
            senderEl.textContent = senderLabel;
            wrapper.appendChild(senderEl);
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = msg.text;
        wrapper.appendChild(bubble);

        const meta = document.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = formatTime(msg.timestamp);
        wrapper.appendChild(meta);

        container.appendChild(wrapper);
    });
    container.scrollTop = container.scrollHeight;
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const text  = input.value.trim();
    if (!text || !currentChatId || !currentUser) return;

    messages[currentChatId] = messages[currentChatId] || [];
    messages[currentChatId].push({
        text,
        sender:     currentUser.id,
        senderName: currentUser.username ? '@' + currentUser.username : currentUser.name,
        timestamp:  Date.now()
    });
    saveMessages();
    loadMessages();

    // Update chat preview
    renderChatList();
    input.value = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(ts) {
    const d = new Date(ts);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
