// 100gram - Google Sign-In (Google Identity Services) + per-user chat storage

const GOOGLE_CLIENT_ID = '637219421031-95g7dthgs5n6jfecqqgrmtccbu0l6rtv.apps.googleusercontent.com';

let currentUser = null;
let currentChatId = null;
let chats = [];
let messages = {};

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
    document.getElementById('chatSearch').addEventListener('input', renderChatList);
    document.getElementById('authButton').addEventListener('click', () => {
        if (currentUser) {
            logout();
        } else {
            showLoginOverlay('Sign in with Google to access your chats.');
            google.accounts.id.prompt();
        }
    });
}

let _googleInitAttempts = 0;

function initGoogleSignIn() {
    if (!window.google?.accounts?.id) {
        _googleInitAttempts += 1;
        if (_googleInitAttempts < 10) {
            setTimeout(initGoogleSignIn, 200);
            return;
        }

        showLoginOverlay('Google Sign-In failed to load. Check your connection.');
        return;
    }

    if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('YOUR')) {
        showLoginOverlay('Set GOOGLE_CLIENT_ID in js/script.js to enable Google Sign-In.');
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
        const token = response.credential;
        const payload = parseJwt(token);

        currentUser = {
            id: payload.sub,
            name: payload.name || payload.email || 'User'
        };

        saveCurrentUser();
        updateUserUI();
        showApp();
        loadChats();
    } catch (err) {
        console.error('Google sign-in parsing error', err);
        showLoginOverlay('Sign in failed. Please try again.');
    }
}

function parseJwt(token) {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
        atob(base64)
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
    );
    return JSON.parse(jsonPayload);
}

function loadCurrentUser() {
    const stored = localStorage.getItem('currentUser');
    if (!stored) return;

    try {
        currentUser = JSON.parse(stored);
    } catch (err) {
        console.warn('Invalid stored user, clearing');
        localStorage.removeItem('currentUser');
    }
}

function saveCurrentUser() {
    if (!currentUser) return;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
}

function logout() {
    currentUser = null;
    currentChatId = null;
    chats = [];
    messages = {};
    localStorage.removeItem('currentUser');
    google.accounts.id.disableAutoSelect();
    updateUserUI();
    showLoginOverlay('Signed out. Sign in again to restore your chats.');
}

function showLoginOverlay(message) {
    const overlay = document.getElementById('authOverlay');
    if (message) {
        overlay.querySelector('.auth-message').textContent = message;
    }
    overlay.classList.remove('hidden');
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('app').style.display = 'flex';
    document.getElementById('authOverlay').classList.add('hidden');
}

function updateUserUI() {
    const authButton = document.getElementById('authButton');
    const userInfo = document.getElementById('userInfo');

    if (currentUser) {
        authButton.textContent = 'Sign out';
        userInfo.textContent = currentUser.name || currentUser.id;
    } else {
        authButton.textContent = 'Sign in';
        userInfo.textContent = 'Not signed in';
    }
}

function onCreateChatClick() {
    if (!currentUser) {
        showLoginOverlay('Sign in to create chats.');
        return;
    }
    openCreateChatModal();
}

function openCreateChatModal() {
    const modal = document.getElementById('newChatModal');
    modal.classList.remove('hidden');
    document.getElementById('newChatName').value = '';
    document.getElementById('newChatName').focus();
}

function closeCreateChatModal() {
    const modal = document.getElementById('newChatModal');
    modal.classList.add('hidden');
}

function createChatFromModal() {
    const nameInput = document.getElementById('newChatName');
    const chatName = nameInput.value.trim();
    if (!chatName) return;

    const chatId = Date.now().toString();
    const newChat = { id: chatId, name: chatName };
    chats.push(newChat);
    messages[chatId] = [];
    saveChats();

    renderChatList();
    selectChat(chatId);
    closeCreateChatModal();
}

function loadChats() {
    if (!currentUser) return;

    const userChatsKey = `chats_${currentUser.id}`;
    const storedChats = localStorage.getItem(userChatsKey);
    if (storedChats) {
        chats = JSON.parse(storedChats);
    }

    const userMessagesKey = `messages_${currentUser.id}`;
    const storedMessages = localStorage.getItem(userMessagesKey);
    if (storedMessages) {
        messages = JSON.parse(storedMessages);
    }

    if (chats.length === 0) {
        const chatId = Date.now().toString();
        chats.push({ id: chatId, name: 'General' });
        messages[chatId] = messages[chatId] || [];
        saveChats();
        saveMessages();
    }

    if (!currentChatId) {
        currentChatId = chats[0].id;
    }

    renderChatList();
    selectChat(currentChatId);
}

function saveChats() {
    if (!currentUser) return;
    const userChatsKey = `chats_${currentUser.id}`;
    localStorage.setItem(userChatsKey, JSON.stringify(chats));
}

function saveMessages() {
    if (!currentUser) return;
    const userMessagesKey = `messages_${currentUser.id}`;
    localStorage.setItem(userMessagesKey, JSON.stringify(messages));
}

function renderChatList() {
    const chatList = document.querySelector('.chat-list');
    const searchQuery = document.getElementById('chatSearch').value.trim().toLowerCase();

    chatList.innerHTML = '';
    chats
        .filter((chat) => chat.name.toLowerCase().includes(searchQuery))
        .forEach((chat) => {
            const lastMessage = (messages[chat.id] || []).slice(-1)[0];
            const preview = lastMessage ? lastMessage.text : 'No messages yet';
            const time = lastMessage ? formatTime(lastMessage.timestamp) : '';

            const chatItem = document.createElement('div');
            chatItem.className = 'chat-item';
            if (chat.id === currentChatId) {
                chatItem.classList.add('active');
            }

            const avatar = document.createElement('div');
            avatar.className = 'chat-item-avatar';
            avatar.textContent = chat.name.slice(0, 2).toUpperCase();

            const body = document.createElement('div');
            body.className = 'chat-item-body';

            const title = document.createElement('div');
            title.className = 'chat-item-title';
            title.textContent = chat.name;

            const subtitle = document.createElement('div');
            subtitle.className = 'chat-item-subtitle';
            subtitle.textContent = preview;

            body.appendChild(title);
            body.appendChild(subtitle);

            const timeEl = document.createElement('div');
            timeEl.className = 'chat-item-time';
            timeEl.textContent = time;

            chatItem.appendChild(avatar);
            chatItem.appendChild(body);
            chatItem.appendChild(timeEl);

            chatItem.addEventListener('click', () => selectChat(chat.id));
            chatList.appendChild(chatItem);
        });
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

function selectChat(chatId) {
    currentChatId = chatId;
    renderChatList();
    loadMessages();
    document.querySelector('.chat-name').textContent = chats.find((c) => c.id === chatId).name;
    document.getElementById('messageInputContainer').style.display = 'flex';
}

function loadMessages() {
    const messagesContainer = document.querySelector('.messages');
    messagesContainer.innerHTML = '';

    if (!currentChatId || !messages[currentChatId]) {
        document.getElementById('messageInputContainer').style.display = 'none';
        return;
    }

    messages[currentChatId].forEach((msg) => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${msg.sender === currentUser.id ? 'sent' : 'received'}`;

        const senderDiv = document.createElement('div');
        senderDiv.className = 'message-sender';
        senderDiv.textContent = msg.senderName || (msg.sender === currentUser.id ? currentUser.name : 'Unknown');

        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';
        bubbleDiv.textContent = msg.text;

        messageDiv.appendChild(senderDiv);
        messageDiv.appendChild(bubbleDiv);
        messagesContainer.appendChild(messageDiv);
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const messageText = messageInput.value.trim();
    if (messageText === '' || !currentChatId || !currentUser) return;

    const newMessage = {
        text: messageText,
        sender: currentUser.id,
        senderName: currentUser.name,
        timestamp: Date.now()
    };

    messages[currentChatId] = messages[currentChatId] || [];
    messages[currentChatId].push(newMessage);
    saveMessages();
    loadMessages();
    messageInput.value = '';
}
