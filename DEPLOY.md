# NeuralGraph Site — Firebase Deployment Guide

> Deploying the marketing site + sandbox to Firebase Hosting with Cloud Functions.

---

## Prerequisites

- Google Cloud account with billing enabled
- Node.js 20+ installed
- Firebase CLI (`npm install -g firebase-tools`)
- NeuralGraph API deployed and running (see `../NeuralGraph/DEPLOY.md` for GKE Autopilot setup)

---

## Step 1: Create Firebase Project (Console)

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project**
3. Project name: **NeuralGraph** (or use existing GCP project)
4. Google Analytics: **Disable** (not needed)
5. Click **Create project** → wait → **Continue**

---

## Step 2: Enable Firebase Auth (Console)

1. Firebase Console → left sidebar → **Build** → **Authentication**
2. Click **Get started**
3. **Sign-in method** tab → click **Email/Password**
4. Toggle **Enable** to on
5. Leave "Email link" off → click **Save**
6. Go to **Settings** tab → **User actions**
7. **Uncheck** "Enable create (sign-up)" — prevents self-registration
8. Click **Save**

---

## Step 3: Get Firebase Web Config (Console)

1. Firebase Console → **gear icon** (top left) → **Project settings**
2. Scroll to **Your apps** → click the **web icon** (`</>`)
3. App nickname: `NeuralGraph Site`
4. Check **Also set up Firebase Hosting**
5. Click **Register app**
6. Copy these three values from the config:
   - `apiKey`
   - `authDomain`
   - `projectId`
7. Click **Continue to console**

Update `public/sandbox.html` — find the `firebase.initializeApp({...})` block and replace the placeholder values with the real ones.

---

## Step 4: Set Up Secrets (Google Cloud Console)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select your Firebase project in the top bar
3. Search **Secret Manager** → click it
4. Click **Enable API** if prompted
5. Create each secret:

| Secret Name | Value |
|---|---|
| `NG_API_KEY` | Your NeuralGraph API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key (optional) |
| `AZURE_OPENAI_ENDPOINT` | Azure endpoint URL (optional) |

For each: **Create Secret** → enter name → paste value → **Create Secret**.

Skip any providers you don't have keys for yet.

---

## Step 5: Enable Required APIs (Google Cloud Console)

1. Go to **APIs & Services** → **Library**
2. Search and **Enable** each:
   - **Cloud Functions API**
   - **Cloud Build API**
   - **Artifact Registry API**
   - **Cloud Run Admin API**
   - **Secret Manager API**

---

## Step 6: Update .firebaserc

Edit `.firebaserc` and replace the project ID with your actual Firebase project ID:

```json
{
  "projects": {
    "default": "your-actual-project-id"
  }
}
```

---

## Step 7: Deploy (Terminal)

```bash
# Login to Firebase
firebase login

# Install function dependencies and build
cd functions && npm install && npm run build && cd ..

# Deploy everything
firebase deploy
```

Deploy only specific parts:

```bash
firebase deploy --only hosting     # Just the static site
firebase deploy --only functions   # Just the Cloud Functions
```

---

## Step 8: Custom Domain (Console)

1. Firebase Console → **Hosting** (left sidebar under Build)
2. Click **Add custom domain**
3. Enter: `neuralgraph.app`
4. Firebase provides DNS records (two A records + optional TXT)
5. Add those records at your domain registrar
6. Wait for SSL provisioning (15 minutes to 24 hours)

---

## Step 9: Create Sandbox Users (Console + Terminal)

### Create the user

1. Firebase Console → **Authentication** → **Users** tab
2. Click **Add user**
3. Enter email and password

### Set custom claims

After the user is created, set their NeuralGraph permissions. The `ngTenant` and `ngSpaceIds` must match a tenant and spaces you've created via the NeuralGraph API (`POST /v1/tenants`, `POST /v1/spaces`).

```bash
# Install firebase-admin if not already
npm install firebase-admin

# Run the claims script
node -e "
const admin = require('firebase-admin');
admin.initializeApp();

admin.auth().getUserByEmail('user@example.com')
  .then(user => admin.auth().setCustomUserClaims(user.uid, {
    ngTenant: 'your-tenant-id',
    ngUserId: 'your-user-id',
    ngSpaceIds: ['space-uuid-1', 'space-uuid-2']
  }))
  .then(() => console.log('Claims set'))
  .catch(console.error);
"
```

The user must sign out and back in for claims to take effect.

---

## Step 10: Verify

1. `https://neuralgraph.app` — landing page loads
2. `https://neuralgraph.app/sandbox` — login screen appears
3. Sign in with created credentials — chat UI loads, space dropdown shows space names
4. Send a message — ingest → hydrate → LLM response
5. Debug panel shows scored nodes (name, type, match source, score) and system prompt

---

## Local Testing

```bash
cd functions && npm install && npm run build && cd ..
firebase emulators:start
```

- Emulator UI: `http://localhost:4000`
- Site: `http://localhost:5000`

Secrets aren't available in the emulator. Set them as environment variables:

```bash
export NG_API_KEY=your-key
export ANTHROPIC_API_KEY=your-key
export OPENAI_API_KEY=your-key
export GEMINI_API_KEY=your-key
```

---

## Updating

After code changes:

```bash
# Rebuild functions
cd functions && npm run build && cd ..

# Deploy
firebase deploy
```

---

## Proxied API Endpoints

The Cloud Function proxy validates Firebase Auth tokens and forwards to the NeuralGraph API. Only these endpoints are allowed:

| Method | Path | Description |
|---|---|---|
| GET | `/v1/health` | Health check |
| GET | `/v1/spaces` | List spaces |
| GET | `/v1/spaces/{id}` | Get space details |
| POST | `/v1/spaces/{id}/ingest` | Ingest content |
| POST | `/v1/hydrate` | Retrieve context |
| POST | `/v1/feedback` | Submit relevance feedback |
| GET | `/v1/jobs` | List jobs |
| GET | `/v1/jobs/{id}` | Get job status |
| GET | `/v1/profiles/{userId}` | Get user + AI profiles |
| PUT | `/v1/profiles/{userId}/user` | Update user profile |
| PUT | `/v1/profiles/{userId}/ai` | Update AI profile |
| GET/PUT | `/v1/profiles/{userId}/ai/spaces/{spaceId}` | AI profile overrides |

The proxy also handles `/api/chat` directly — calling the selected LLM provider (Anthropic, OpenAI, Gemini, or Azure OpenAI) without touching the NeuralGraph API.

All requests require a valid Firebase Auth token. Space access is enforced via custom claims (`ngSpaceIds`).

---

## Cost

Firebase Hosting and Cloud Functions have generous free tiers:

| Item | Free Tier | Overage |
|---|---|---|
| Hosting storage | 10 GB | $0.026/GB |
| Hosting transfer | 360 MB/day | $0.15/GB |
| Function invocations | 2M/month | $0.40/M |
| Function compute | 400K GB-seconds | $0.0000025/GB-s |

For a sandbox with a handful of users, you'll stay well within the free tier.
