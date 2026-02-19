# NeuralGraph Site — Setup Guide

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install)
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)
- Node.js 20+
- A running NeuralGraph API at `https://api.neuralgraph.app` (see `../NeuralGraph/DEPLOY.md` for GKE Autopilot setup)

## 1. Firebase Project

If you already have a GCP project, add Firebase to it:

```bash
firebase projects:addfirebase YOUR_GCP_PROJECT_ID
```

Or create a new Firebase project:

```bash
firebase projects:create neuralgraph-app
```

Update `.firebaserc` with your project ID if different.

## 2. Enable APIs

```bash
gcloud services enable \
  cloudfunctions.googleapis.com \
  secretmanager.googleapis.com \
  identitytoolkit.googleapis.com \
  --project neuralgraph-app
```

## 3. Firebase Auth

1. Go to **Firebase Console** → **Authentication** → **Sign-in method**
2. Enable **Email/Password** provider
3. Under **Settings** → **User actions**, uncheck **Enable create (sign-up)** to prevent self-signup

## 4. Set Secrets

```bash
firebase functions:secrets:set NG_API_KEY
# Paste your NeuralGraph API key

firebase functions:secrets:set ANTHROPIC_API_KEY
# Paste your Anthropic API key

firebase functions:secrets:set OPENAI_API_KEY
# Paste your OpenAI API key

firebase functions:secrets:set GEMINI_API_KEY
# Paste your Google Gemini API key

firebase functions:secrets:set AZURE_OPENAI_API_KEY
# Paste your Azure OpenAI API key

firebase functions:secrets:set AZURE_OPENAI_ENDPOINT
# Paste your Azure OpenAI endpoint (e.g. https://your-resource.openai.azure.com)
```

Not all providers are required. The sandbox UI lets users pick a provider — only set secrets for the ones you want to enable.

## 5. Firebase Config (sandbox.html)

Get your Firebase web config from **Firebase Console** → **Project settings** → **General** → **Your apps** → **Web app**.

Update the `firebase.initializeApp({...})` block in `public/sandbox.html` with your `apiKey`, `authDomain`, and `projectId`.

## 6. Custom Domain

1. Go to **Firebase Console** → **Hosting** → **Custom domains**
2. Add `neuralgraph.app`
3. Update DNS records as instructed (A records pointing to Firebase)
4. Wait for SSL provisioning (can take up to 24 hours)

## 7. Create Sandbox Users

Create users via Firebase Console → Authentication → Users → Add user.

Then set custom claims using the Firebase Admin SDK. The `ngTenant` and `ngSpaceIds` must match a tenant and spaces created via the NeuralGraph API (`POST /v1/tenants`, `POST /v1/spaces`).

```bash
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

Or use the Firebase Console → click user → **Custom claims** field.

The user must sign out and back in for claims to take effect.

## 8. Deploy

```bash
cd functions && npm install && npm run build && cd ..
firebase deploy
```

Deploy only hosting or functions:

```bash
firebase deploy --only hosting
firebase deploy --only functions
```

## 9. Local Testing

```bash
cd functions && npm install && npm run build && cd ..
firebase emulators:start
```

The emulator UI will be at `http://localhost:4000`. The site will be at `http://localhost:5000`.

Note: Secrets are not available in the emulator. Set environment variables locally:

```bash
export NG_API_KEY=your-key
export ANTHROPIC_API_KEY=your-key
export OPENAI_API_KEY=your-key
export GEMINI_API_KEY=your-key
export AZURE_OPENAI_API_KEY=your-key
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
```

## 10. Verify

1. Visit `https://neuralgraph.app` — landing page loads
2. Visit `https://neuralgraph.app/sandbox` — login screen appears
3. Sign in with created credentials — chat UI loads, spaces populated
4. Send a message — full flow: ingest → hydrate → LLM response
5. Debug panel shows scored nodes and system prompt
