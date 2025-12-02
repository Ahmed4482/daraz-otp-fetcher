// backend/server.js
// Express server entry point for Daraz OTP Fetcher
// - Serves the frontend
// - Exposes an API endpoint to fetch parsed OTP emails from Gmail

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { getAllAuthorizedClients, exchangeCodeForToken } = require('./auth');
const { fetchDarazOtpEmails } = require('./emailParser');

// Load environment variables from .env if present
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies (not strictly needed here but useful)
app.use(express.json());

// CORS middleware for production (allow frontend to call backend)
app.use((req, res, next) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve frontend static files
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// OAuth callback endpoint - automatically exchanges code for token
app.get('/oauth2callback', async (req, res) => {
  const { code, error, state } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Error</title>
          <meta http-equiv="refresh" content="5;url=http://localhost:3000">
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); color: #e5e5e5; }
            .error { background: rgba(26, 26, 26, 0.9); padding: 30px; border-radius: 8px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 20px rgba(255, 107, 107, 0.2); border: 2px solid rgba(255, 107, 107, 0.3); }
            h1 { color: #ff6b6b; margin-top: 0; }
            p { color: #c9c9c9; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Authorization Error</h1>
            <p><strong>Error:</strong> ${error}</p>
            <p>Please try again or check your Google Cloud Console settings.</p>
            <p><small>This window will close automatically...</small></p>
          </div>
        </body>
      </html>
    `);
  }
  
  if (!code) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Missing Authorization Code</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); color: #e5e5e5; }
            .error { background: rgba(26, 26, 26, 0.9); padding: 30px; border-radius: 8px; max-width: 500px; margin: 0 auto; box-shadow: 0 4px 20px rgba(255, 215, 0, 0.1); border: 2px solid rgba(255, 215, 0, 0.2); }
            h1 { color: #FFD700; margin-top: 0; }
            p { color: #c9c9c9; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>⚠️ Missing Authorization Code</h1>
            <p>No authorization code received. Please try again.</p>
          </div>
        </body>
      </html>
    `);
  }

  // Extract email from state parameter
  let email = null;
  try {
    if (state) {
      email = Buffer.from(state, 'base64').toString('utf8');
    }
  } catch (err) {
    console.error('Error decoding state parameter:', err);
  }

  if (!email) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Invalid Request</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); color: #e5e5e5; }
            .error { background: rgba(26, 26, 26, 0.9); padding: 30px; border-radius: 8px; max-width: 500px; margin: 0 auto; }
            h1 { color: #ff6b6b; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Invalid Request</h1>
            <p>Could not identify which account to authenticate. Please try again.</p>
          </div>
        </body>
      </html>
    `);
  }

  // Automatically exchange code for token
  try {
    await exchangeCodeForToken(code, email);
    
    // Success page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Successful</title>
          <meta http-equiv="refresh" content="3;url=http://localhost:3000">
          <style>
            body { 
              font-family: Arial, sans-serif; 
              padding: 40px; 
              text-align: center; 
              background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); 
              color: #e5e5e5;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .success { 
              background: rgba(26, 26, 26, 0.9); 
              padding: 40px; 
              border-radius: 12px; 
              max-width: 600px; 
              margin: 0 auto; 
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 215, 0, 0.1);
              border: 2px solid rgba(255, 215, 0, 0.3);
            }
            h1 { 
              color: #FFD700; 
              margin-top: 0;
              font-size: 2rem;
              text-shadow: 0 0 10px rgba(255, 215, 0, 0.3);
            }
            .checkmark {
              font-size: 4rem;
              color: #2e7d32;
              margin-bottom: 20px;
            }
            p { 
              color: #c9c9c9; 
              font-size: 1.1rem;
              line-height: 1.6;
            }
            .email {
              color: #FFD700;
              font-weight: bold;
              font-size: 1.2rem;
              margin: 20px 0;
            }
            .note { 
              color: #888; 
              font-size: 0.9rem; 
              margin-top: 30px;
            }
            .spinner {
              border: 3px solid rgba(255, 215, 0, 0.2);
              border-top-color: #FFD700;
              border-radius: 50%;
              width: 30px;
              height: 30px;
              animation: spin 1s linear infinite;
              margin: 20px auto;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="success">
            <div class="checkmark">✅</div>
            <h1>Authorization Successful!</h1>
            <p>Your Gmail account has been authenticated successfully.</p>
            <div class="email">📧 ${email}</div>
            <p>Token has been saved automatically. You can close this window.</p>
            <div class="spinner"></div>
            <p class="note">Redirecting to app...</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error in callback:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; text-align: center; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); color: #e5e5e5; }
            .error { background: rgba(26, 26, 26, 0.9); padding: 30px; border-radius: 8px; max-width: 500px; margin: 0 auto; border: 2px solid rgba(255, 107, 107, 0.3); }
            h1 { color: #ff6b6b; }
            p { color: #c9c9c9; }
            .code { background: rgba(0,0,0,0.3); padding: 10px; font-family: monospace; margin: 10px 0; border-radius: 4px; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>❌ Error</h1>
            <p>Failed to exchange authorization code:</p>
            <div class="code">${err.message}</div>
            <p>Please check the server console for details.</p>
          </div>
        </body>
      </html>
    `);
  }
});

// Main API endpoint to fetch Daraz OTPs from all configured accounts
app.get('/api/otps', async (req, res) => {
  try {
    // Get authorized Gmail API clients for all accounts
    const clients = await getAllAuthorizedClients();

    if (clients.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'No Gmail accounts authenticated. Please authenticate at least one account.',
      });
    }

    // Fetch OTPs from all accounts in parallel
    const allOtps = [];
    const fetchPromises = clients.map(async (clientInfo) => {
      try {
        const otps = await fetchDarazOtpEmails(
          clientInfo.auth,
          clientInfo.email,
          clientInfo.name
        );
        return otps;
      } catch (error) {
        console.error(`Error fetching from ${clientInfo.email}:`, error.message);
        return []; // Return empty array if one account fails
      }
    });

    const results = await Promise.all(fetchPromises);
    
    // Combine all results
    results.forEach((otps) => {
      allOtps.push(...otps);
    });

    // Sort all OTPs by time (newest first)
    allOtps.sort((a, b) => {
      if (!a.timeReceived || !b.timeReceived) return 0;
      return new Date(b.timeReceived) - new Date(a.timeReceived);
    });

    res.json({ success: true, data: allOtps });
  } catch (error) {
    console.error('Error in /api/otps:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch OTP emails. Please try again.',
      error: error.message || 'Unknown error',
    });
  }
});

// Fallback: serve index.html for any other GET request (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Daraz OTP Fetcher server running at http://localhost:${PORT}`);
});


