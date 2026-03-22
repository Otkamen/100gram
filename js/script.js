// 100gram — Google Sign-In + FastAPI backend
// Chats and messages are stored on the server, not in localStorage.

const GOOGLE_CLIENT_ID = '637219421031-95g7dthgs5n6jfecqqgrmtccbu0l6rtv.apps.googleusercontent.com';
const API = 'https://one00gram.onrender.com';  // ← замените на адрес вашего сервера в продакшне

let currentUser    = null;   // { id, username, display_name, has_username }
let apiToken       = null;   // JWT from our backend
let currentChatId  = null;
let chats          = [];
let messages       = {};     // chatId → [msg, ...]
let pendingDeleteChatId = null;
let currentTab     = 'dm';
let ws             = null;   // WebSocket

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body = null) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (apiToken) opts.headers['Authorization'] = `Bearer ${apiToken}`;
    if (body)     opts.body = JSON.stringify(body);

    const resp = await fetch(API + path, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || resp.statusText);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
    if (!apiToken) return;
    ws = new WebSocket(`ws://${API.replace(/https?:\/\//, '')}/ws/${apiToken}`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'new_message') {
            const msg = data.message;
            messages[msg.chat_id] = messages[msg.chat_id] || [];
            // Avoid duplicates
            if (!messages[msg.chat_id].find(m => m.id === msg.id)) {
                messages[msg.chat_id].push(msg);
            }
            if (msg.chat_id === currentChatId) renderMessages();
            renderChatList();
        }
    };

    ws.onclose = () => {
        // Reconnect after 3s
        setTimeout(() => { if (apiToken) connectWS(); }, 3000);
    };

    // Keep-alive ping every 30s
    setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 30000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindUI();

    // Restore session from localStorage
    const savedToken = localStorage.getItem('apiToken');
    const savedUser  = localStorage.getItem('currentUser');
    if (savedToken && savedUser) {
        apiToken    = savedToken;
        currentUser = JSON.parse(savedUser);
        showApp();
        loadChats();
        connectWS();
    } else {
        showLoginOverlay('Sign in with Google to access your chats.');
    }

    initGoogleSignIn();
});

function bindUI() {
    document.getElementById('sendButton').addEventListener('click', sendMessage);
    document.getElementById('createChatButton').addEventListener('click', onCreateChatClick);
    document.getElementById('createChatConfirm').addEventListener('click', createChatFromModal);
    document.getElementById('createChatCancel').addEventListener('click', closeCreateChatModal);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('chatSearch').addEventListener('input', onSearch);
    document.getElementById('authButton').addEventListener('click', () => {
        if (currentUser) logout();
        else { showLoginOverlay('Sign in with Google to access your chats.'); google.accounts.id.prompt(); }
    });

    // Delete chat modal
    document.getElementById('deleteChatConfirm').addEventListener('click', confirmDeleteChat);
    document.getElementById('deleteChatCancel').addEventListener('click', () => {
        document.getElementById('deleteChatModal').classList.add('hidden');
        pendingDeleteChatId = null;
    });

    // Nickname modals
    document.getElementById('nicknameInput').addEventListener('input', debounce(validateNickname, 300));
    document.getElementById('nicknameConfirm').addEventListener('click', saveNickname);
    document.getElementById('editNicknameInput').addEventListener('input', debounce(validateEditNickname, 300));
    document.getElementById('editNicknameConfirm').addEventListener('click', saveEditNickname);
    document.getElementById('editNicknameCancel').addEventListener('click', () => {
        document.getElementById('editNicknameModal').classList.add('hidden');
    });

    // DM user search
    document.getElementById('dmUsernameInput').addEventListener('input', debounce(searchDMUser, 350));
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

async function handleCredentialResponse(response) {
    try {
        // Send Google token to our backend — backend verifies with Google and returns JWT
        const result = await api('POST', '/auth/google', { credential: response.credential });
        apiToken    = result.access_token;
        currentUser = result.user;

        localStorage.setItem('apiToken',    apiToken);
        localStorage.setItem('currentUser', JSON.stringify(currentUser));

        updateUserUI();
        showApp();
        await loadChats();
        connectWS();

        // New user without a real username → force nickname setup
        if (!currentUser.has_username) {
            openNicknameModal();
        }
    } catch (err) {
        showLoginOverlay('Sign in failed: ' + err.message);
    }
}

function logout() {
    apiToken = null; currentUser = null;
    currentChatId = null; chats = []; messages = {};
    localStorage.removeItem('apiToken');
    localStorage.removeItem('currentUser');
    if (ws) ws.close();
    google.accounts.id.disableAutoSelect();
    updateUserUI();
    showLoginOverlay('Signed out.');
}

function showLoginOverlay(msg) {
    document.getElementById('authOverlay').querySelector('.auth-message').textContent = msg;
    document.getElementById('authOverlay').classList.remove('hidden');
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('app').style.display = 'flex';
    document.getElementById('authOverlay').classList.add('hidden');
    updateUserUI();
}

function updateUserUI() {
    const authButton = document.getElementById('authButton');
    const userInfo   = document.getElementById('userInfo');
    if (currentUser) {
        authButton.textContent = 'Sign out';
        const label = currentUser.has_username
            ? `@${currentUser.username}`
            : (currentUser.display_name || currentUser.id);
        userInfo.textContent  = label;
        userInfo.style.cursor = 'pointer';
        userInfo.title        = 'Click to change username';
        userInfo.onclick      = () => openEditNicknameModal();
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

async function validateNickname() {
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
    // Check uniqueness on server
    try {
        await api('GET', `/users/@${val}`);
        // If we get here — user exists
        status.textContent = `@${val} is already taken`; status.className = 'nickname-status error';
        btn.disabled = true;
    } catch {
        // 404 = available
        status.textContent = `@${val} is available ✓`; status.className = 'nickname-status ok';
        btn.disabled = false;
    }
}

async function saveNickname() {
    const val = document.getElementById('nicknameInput').value.trim().toLowerCase();
    if (!val) return;
    try {
        const updated = await api('PATCH', '/auth/me', { new_username: val });
        currentUser = { ...updated, has_username: true };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        updateUserUI();
        document.getElementById('nicknameModal').classList.add('hidden');
        renderMessages();
    } catch (err) {
        document.getElementById('nicknameStatus').textContent = err.message;
        document.getElementById('nicknameStatus').className = 'nickname-status error';
    }
}

// ── Edit Nickname ─────────────────────────────────────────────────────────────
function openEditNicknameModal() {
    document.getElementById('editNicknameInput').value = currentUser.has_username ? currentUser.username : '';
    document.getElementById('editNicknameStatus').textContent = '';
    document.getElementById('editNicknameConfirm').disabled = false;
    document.getElementById('editNicknameModal').classList.remove('hidden');
}

async function validateEditNickname() {
    const val    = document.getElementById('editNicknameInput').value.trim().toLowerCase();
    const status = document.getElementById('editNicknameStatus');
    const btn    = document.getElementById('editNicknameConfirm');

    if (val === currentUser.username) {
        status.textContent = 'Current username'; status.className = 'nickname-status ok';
        btn.disabled = false; return;
    }
    if (!val || val.length < 3 || !/^[a-z0-9_]+$/.test(val)) {
        status.textContent = 'Min 3 chars, only a-z 0-9 _'; status.className = 'nickname-status error';
        btn.disabled = true; return;
    }
    try {
        await api('GET', `/users/@${val}`);
        status.textContent = `@${val} is already taken`; status.className = 'nickname-status error';
        btn.disabled = true;
    } catch {
        status.textContent = `@${val} is available ✓`; status.className = 'nickname-status ok';
        btn.disabled = false;
    }
}

async function saveEditNickname() {
    const val = document.getElementById('editNicknameInput').value.trim().toLowerCase();
    if (!val) return;
    try {
        const updated = await api('PATCH', '/auth/me', { new_username: val });
        currentUser = { ...updated, has_username: true };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));
        updateUserUI();
        document.getElementById('editNicknameModal').classList.add('hidden');
        renderMessages();
        renderChatList();
    } catch (err) {
        document.getElementById('editNicknameStatus').textContent = err.message;
        document.getElementById('editNicknameStatus').className = 'nickname-status error';
    }
}

// ── Chats ─────────────────────────────────────────────────────────────────────
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

let dmFoundUser = null;
async function searchDMUser() {
    const val    = document.getElementById('dmUsernameInput').value.trim().replace(/^@/, '').toLowerCase();
    const result = document.getElementById('dmSearchResult');
    dmFoundUser  = null;
    if (!val) { result.innerHTML = ''; return; }

    try {
        const user = await api('GET', `/users/@${val}`);
        if (user.id === currentUser.id) {
            result.innerHTML = `<span class="dm-not-found">That's you 😄</span>`; return;
        }
        dmFoundUser = user;
        result.innerHTML = `
            <div class="dm-found-user">
                <span class="dm-avatar">${(user.display_name || user.username || '?')[0].toUpperCase()}</span>
                <span>@${user.username}</span>
            </div>`;
    } catch {
        result.innerHTML = `<span class="dm-not-found">User @${val} not found</span>`;
    }
}

async function createChatFromModal() {
    try {
        if (currentTab === 'dm') {
            if (!dmFoundUser) return;
            const chat = await api('POST', '/chats', { type: 'dm', member_ids: [dmFoundUser.id] });
            addOrUpdateChat(chat);
            closeCreateChatModal();
            selectChat(chat.id);
        } else {
            const name = document.getElementById('groupNameInput').value.trim();
            if (!name) return;
            const chat = await api('POST', '/chats', { type: 'group', name, member_ids: [] });
            addOrUpdateChat(chat);
            closeCreateChatModal();
            selectChat(chat.id);
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

function addOrUpdateChat(chat) {
    const idx = chats.findIndex(c => c.id === chat.id);
    if (idx === -1) chats.unshift(chat);
    else chats[idx] = chat;
    renderChatList();
}

async function loadChats() {
    try {
        chats = await api('GET', '/chats');
        renderChatList();
        if (chats.length > 0 && !currentChatId) {
            selectChat(chats[0].id);
        }
    } catch (err) {
        console.error('loadChats error', err);
    }
}

function renderChatList() {
    const chatList = document.getElementById('chatList');
    const query    = document.getElementById('chatSearch').value.trim().toLowerCase();
    chatList.innerHTML = '';

    chats
        .filter(c => !query || getChatName(c).toLowerCase().includes(query))
        .forEach(chat => {
            const msgs    = messages[chat.id] || [];
            const lastMsg = msgs[msgs.length - 1];
            // Messages are ciphertext — show placeholder or sender name
            const preview = lastMsg ? `${lastMsg.sender_name}: [message]` : 'No messages yet';
            const time    = lastMsg ? formatTime(lastMsg.created_at) : '';

            const item = document.createElement('div');
            item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');

            const avatar = document.createElement('div');
            avatar.className = 'chat-item-avatar';
            avatar.textContent = getChatName(chat).slice(0, 2).toUpperCase();

            const body = document.createElement('div');
            body.className = 'chat-item-body';
            body.innerHTML = `<div class="chat-item-title">${escapeHtml(getChatName(chat))}</div>
                              <div class="chat-item-subtitle">${escapeHtml(preview)}</div>`;

            const timeEl = document.createElement('div');
            timeEl.className = 'chat-item-time';
            timeEl.textContent = time;

            const delBtn = document.createElement('button');
            delBtn.className = 'chat-delete-btn';
            delBtn.title = 'Delete chat';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteChatModal(chat.id); });

            item.appendChild(avatar);
            item.appendChild(body);
            item.appendChild(timeEl);
            item.appendChild(delBtn);
            item.addEventListener('click', () => selectChat(chat.id));
            chatList.appendChild(item);
        });
}

function getChatName(chat) {
    if (chat.type === 'group') return chat.name || 'Group';
    // For DM: show the other person's name
    const other = (chat.members || []).find(m => m.id !== currentUser?.id);
    return other ? (other.display_name || '@' + other.username) : 'DM';
}

// ── Delete chat ───────────────────────────────────────────────────────────────
function openDeleteChatModal(chatId) {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    pendingDeleteChatId = chatId;
    document.getElementById('deleteChatName').textContent = `"${getChatName(chat)}" will be removed for you.`;
    document.getElementById('deleteChatModal').classList.remove('hidden');
}

async function confirmDeleteChat() {
    if (!pendingDeleteChatId) return;
    try {
        await api('DELETE', `/chats/${pendingDeleteChatId}`);
        chats = chats.filter(c => c.id !== pendingDeleteChatId);
        delete messages[pendingDeleteChatId];
        if (currentChatId === pendingDeleteChatId) {
            currentChatId = chats[0]?.id || null;
        }
        renderChatList();
        if (currentChatId) selectChat(currentChatId);
        else {
            document.querySelector('.chat-name').textContent = 'Select a chat';
            document.getElementById('messages').innerHTML = '';
            document.getElementById('messageInputContainer').style.display = 'none';
        }
    } catch (err) { alert('Error: ' + err.message); }
    document.getElementById('deleteChatModal').classList.add('hidden');
    pendingDeleteChatId = null;
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function selectChat(chatId) {
    currentChatId = chatId;
    renderChatList();
    document.querySelector('.chat-name').textContent = getChatName(chats.find(c => c.id === chatId) || {});
    document.getElementById('messageInputContainer').style.display = 'flex';

    // Load messages from server if not cached
    if (!messages[chatId]) {
        try {
            messages[chatId] = await api('GET', `/chats/${chatId}/messages`);
        } catch (err) {
            console.error('loadMessages error', err);
            messages[chatId] = [];
        }
    }
    renderMessages();
}

function renderMessages() {
    const container = document.getElementById('messages');
    container.innerHTML = '';
    if (!currentChatId || !messages[currentChatId]) return;

    messages[currentChatId].forEach(msg => {
        const isSent = msg.sender_id === currentUser?.id;
        const wrapper = document.createElement('div');
        wrapper.className = `message ${isSent ? 'sent' : 'received'}`;

        if (!isSent) {
            const senderEl = document.createElement('div');
            senderEl.className = 'message-sender';
            senderEl.textContent = msg.sender_name || 'User';
            wrapper.appendChild(senderEl);
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        // Note: ciphertext is shown as-is here.
        // To implement real E2E, decrypt with Web Crypto API before displaying.
        bubble.textContent = msg.ciphertext;
        wrapper.appendChild(bubble);

        const meta = document.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = formatTime(msg.created_at);
        wrapper.appendChild(meta);

        container.appendChild(wrapper);
    });
    container.scrollTop = container.scrollHeight;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text  = input.value.trim();
    if (!text || !currentChatId || !currentUser) return;
    input.value = '';

    // Note: for real E2E, encrypt text with recipient's public key here before sending.
    // For now ciphertext = plaintext (encryption layer can be added on top).
    try {
        const msg = await api('POST', `/chats/${currentChatId}/messages`, {
            ciphertext: text,
            iv: ''
        });
        // WS will deliver to others; add locally for instant feedback
        messages[currentChatId] = messages[currentChatId] || [];
        if (!messages[currentChatId].find(m => m.id === msg.id)) {
            messages[currentChatId].push(msg);
        }
        renderMessages();
        renderChatList();
    } catch (err) {
        alert('Failed to send: ' + err.message);
        input.value = text;
    }
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch() {
    const query = document.getElementById('chatSearch').value.trim().toLowerCase();
    const panel = document.getElementById('searchResults');

    if (!query) { panel.classList.add('hidden'); panel.innerHTML = ''; renderChatList(); return; }

    const chatHits = chats.filter(c => getChatName(c).toLowerCase().includes(query));
    const msgHits  = [];
    chats.forEach(chat => {
        (messages[chat.id] || []).forEach(msg => {
            if ((msg.ciphertext || '').toLowerCase().includes(query)) {
                msgHits.push({ chat, msg });
            }
        });
    });

    let html = '';
    if (chatHits.length) {
        html += `<div class="search-section-label">Chats</div>`;
        chatHits.forEach(c => {
            html += `<div class="search-hit" data-chat="${c.id}">
                       <span class="search-hit-title">${highlight(escapeHtml(getChatName(c)), query)}</span>
                     </div>`;
        });
    }
    if (msgHits.length) {
        html += `<div class="search-section-label">Messages</div>`;
        msgHits.slice(0, 20).forEach(({ chat, msg }) => {
            html += `<div class="search-hit" data-chat="${chat.id}">
                       <span class="search-hit-chat">${escapeHtml(getChatName(chat))}</span>
                       <span class="search-hit-msg">${highlight(escapeHtml(msg.ciphertext), query)}</span>
                     </div>`;
        });
    }
    if (!chatHits.length && !msgHits.length) {
        html = `<div class="search-empty">No results for "${escapeHtml(query)}"</div>`;
    }

    panel.innerHTML = html;
    panel.classList.remove('hidden');
    panel.querySelectorAll('.search-hit').forEach(el => {
        el.addEventListener('click', () => {
            selectChat(el.dataset.chat);
            document.getElementById('chatSearch').value = '';
            panel.classList.add('hidden'); panel.innerHTML = '';
            renderChatList();
        });
    });
}

function highlight(str, q) {
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return str.replace(re, '<mark>$1</mark>');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(ts) {
    const d = new Date(ts);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
