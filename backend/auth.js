// backend/auth.js
// Handles Gmail API OAuth2 authentication using googleapis library.
// - Loads credentials from credentials.json
// - On first run, opens browser for OAuth consent
// - Saves token.json for future authenticated calls
// - Automatically handles token refresh using googleapis

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const open = require('open');
const readline = require('readline');
const { exec } = require('child_process');

// If modifying these scopes, delete token.json and re-authorize.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Paths for credentials.json and token.json
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Account configurations
const ACCOUNTS = [
  { email: 'ahmedsemporium@gmail.com', name: "Ahmed's Emporium" },
  { email: 'akdigitalden@gmail.com', name: 'AK Digital Den' },
  { email: 'mtfdigitalemporium@gmail.com', name: 'MTF Digital Emporium' },
  { email: 'mtfdigitalemporiumofficial@gmail.com', name: 'MTF Digital Emporium Official' },
  { email: 'hkdigitalhub7@gmail.com', name: 'HK Digital Hub' },
];

// Store pending OAuth clients (for automatic token exchange)
// Key: email, Value: { oAuth2Client, resolve, reject, timestamp }
const pendingAuths = new Map();

// Clean up old pending auths (older than 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of pendingAuths.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) {
      pendingAuths.delete(email);
      if (data.reject) {
        data.reject(new Error('Authentication timeout. Please try again.'));
      }
    }
  }
}, 60000); // Check every minute

// Get token path for a specific account
function getTokenPath(email) {
  const safeEmail = email.replace(/[@.]/g, '_');
  return path.join(__dirname, `token_${safeEmail}.json`);
}

/**
 * Read JSON file helper.
 */
function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Failed to read JSON file at ${filePath}:`, err);
    return null;
  }
}

/**
 * Save JSON file helper.
 */
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to write JSON file at ${filePath}:`, err);
  }
}

/**
 * Load client secrets from a local file and return an OAuth2 client.
 */
function loadOAuthClient() {
  const credentials = readJsonFile(CREDENTIALS_PATH);
  if (!credentials) {
    throw new Error(
      'Missing credentials.json. Please place your Google Cloud credentials.json file in the backend folder.'
    );
  }

  const { installed, web } = credentials;
  // Prefer web application config over installed (desktop) config
  const config = web || installed;

  if (!config) {
    throw new Error('Invalid credentials.json format. Expected "installed" or "web" config.');
  }

  const { client_id, client_secret, redirect_uris } = config;
  
  // Determine redirect URI based on environment
  let redirectUri = process.env.REDIRECT_URI;
  
  if (!redirectUri) {
    if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
      // Production: use Render URL
      redirectUri = process.env.RENDER_EXTERNAL_URL + '/oauth2callback';
    } else {
      // Development: use localhost
      // Prefer localhost:3000/oauth2callback if available, otherwise first redirect URI
      if (redirect_uris && redirect_uris.length > 0) {
        const localhostCallback = redirect_uris.find(uri => uri.includes('localhost:3000/oauth2callback'));
        redirectUri = localhostCallback || redirect_uris[0];
      } else {
        redirectUri = 'http://localhost:3000/oauth2callback';
      }
    }
  }

  if (!client_id || !client_secret) {
    throw new Error('credentials.json is missing client_id or client_secret.');
  }

  if (!redirectUri) {
    throw new Error('No redirect URI found. Please configure redirect_uris in credentials.json or set REDIRECT_URI environment variable.');
  }

  console.log(`Using redirect URI: ${redirectUri}`);
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

/**
 * Get and store new token after prompting for user authorization.
 * This will open the user's browser for OAuth consent on first run
 * and then ask you to paste the authorization code from the browser.
 * @param {google.auth.OAuth2} oAuth2Client OAuth2 client instance
 * @param {string} email Email address for this account (for token file naming)
 */
async function getNewToken(oAuth2Client, email) {
  // Encode email in state parameter for callback to identify which account
  const state = Buffer.from(email).toString('base64');
  
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: state, // Pass email in state so callback knows which account
  });

  console.log('\n🌐 Opening browser for Gmail authentication...');
  console.log(`📧 Account: ${email}`);
  console.log('⏳ Waiting for authentication... (this will happen automatically)');

  // Try to open the authorization URL in the default browser
  try {
    await open(authUrl);
  } catch (err) {
    // Fallback for Windows: use "start" command
    if (process.platform === 'win32') {
      exec(`start "" "${authUrl}"`, (cmdErr) => {
        if (cmdErr) {
          console.error(
            '\n❌ Failed to open browser automatically.'
          );
          console.log(`\nPlease open this URL in your browser:\n${authUrl}\n`);
        }
      });
    } else {
      console.error(
        '\n❌ Failed to open browser automatically.'
      );
      console.log(`\nPlease open this URL in your browser:\n${authUrl}\n`);
    }
  }

  // Return a promise that will be resolved by the callback endpoint
  return new Promise((resolve, reject) => {
    // Store the promise handlers so callback can resolve/reject
    pendingAuths.set(email, {
      oAuth2Client,
      resolve,
      reject,
      timestamp: Date.now(),
    });

    console.log('✅ Browser opened. Please authenticate in the browser window.');
    console.log('⏳ Waiting for callback...\n');
  });
}

/**
 * Exchange authorization code for token (called by callback endpoint)
 * @param {string} code Authorization code from OAuth callback
 * @param {string} email Email address (from state parameter)
 * @returns {Promise<google.auth.OAuth2>} Authorized OAuth2 client
 */
async function exchangeCodeForToken(code, email) {
  const pending = pendingAuths.get(email);
  if (!pending) {
    throw new Error(`No pending authentication found for ${email}. Please try again.`);
  }

  const { oAuth2Client, resolve, reject } = pending;
  
  return new Promise((resolveToken, rejectToken) => {
    oAuth2Client.getToken(code.trim(), (err, token) => {
      // Remove from pending
      pendingAuths.delete(email);

      if (err) {
        console.error(`❌ Error retrieving access token for ${email}:`, err.message || err);
        const error = new Error(`Failed to retrieve access token: ${err.message || err}`);
        reject(error);
        rejectToken(error);
        return;
      }

      oAuth2Client.setCredentials(token);
      const tokenPath = getTokenPath(email);
      writeJsonFile(tokenPath, token);
      console.log(`✅ Authorization successful! Token stored to ${path.basename(tokenPath)}`);
      resolve(oAuth2Client);
      resolveToken(oAuth2Client);
    });
  });
}

/**
 * Get an authorized OAuth2 client for a specific account.
 * - If token file exists, use it.
 * - Otherwise, start the OAuth flow.
 * @param {string} email Email address for the account
 */
async function getAuthorizedClient(email) {
  const oAuth2Client = loadOAuthClient();

  // Load token if it exists
  const tokenPath = getTokenPath(email);
  const token = readJsonFile(tokenPath);
  if (token) {
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // Otherwise, get a new token via OAuth flow
  console.log(`\n=== Authenticating account: ${email} ===`);
  return await getNewToken(oAuth2Client, email);
}

/**
 * Get authorized clients for all configured accounts.
 * @returns {Promise<Array>} Array of { email, name, auth } objects
 */
async function getAllAuthorizedClients() {
  const clients = [];
  
  for (const account of ACCOUNTS) {
    try {
      const auth = await getAuthorizedClient(account.email);
      clients.push({
        email: account.email,
        name: account.name,
        auth: auth,
      });
    } catch (error) {
      console.error(`Failed to authenticate ${account.email}:`, error.message);
      // Continue with other accounts even if one fails
    }
  }
  
  return clients;
}

module.exports = {
  getAuthorizedClient,
  getAllAuthorizedClients,
  exchangeCodeForToken,
  ACCOUNTS,
};


