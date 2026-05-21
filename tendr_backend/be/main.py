from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Depends, HTTPException, status, Request, Body
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timedelta
from jose import jwt
import models
import os
from models import User, Task, Base, FocusSession
from database import SessionLocal, engine
import task_crud
import pet_crud
import auth_crud
from forget_password import to_confirm_email
import stats
from auth import pwd_context
from auth_crud import SECRET_KEY, ALGORITHM
from auth_dependencies import get_current_user
from schemas import (
    TaskCreate, TaskResponse, TaskCompletionUpdate,
    PetCreate, PetUpdate, PetResponse, PetFeed,
    RegistrationUser, TokenResponse, DeleteAccountRequest, EmailVerificationRequest, ForgotPasswordRequest,
    FocusSessionCreate, FocusSessionResponse, GoogleCompleteRegistrationRequest, DeleteAccountOtpRequest
)
from starlette.responses import RedirectResponse, HTMLResponse
from starlette.middleware.sessions import SessionMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from oauth import oauth
import uuid
import urllib.parse

# ---------------------------------------------------
# DATABASE & APP SETUP
# ---------------------------------------------------

from sqlalchemy import text, func

# Emergency schema update for Render (since we added 'theme' column)
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE "user" ADD COLUMN theme VARCHAR DEFAULT \'light\''))
        conn.commit()
    except Exception:
        pass # Column already exists

# Add category column to tasks table
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE tasks ADD COLUMN category VARCHAR(50)'))
        conn.commit()
    except Exception:
        pass  # Column already exists

# Fix focus_sessions table — the original raw SQL used SERIAL/INTEGER types which are
# incompatible with the SQLAlchemy model (String UUID). Drop the table if it has wrong
# column types so create_all can recreate it correctly.
with engine.connect() as conn:
    try:
        result = conn.execute(text("""
            SELECT data_type FROM information_schema.columns
            WHERE table_name = 'focus_sessions' AND column_name = 'id'
        """))
        row = result.fetchone()
        if row and row[0] not in ('character varying', 'text', 'uuid'):
            conn.execute(text('DROP TABLE IF EXISTS focus_sessions'))
            conn.commit()
    except Exception:
        pass

# Add completed_at to tasks
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE tasks ADD COLUMN completed_at TIMESTAMP DEFAULT NULL'))
        conn.commit()
    except Exception:
        pass

# Add due_date to tasks
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE tasks ADD COLUMN due_date DATE DEFAULT NULL'))
        conn.commit()
    except Exception:
        pass

# Add points column to tasks and backfill from priority
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE tasks ADD COLUMN points INTEGER DEFAULT NULL'))
        conn.commit()
    except Exception:
        pass
with engine.connect() as conn:
    try:
        conn.execute(text("""
            UPDATE tasks SET points = CASE
                WHEN lower(priority) = 'high'   THEN 25
                WHEN lower(priority) = 'medium' THEN 15
                ELSE 10
            END
            WHERE points IS NULL
        """))
        conn.commit()
    except Exception:
        pass

# Add gender to pets
with engine.connect() as conn:
    try:
        conn.execute(text("ALTER TABLE pets ADD COLUMN gender VARCHAR(10) DEFAULT NULL"))
        conn.commit()
    except Exception:
        pass

# Add bond + last_focused_at to pets
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE pets ADD COLUMN bond FLOAT DEFAULT 0.0'))
        conn.commit()
    except Exception:
        pass
with engine.connect() as conn:
    try:
        conn.execute(text('ALTER TABLE pets ADD COLUMN last_focused_at TIMESTAMP DEFAULT NOW()'))
        conn.commit()
    except Exception:
        pass

# Create pet_qualifying_days table
with engine.connect() as conn:
    try:
        conn.execute(text('''
            CREATE TABLE IF NOT EXISTS pet_qualifying_days (
                id VARCHAR PRIMARY KEY,
                pet_id VARCHAR REFERENCES pets(id) ON DELETE CASCADE,
                user_id VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(pet_id, date)
            )
        '''))
        conn.commit()
    except Exception:
        pass

models.Base.metadata.create_all(bind=engine)

app = FastAPI()

app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

_is_production = not (os.getenv("RENDER") is None and os.getenv("ENV") != "production")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SECRET_KEY", "dev-secret"),
    same_site="none" if _is_production else "lax",
    https_only=_is_production,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tendr-tick-treats.onrender.com",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


login_sessions = {}   

#if the fe is web application then there is no needd for this local_sessions dict and the start_google_login function and google_login_status function remove them both entirely..

# ---------------------------------------------------
# DEPENDENCY
# ---------------------------------------------------

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.get("/")
def read_root():
    return {"message": "This is Task Manager side of our app Tendr!!"}

@app.head("/health")
def health():
    return {"status": "ok"}

@app.get("/debug/session")
def debug_session(request: Request):
    return {
        "session_keys": list(request.session.keys()),
        "cookies": request.cookies,
        "is_https": request.url.scheme == "https"
    }


@app.get("/user/xp")
def get_user_xp(current_user = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get current user's XP"""
    user = db.query(User).filter(User.id == current_user.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Initialize XP to 100 if None
    if user.xp is None:
        user.xp = 100
        db.commit()
    return {"xp": user.xp}


# ---------------------------------------------------
# TASK ROUTES
# ---------------------------------------------------

@app.post("/tasks", response_model=None)
def create_task_endpoint(task: TaskCreate,current_user= Depends(get_current_user),db: Session = Depends(get_db)):
    task = task_crud.create_task(db, task.title, task.priority, current_user, task.category, task.due_date)
    if not task:
        raise HTTPException(status_code=400, detail="Task creation failed")
    return TaskResponse.model_validate(task)


@app.get("/tasks", response_model=list[TaskResponse])
def get_all_tasks_endpoint(current_user= Depends(get_current_user),db: Session = Depends(get_db)):
    tasks = db.query(Task).filter(Task.user_id == current_user.id).all()
    if not tasks:
        return []
    return [TaskResponse.model_validate({
        "id": t.id, "title": t.title, "priority": t.priority,
        "category": t.category, "completed": t.completed,
        "created_at": t.created_at, "completed_at": t.completed_at,
        "due_date": t.due_date, "user_id": t.user_id,
        "points": t.points,
        "xpReward": task_crud.compute_effective_points(t),
    }) for t in tasks]


@app.put("/tasks/{title}", response_model=TaskResponse)
def update_task_endpoint(
    title: str,
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    task = task_crud.update_task(db, title, current_user)
    if not task:
        raise HTTPException(status_code=400, detail="Updating Task Failed")
    return TaskResponse.model_validate(task)


@app.patch("/tasks/{task_id}", response_model=TaskResponse)
def update_task_completion_endpoint(
    task_id: str,
    task_update: TaskCompletionUpdate,
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    task_data = task_crud.update_task_completion(db, task_id, task_update.completed, current_user)
    if not task_data:
        raise HTTPException(status_code=404, detail="Task not found")
    
    print("Task completion data:", task_data)
    
    return task_data



@app.delete("/tasks/{task_id}")
def delete_task_by_id_endpoint(
    task_id: str,
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    result = task_crud.delete_task_by_id(db, task_id, current_user)
    if result is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"message": "Task deleted successfully"}


# ---------------------------------------------------
# PET ROUTES
# ---------------------------------------------------

@app.post("/pets", response_model=PetResponse)
def create_pet_endpoint(
    pet: PetCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    pet_data = pet_crud.create_pet(db, pet.name, pet.type, current_user, pet.gender)
    if not pet_data:
        raise HTTPException(status_code=400, detail="Pet creation failed")
    return pet_data



@app.get("/pet", response_model=list[PetResponse])
def get_all_pets_endpoint(
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    pets = pet_crud.get_all_pets(db, current_user)
    return [PetResponse.model_validate(p) for p in pets]




@app.put("/pet/{id}", response_model=PetResponse)
def update_pet_endpoint(
    pet_update: PetUpdate,
    id: str,
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    pet = pet_crud.update_pet(
        db, id, pet_update.hunger, pet_update.age,
        pet_update.last_fed, current_user
    )
    if not pet:
        raise HTTPException(status_code=400, detail="Pet Updating Failed")
    return PetResponse.model_validate(pet)


@app.patch("/pet/feed/{id}", response_model=PetResponse)
def feed_pet_endpoint(id: str, db: Session = Depends(get_db), current_user= Depends(get_current_user)):
    pet_data = pet_crud.feed_pet(db, id, current_user)
    if not pet_data:
        raise HTTPException(status_code=400, detail="Feeding pet failed")
    return pet_data

@app.delete("/pet/{id}")
def delete_pet_endpoint(
    id: str,
    current_user= Depends(get_current_user),
    db: Session = Depends(get_db)
):
    result = pet_crud.delete_pet(db, id, current_user)
    if result is None:
        raise HTTPException(status_code=404, detail="Pet not found")
    return {"message": "Pet deleted successfully"}


# ---------------------------------------------------
# AUTH ROUTES (LOGIN / PASSWORD / OTP)
# ---------------------------------------------------

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


@app.get("/auth/google/login")
async def google_login(request: Request, desktop_port: int = None):
    if desktop_port:
        request.session["desktop_port"] = desktop_port
    redirect_uri = request.url_for("google_callback")

    # Force the redirect URI to use HTTPS on Render or localhost for dev
    if "onrender.com" in str(request.url):
        redirect_uri = str(redirect_uri).replace("http://", "https://")
    else:
        # Crucial for local dev: Force localhost to match cookie domain
        redirect_uri = str(redirect_uri).replace("127.0.0.1", "localhost")

    print(f"Starting Google Login, redirecting to: {redirect_uri}")
    return await oauth.google.authorize_redirect(request, redirect_uri)

# @app.get("/login/google/start")
# def start_google_login(request:Request):     
#     session_id = str(uuid.uuid4())
#     login_sessions[session_id] = { "status": "pending", "jwt": None }
#     login_url = request.url_for("google_login") + f"?session_id={session_id}"
#     return {
#         "session_id":session_id,
#         "login_url":login_url
#     }


@app.get("/auth/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):
    print(f"DEBUG: Google Callback hit. URL: {request.url}")
    # Standardize callback URL to match login (must be identical)
    redirect_uri = request.url_for("google_callback")
    if "onrender.com" in str(request.url):
        redirect_uri = str(redirect_uri).replace("http://", "https://")
    else:
        redirect_uri = str(redirect_uri).replace("127.0.0.1", "localhost")

    print(f"Callback received. Session state keys: {list(request.session.keys())}")
    
    try:
        # Authlib 1.6+ automatically handles redirect_uri via the request and session state
        # We print what we expect just for debugging, but we do NOT pass it to avoid TypeError
        print(f"DEBUG: Expected redirect_uri: {redirect_uri}")
        token = await oauth.google.authorize_access_token(request)
    except Exception as e:
        print(f"OAuth Error: {str(e)}")
        raise e

    # S2: Extract user info from Google
    user_info = token.get("userinfo")
    if user_info is None:
        user_info = await oauth.google.parse_id_token(request, token)

    # Debug print
    print("Google user info:", user_info)
    
#extract email, sub
    user_email = user_info["email"]
    user_sub = user_info["sub"]
    
    # Check if the desktop app initiated this flow
    desktop_port = request.session.pop("desktop_port", None)

    # Dynamic frontend URL
    if desktop_port:
        frontend_url = f"http://localhost:{desktop_port}"
    elif "localhost" in str(request.url) or "127.0.0.1" in str(request.url):
        frontend_url = "http://localhost:5173"
    else:
        frontend_url = "https://tendr-tick-treats.onrender.com"

    user = db.query(User).filter(User.email == user_email).first()

    if not user:
        # New user — issue a short-lived pending token and let them pick a username
        pending_data = {
            "type": "google_pending",
            "email": user_email,
            "google_sub": user_sub,
        }
        pending_token = auth_crud.create_access_token(pending_data, expires_delta=timedelta(minutes=10))
        if desktop_port:
            redirect_url = (f"{frontend_url}?pending_token={pending_token}"
                            f"&email={urllib.parse.quote(user_email)}")
        else:
            redirect_url = f"{frontend_url}/choose-username?pending_token={pending_token}"
        print(f"New Google user {user_email} — redirecting to choose-username")
        return RedirectResponse(redirect_url)

    # Returning user — issue normal auth token
    data = { "sub": user.username }
    jwt_token = auth_crud.create_access_token(data, expires_delta=timedelta(days=7))

    encoded_username = urllib.parse.quote(user.username)
    encoded_email = urllib.parse.quote(user.email)
    if desktop_port:
        redirect_url = (f"{frontend_url}?token={jwt_token}"
                        f"&username={encoded_username}&email={encoded_email}")
    else:
        redirect_url = f"{frontend_url}/login?token={jwt_token}&username={encoded_username}&email={encoded_email}"

    print(f"Returning Google user {user.username} — redirecting to login")
    return RedirectResponse(redirect_url)

@app.post("/auth/google/complete-registration")
def complete_google_registration(body: GoogleCompleteRegistrationRequest, db: Session = Depends(get_db)):
    from jose import JWTError

    try:
        payload = jwt.decode(body.pending_token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=400, detail="Invalid or expired registration token. Please sign in with Google again.")

    if payload.get("type") != "google_pending":
        raise HTTPException(status_code=400, detail="Invalid token type.")

    user_email = payload.get("email")
    user_sub = payload.get("google_sub")

    if not user_email or not user_sub:
        raise HTTPException(status_code=400, detail="Invalid token payload.")

    username = body.username.strip()

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")
    if len(username) > 30:
        raise HTTPException(status_code=400, detail="Username must be at most 30 characters.")
    if not all(c.isalnum() or c in "_-" for c in username):
        raise HTTPException(status_code=400, detail="Username may only contain letters, numbers, underscores, and hyphens.")

    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="Username already taken. Please choose another.")

    # Guard against double-submission — user may already exist if they hit this twice
    existing = db.query(User).filter(User.email == user_email).first()
    if existing:
        data = {"sub": existing.username}
        jwt_token = auth_crud.create_access_token(data, expires_delta=timedelta(days=7))
        return {"token": jwt_token, "username": existing.username, "email": existing.email}

    new_user = User(
        username=username,
        hashed_password="",
        email=user_email,
        user_verified=True,
        start_acc_time=datetime.utcnow(),
        provider="google",
        provider_id=user_sub,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    data = {"sub": new_user.username}
    jwt_token = auth_crud.create_access_token(data, expires_delta=timedelta(days=7))
    return {"token": jwt_token, "username": new_user.username, "email": new_user.email}


def _authenticate_form(form_data: OAuth2PasswordRequestForm, db: Session):
    """Shared logic for /login and /token — username field accepts email or username."""
    identifier = form_data.username
    password = form_data.password

    if '@' in identifier:
        user = auth_crud.authenticate_user(db, '', identifier, password)
    else:
        user = auth_crud.authenticate_user(db, identifier, '', password)

    if user == "unverified":
        raise HTTPException(status_code=403, detail="Please verify your email before logging in. Check your inbox for the verification code.")
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.provider == "google" and not user.hashed_password:
        raise HTTPException(status_code=400, detail="This account uses Google login. Use 'Forgot Password' to set a password.")

    data = {"sub": user.username}
    token = auth_crud.create_access_token(data, expires_delta=timedelta(days=7))
    return {"access_token": token, "token_type": "bearer", "username": user.username, "email": user.email}


@app.post("/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    return _authenticate_form(form_data, db)


@app.post("/token", response_model=TokenResponse)
def token(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """Swagger Authorize endpoint — username field accepts email or username."""
    return _authenticate_form(form_data, db)


@app.patch("/reset_password")
def password_reset_endpoint(
    new_password: str,
    new_password_confirm: str,
    old_password: str,
    username: str,
    db: Session = Depends(get_db)
):
    reset = auth_crud.password_reset(db, new_password, new_password_confirm, old_password, username)
    if not reset:
        raise HTTPException(status_code=400, detail="Password reset failed")
    return {"message": "Password reset successful!"}


@app.post("/send_forgot_password_otp")
def send_forgot_password_otp(email: str, db: Session = Depends(get_db)):
    result = to_confirm_email(db, email)
    if not result:
        raise HTTPException(status_code=404, detail="Email not found")
    return {"message": "OTP sent to your email"}


@app.patch("/forgot_password")
def forgot_password_endpoint(
    data: ForgotPasswordRequest,
    db: Session = Depends(get_db)
):
    forget = auth_crud.forgot_password(db, data.entered_verify_code, data.new_password, data.new_password_confirm, data.username)
    if not forget:
        raise HTTPException(status_code=400, detail="Forget password reset failed")
    return {"message": "Forget password reset done!"}


@app.delete("/delete_account")
def delete_account(data: DeleteAccountRequest,db: Session = Depends(get_db),current_user = Depends(get_current_user)):
    result = auth_crud.del_user(db, current_user.id, data.password)
    if not result:
        raise HTTPException(status_code=404, detail="user not found")
    return {"message": "user account deleted successfully"}


@app.get("/user/provider")
def get_user_provider(current_user = Depends(get_current_user)):
    return {"provider": current_user.provider}


@app.delete("/delete_account_otp")
def delete_account_with_otp(
    data: DeleteAccountOtpRequest,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user),
):
    if current_user.provider != "google":
        raise HTTPException(status_code=400, detail="This endpoint is only for Google-linked accounts.")

    otp = data.otp.strip()
    if not otp:
        raise HTTPException(status_code=400, detail="OTP is required.")
    if otp != current_user.user_verification_token:
        raise HTTPException(status_code=400, detail="Incorrect OTP.")
    if (
        not current_user.user_verification_token_expires_at
        or current_user.user_verification_token_expires_at < datetime.utcnow()
    ):
        raise HTTPException(status_code=400, detail="OTP has expired. Please request a new one.")

    user = db.query(User).filter(User.id == current_user.id).first()
    db.delete(user)
    db.commit()
    return {"message": "Account deleted successfully."}



# ---------------------------------------------------
# REGISTRATION & EMAIL VERIFICATION
# ---------------------------------------------------

@app.post("/signup")
def register_user(user: RegistrationUser, db: Session = Depends(get_db)):
    from sqlalchemy import or_
    # Check if username or email already exists
    existing = db.query(User).filter(or_(User.username == user.username, User.email == user.email)).first()
    if existing:
        if existing.username == user.username:
            raise HTTPException(status_code=400, detail="Username already exists")
        if existing.email == user.email:
            raise HTTPException(status_code=400, detail="Email already exists")

    auth_crud.create_user(db, user.username, user.password, user.email)
    return {"message": "User registered successfully!"}


@app.post("/verify_email")
async def verify_email_endpoint(
    request: Request,
    body: EmailVerificationRequest = Body(None),
    db: Session = Depends(get_db)
):
    # Support both query parameters (for GUI) and JSON body (for web frontend)
    email = None
    verification_token = None
    
    # Check if JSON body is provided
    if body:
        email = body.email
        verification_token = body.verification_token
    else:
        # Check query parameters (for GUI compatibility)
        email = request.query_params.get("email")
        verification_token = request.query_params.get("verification_token")
    
    if not email or not verification_token:
        raise HTTPException(status_code=400, detail="Email and verification_token are required")
    
    result = auth_crud.verify_email(db, email, verification_token)
    if not result:
        raise HTTPException(status_code=400, detail="Email verification failed")
    return {"message": "Email verified successfully"}


# ---------------------------------------------------
# DARK MODE ROUTES
# ---------------------------------------------------

@app.get("/user/theme")
def get_user_theme(current_user = Depends(get_current_user), db: Session = Depends(get_db)):
    """Get current user's theme preference"""
    user = db.query(User).filter(User.id == current_user.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Default to 'light' if not set
    theme = user.theme or 'light'
    return {"theme": theme}

@app.patch("/user/theme")
def update_user_theme(theme: str = Body(..., embed=True), current_user = Depends(get_current_user), db: Session = Depends(get_db)):
    """Update current user's theme preference"""
    if theme not in ['light', 'dark']:
        raise HTTPException(status_code=400, detail="Theme must be 'light' or 'dark'")
    
    user = db.query(User).filter(User.id == current_user.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    user.theme = theme
    db.commit()
    return {"message": "Theme updated successfully", "theme": theme}


# ---------------------------------------------------
# STATS ROUTES
# ---------------------------------------------------

@app.get("/analysis/{user_id}")
def get_user_stats_all_time(user_id: str, current_user = Depends(get_current_user),db: Session = Depends(get_db)):
    user_stats = stats.get_user_stats(db, user_id, stats.start_of_all_time, current_user)
    if not user_stats:
        raise HTTPException(status_code=404, detail="User stats not found")
    return user_stats


# ---------------------------------------------------
# FOCUS SESSION ROUTES
# ---------------------------------------------------

@app.post("/focus/session", response_model=FocusSessionResponse)
def save_focus_session(
    session: FocusSessionCreate,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if session.duration_seconds < 5:
        raise HTTPException(status_code=400, detail="Session too short (minimum 5 seconds)")
    new_session = FocusSession(user_id=current_user.id, duration_seconds=session.duration_seconds)
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    try:
        pet_crud.add_bond_from_focus(db, current_user.id, session.duration_seconds)
    except Exception:
        pass
    return new_session


@app.get("/focus/total")
def get_focus_total(current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    total = db.query(func.sum(FocusSession.duration_seconds)).filter(
        FocusSession.user_id == current_user.id
    ).scalar() or 0
    return {"total_seconds": int(total)}


@app.get("/focus/today")
def get_focus_today(current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.query(func.sum(FocusSession.duration_seconds)).filter(
        FocusSession.user_id == current_user.id,
        FocusSession.created_at >= today_start,
    ).scalar() or 0
    return {"total_seconds": int(total)}

