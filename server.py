# ============================================================
#  100gram — FastAPI backend
#  Auth: username + password (no phone/email)
#  DB: SQLite (file: 100gram.db)
#  Real-time: WebSockets
#  Encryption: passwords hashed with bcrypt
#              messages encrypted client-side (E2E),
#              server stores only ciphertext
# ============================================================
#
#  Установка:
#    pip install fastapi uvicorn[standard] sqlalchemy \
#                python-jose[cryptography] passlib[bcrypt] \
#                python-multipart aiofiles
#
#  Запуск:
#    uvicorn server:app --host 0.0.0.0 --port 8000 --reload
#
# ============================================================

from __future__ import annotations

import json
import uuid
import httpx
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import (
    Depends, FastAPI, HTTPException, WebSocket,
    WebSocketDisconnect, status
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey,
    String, Text, create_engine, Table, Integer
)
from sqlalchemy.orm import DeclarativeBase, Session, relationship, sessionmaker

# ── Config ────────────────────────────────────────────────────────────────────
SECRET_KEY  = "CHANGE_THIS_TO_A_LONG_RANDOM_STRING_IN_PRODUCTION"
ALGORITHM   = "HS256"
TOKEN_EXPIRE_DAYS = 30

# Тот же Client ID что в script.js
GOOGLE_CLIENT_ID  = "637219421031-95g7dthgs5n6jfecqqgrmtccbu0l6rtv.apps.googleusercontent.com"
GOOGLE_TOKEN_INFO = "https://oauth2.googleapis.com/tokeninfo"

DATABASE_URL = "sqlite:///./100gram.db"

# ── Database ──────────────────────────────────────────────────────────────────
engine       = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


# Many-to-many: chat members
chat_members = Table(
    "chat_members", Base.metadata,
    Column("chat_id",   String, ForeignKey("chats.id"),   primary_key=True),
    Column("user_id",   String, ForeignKey("users.id"),   primary_key=True),
)


class User(Base):
    __tablename__ = "users"
    id            = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    username      = Column(String, unique=True, nullable=False, index=True)
    display_name  = Column(String, nullable=True)
    hashed_pw     = Column(String, nullable=False)
    google_id     = Column(String, unique=True, nullable=True, index=True)  # Google sub
    # Client's public key for E2E (X25519, base64)
    public_key    = Column(Text, nullable=True)
    created_at    = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    chats         = relationship("Chat", secondary=chat_members, back_populates="members")
    messages      = relationship("Message", back_populates="sender")


class Chat(Base):
    __tablename__  = "chats"
    id             = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    type           = Column(String, nullable=False)   # "dm" | "group"
    name           = Column(String, nullable=True)    # group name
    created_by     = Column(String, ForeignKey("users.id"), nullable=False)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    members        = relationship("User", secondary=chat_members, back_populates="chats")
    messages       = relationship("Message", back_populates="chat",
                                  order_by="Message.created_at")


class Message(Base):
    __tablename__  = "messages"
    id             = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    chat_id        = Column(String, ForeignKey("chats.id"), nullable=False, index=True)
    sender_id      = Column(String, ForeignKey("users.id"), nullable=False)
    # Ciphertext from client (E2E). Server never sees plaintext.
    ciphertext     = Column(Text, nullable=False)
    # IV / nonce used for AES-GCM (sent alongside ciphertext)
    iv             = Column(String, nullable=True)
    created_at     = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    chat           = relationship("Chat", back_populates="messages")
    sender         = relationship("User", back_populates="messages")


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Auth helpers ──────────────────────────────────────────────────────────────
pwd_ctx   = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2    = OAuth2PasswordBearer(tokenUrl="/auth/login")


def hash_password(pw: str) -> str:
    return pwd_ctx.hash(pw)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2), db: Session = Depends(get_db)) -> User:
    exc = HTTPException(status_code=401, detail="Invalid token")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if not user_id:
            raise exc
    except JWTError:
        raise exc
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise exc
    return UserOut.from_user(user)


# ── Pydantic schemas ──────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    username:     str
    password:     str
    display_name: Optional[str] = None
    public_key:   Optional[str] = None   # X25519 public key (base64)


class UserOut(BaseModel):
    id:           str
    username:     str
    display_name: Optional[str]
    public_key:   Optional[str]
    google_id:    Optional[str] = None
    has_username: bool = False   # True if username was manually set (not auto-generated)

    class Config:
        from_attributes = True

    @classmethod
    def from_user(cls, user: "User") -> "UserOut":
        # has_username = True if username doesn't look like auto-generated "user_XXXXXXXX"
        import re
        auto = bool(re.match(r'^user_[a-z0-9]{8}_*$', user.username or ''))
        return cls(
            id           = user.id,
            username     = user.username,
            display_name = user.display_name,
            public_key   = user.public_key,
            google_id    = user.google_id,
            has_username = not auto,
        )


class TokenOut(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    user:         UserOut


class CreateChatIn(BaseModel):
    type:        str              # "dm" | "group"
    name:        Optional[str]   # required for group
    member_ids:  list[str]       # user IDs to add (besides self)


class ChatOut(BaseModel):
    id:         str
    type:       str
    name:       Optional[str]
    members:    list[UserOut]
    created_at: datetime

    class Config:
        from_attributes = True


class SendMessageIn(BaseModel):
    ciphertext: str   # base64 AES-GCM ciphertext
    iv:         str   # base64 nonce


class MessageOut(BaseModel):
    id:          str
    chat_id:     str
    sender_id:   str
    sender_name: str
    ciphertext:  str
    iv:          Optional[str]
    created_at:  datetime

    class Config:
        from_attributes = True


class UpdateProfileIn(BaseModel):
    display_name: Optional[str] = None
    public_key:   Optional[str] = None
    new_username: Optional[str] = None


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="100gram API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://otkamen.github.io",   # ← ваш GitHub Pages домен
        "http://localhost:8080",        # для локальной разработки
        "http://localhost:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── WebSocket connection manager ──────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        # user_id → list of active WebSocket connections
        self._connections: dict[str, list[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self._connections.setdefault(user_id, []).append(ws)

    def disconnect(self, user_id: str, ws: WebSocket):
        conns = self._connections.get(user_id, [])
        if ws in conns:
            conns.remove(ws)

    async def send_to_user(self, user_id: str, payload: dict):
        for ws in self._connections.get(user_id, []):
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                pass

    async def broadcast_to_chat(self, chat: Chat, payload: dict):
        for member in chat.members:
            await self.send_to_user(member.id, payload)


manager = ConnectionManager()


# ── Auth routes ───────────────────────────────────────────────────────────────
@app.post("/auth/register", response_model=TokenOut)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    # Username: lowercase, 3-20 chars, a-z0-9_
    username = data.username.strip().lower()
    if not username or len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if not all(c.isalnum() or c == "_" for c in username):
        raise HTTPException(400, "Username may only contain a-z, 0-9, _")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "Username already taken")

    user = User(
        username     = username,
        display_name = data.display_name or username,
        hashed_pw    = hash_password(data.password),
        public_key   = data.public_key,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(access_token=create_token(user.id), user=UserOut.from_user(user))


@app.post("/auth/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form.username.lower()).first()
    if not user or not verify_password(form.password, user.hashed_pw):
        raise HTTPException(401, "Invalid username or password")
    return TokenOut(access_token=create_token(user.id), user=UserOut.from_user(user))


@app.get("/auth/me", response_model=UserOut)
def me(current: User = Depends(get_current_user)):
    return UserOut.from_user(current)


# ── Google Sign-In ────────────────────────────────────────────────────────────
class GoogleAuthIn(BaseModel):
    credential: str   # Google ID token (JWT from GSI)


@app.post("/auth/google", response_model=TokenOut)
async def google_auth(data: GoogleAuthIn, db: Session = Depends(get_db)):
    # Verify token with Google
    async with httpx.AsyncClient() as client:
        resp = await client.get(GOOGLE_TOKEN_INFO, params={"id_token": data.credential})

    if resp.status_code != 200:
        raise HTTPException(401, "Invalid Google token")

    info = resp.json()

    # Check audience matches our client ID
    if info.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(401, "Token audience mismatch")

    google_id    = info["sub"]
    google_name  = info.get("name") or info.get("email", "User")

    # Find existing user by google_id, or create new one
    user = db.query(User).filter(User.google_id == google_id).first()

    if not user:
        # New user — create with placeholder username, will be set via /auth/me PATCH
        # Generate temp unique username from google_id
        temp_username = "user_" + google_id[-8:]
        # Make sure it's unique
        while db.query(User).filter(User.username == temp_username).first():
            temp_username += "_"

        user = User(
            username     = temp_username,
            display_name = google_name,
            hashed_pw    = hash_password(uuid.uuid4().hex),  # random, never used
            google_id    = google_id,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    return TokenOut(access_token=create_token(user.id), user=UserOut.from_user(user))


@app.patch("/auth/me", response_model=UserOut)
def update_profile(
    data: UpdateProfileIn,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    if data.new_username:
        new_un = data.new_username.strip().lower()
        if new_un != current.username:
            if db.query(User).filter(User.username == new_un).first():
                raise HTTPException(409, "Username already taken")
            current.username = new_un
    if data.display_name is not None:
        current.display_name = data.display_name
    if data.public_key is not None:
        current.public_key = data.public_key
    db.commit()
    db.refresh(current)
    return UserOut.from_user(current)


# ── User lookup ───────────────────────────────────────────────────────────────
@app.get("/users/@{username}", response_model=UserOut)
def get_user_by_username(username: str, db: Session = Depends(get_db),
                         _: User = Depends(get_current_user)):
    user = db.query(User).filter(User.username == username.lower()).first()
    if not user:
        raise HTTPException(404, "User not found")
    return UserOut.from_user(user)


# ── Chat routes ───────────────────────────────────────────────────────────────
@app.post("/chats", response_model=ChatOut, status_code=201)
def create_chat(
    data: CreateChatIn,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    if data.type not in ("dm", "group"):
        raise HTTPException(400, "type must be 'dm' or 'group'")
    if data.type == "group" and not data.name:
        raise HTTPException(400, "Group chats require a name")

    # For DM: prevent duplicates
    if data.type == "dm":
        if len(data.member_ids) != 1:
            raise HTTPException(400, "DM requires exactly one other member")
        other_id = data.member_ids[0]
        # Check if DM already exists between these two users
        existing = (
            db.query(Chat)
            .filter(Chat.type == "dm")
            .join(chat_members, Chat.id == chat_members.c.chat_id)
            .filter(chat_members.c.user_id == current.id)
            .all()
        )
        for ch in existing:
            member_ids = {m.id for m in ch.members}
            if member_ids == {current.id, other_id}:
                return ch

    members = [current]
    for uid in data.member_ids:
        u = db.query(User).filter(User.id == uid).first()
        if not u:
            raise HTTPException(404, f"User {uid} not found")
        if u.id != current.id:
            members.append(u)

    chat = Chat(type=data.type, name=data.name, created_by=current.id, members=members)
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


@app.get("/chats", response_model=list[ChatOut])
def list_chats(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    return current.chats


@app.delete("/chats/{chat_id}", status_code=204)
def delete_chat(
    chat_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    chat = db.query(Chat).filter(Chat.id == chat_id).first()
    if not chat:
        raise HTTPException(404, "Chat not found")
    if current not in chat.members:
        raise HTTPException(403, "Not a member")
    # Remove current user from chat
    chat.members.remove(current)
    # If no members left — delete chat entirely
    if not chat.members:
        db.delete(chat)
    db.commit()


# ── Message routes ────────────────────────────────────────────────────────────
@app.get("/chats/{chat_id}/messages", response_model=list[MessageOut])
def get_messages(
    chat_id: str,
    limit: int = 100,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    chat = db.query(Chat).filter(Chat.id == chat_id).first()
    if not chat or current not in chat.members:
        raise HTTPException(403, "Access denied")
    msgs = (
        db.query(Message)
        .filter(Message.chat_id == chat_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
        .all()
    )
    msgs.reverse()
    return [_msg_out(m) for m in msgs]


@app.post("/chats/{chat_id}/messages", response_model=MessageOut, status_code=201)
async def send_message(
    chat_id: str,
    data: SendMessageIn,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    chat = db.query(Chat).filter(Chat.id == chat_id).first()
    if not chat or current not in chat.members:
        raise HTTPException(403, "Access denied")

    msg = Message(
        chat_id    = chat_id,
        sender_id  = current.id,
        ciphertext = data.ciphertext,
        iv         = data.iv,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Push to all chat members via WebSocket
    payload = {"type": "new_message", "message": _msg_out(msg).__dict__}
    # Serialize datetime manually
    payload["message"]["created_at"] = msg.created_at.isoformat()
    await manager.broadcast_to_chat(chat, payload)

    return _msg_out(msg)


def _msg_out(m: Message) -> MessageOut:
    return MessageOut(
        id          = m.id,
        chat_id     = m.chat_id,
        sender_id   = m.sender_id,
        sender_name = m.sender.display_name or m.sender.username,
        ciphertext  = m.ciphertext,
        iv          = m.iv,
        created_at  = m.created_at,
    )


# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str, db: Session = Depends(get_db)):
    # Authenticate via token in URL
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id  = payload.get("sub")
        user     = db.query(User).filter(User.id == user_id).first()
        if not user:
            await websocket.close(code=4001)
            return
    except JWTError:
        await websocket.close(code=4001)
        return

    await manager.connect(user_id, websocket)
    try:
        while True:
            # Keep connection alive; client can send pings
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(user_id, websocket)


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}
