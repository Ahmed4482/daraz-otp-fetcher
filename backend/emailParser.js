// backend/emailParser.js
// Contains logic to:
// - Fetch recent Daraz pickup OTP emails from Gmail
// - Parse email bodies to extract store name, OTP, tracking numbers, pickup location, and time

const { google } = require('googleapis');

// Gmail search parameters
// Only inspect the three most recent received emails in the inbox
const SEARCH_QUERY = 'in:inbox';

// Only log full email body debug info for this specific account
const DEBUG_EMAIL = 'muhammadrraahimsikander@gmail.com';
// Always print high-level [OTP] diagnostics so production (Render) logs reveal issues.
// NODE_ENV may be unset on Render, so we do NOT gate these behind it.
const SHOULD_LOG_OTP_DEBUG = true;

// Maximum number of emails to fetch (recent 3 only)
const MAX_EMAILS = 3;
const GMAIL_API_RETRIES = 3;
const GMAIL_REQUEST_OPTIONS = {
  headers: {
    // Render sometimes closes gzip streams early; request an uncompressed body.
    'Accept-Encoding': 'identity',
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGmailError(err) {
  const code = err && (err.code || err.status);
  const message = err && (err.message || '');

  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 429 ||
    (typeof code === 'number' && code >= 500) ||
    message.includes('Premature close')
  );
}

async function retryGmailRequest(requestFn, label) {
  let lastError;

  for (let attempt = 1; attempt <= GMAIL_API_RETRIES; attempt += 1) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;
      if (!isTransientGmailError(err) || attempt === GMAIL_API_RETRIES) {
        throw err;
      }

      const delayMs = attempt * 500;
      console.warn(
        `Transient Gmail API error during ${label}; retrying in ${delayMs}ms ` +
          `(${attempt}/${GMAIL_API_RETRIES})`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Decode a base64url-encoded string to UTF-8.
 */
function decodeBase64Url(data) {
  if (!data) return '';
  const buff = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buff.toString('utf8');
}

/**
 * Strip HTML tags from a string and decode HTML entities.
 */
function stripHtmlTags(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recursively extract the plain text body from a Gmail message payload.
 * First tries to find text/plain, then falls back to text/html with tags stripped.
 */
function extractPlainTextFromPayload(payload) {
  if (!payload) return '';

  // First priority: if this part has a body and mimeType is text/plain
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Second priority: if this part is text/html, extract and strip tags
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const htmlContent = decodeBase64Url(payload.body.data);
    return stripHtmlTags(htmlContent);
  }

  // If this is multipart, search its parts recursively
  if (payload.parts && payload.parts.length) {
    // First pass: look for text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }

    // Second pass: look for text/html and strip tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const htmlContent = decodeBase64Url(part.body.data);
        return stripHtmlTags(htmlContent);
      }
    }

    // Third pass: recurse into nested parts
    for (const part of payload.parts) {
      const text = extractPlainTextFromPayload(part);
      if (text) return text;
    }
  }

  return '';
}

/**
 * Extract fields from the email body using regex:
 * - Store Name: text after "Dear" and before comma
 * - OTP: 6-digit number after "OTP:"
 * - Tracking Numbers: all tokens starting with "PK-"
 * - Pickup Location: text after "designated location:"
 */
function parseEmailBody(body) {
  if (!body) {
    return {
      storeName: null,
      otp: null,
      trackingNumbers: [],
      pickupLocation: null,
    };
  }

  let storeName = null;
  let otp = null;
  let trackingNumbers = [];
  let pickupLocation = null;

  try {
    // Normalize line breaks but preserve structure for better parsing
    const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Store Name: after "Dear" and before comma
    const storeMatch = normalized.match(/Dear\s+([^,]+),/i);
    if (storeMatch && storeMatch[1]) {
      storeName = storeMatch[1].trim();
    }

    // OTP: for your Daraz emails, the OTP is the ONLY 6-digit number
    // To make this robust and simple, just take the first 6-digit number.
    const anySixDigit = normalized.match(/\b(\d{6})\b/);
    if (anySixDigit && anySixDigit[1]) {
      otp = anySixDigit[1].trim();
    }

    // Tracking numbers: all tokens starting with PK-
    const trackingMatches = normalized.match(/PK-[A-Z0-9]+/gi);
    if (trackingMatches) {
      trackingNumbers = trackingMatches;
    }

    // Pickup location: text after "designated location:"
    const locationMatch = normalized.match(/designated location:\s*([^\.]+)/i);
    if (locationMatch && locationMatch[1]) {
      pickupLocation = locationMatch[1].trim();
    }
  } catch (err) {
    // Swallow parse errors silently to avoid noisy logs
  }

  return {
    storeName,
    otp,
    trackingNumbers,
    pickupLocation,
  };
}

/**
 * Fetch and parse Daraz OTP emails using Gmail API.
 * @param {google.auth.OAuth2} auth Authorized OAuth2 client
 * @param {string} accountEmail Email address of the account (optional, for tracking)
 * @param {string} accountName Display name of the account (optional)
 * @returns {Promise<Array>} Array of parsed email data
 */
async function fetchDarazOtpEmails(auth, accountEmail = null, accountName = null) {
  const gmail = google.gmail({ version: 'v1', auth });

  try {
    // Search for messages using query
    const listResponse = await retryGmailRequest(
      () =>
        gmail.users.messages.list({
          userId: 'me',
          q: SEARCH_QUERY,
          maxResults: MAX_EMAILS,
          labelIds: ['INBOX'], // ensure we only inspect received messages
        }, GMAIL_REQUEST_OPTIONS),
      `message list for ${accountEmail || 'account'}`
    );

    const messages = (listResponse.data.messages || []).slice(0, MAX_EMAILS);
    if (SHOULD_LOG_OTP_DEBUG) {
      console.log(`[OTP] ${accountEmail || 'account'}: listed ${messages.length} recent inbox messages`);
    }

    if (messages.length === 0) {
      return [];
    }

    const results = [];

    // Step 1: Fetch each message and check if it's an OTP email
    // Step 2: Only process emails with subject "OTP for Package Pickup"
    for (const msg of messages) {
      try {
        const msgResponse = await retryGmailRequest(
          () =>
            gmail.users.messages.get({
              userId: 'me',
              id: msg.id,
              format: 'full',
            }, GMAIL_REQUEST_OPTIONS),
          `message fetch for ${accountEmail || 'account'}`
        );

        const { payload, internalDate } = msgResponse.data;

        // Extract subject first to check if this is an OTP email
        let subject = '(no subject)';
        if (payload && Array.isArray(payload.headers)) {
          const subjHeader = payload.headers.find(
            (h) => h.name && h.name.toLowerCase() === 'subject'
          );
          if (subjHeader && subjHeader.value) {
            subject = subjHeader.value;
          }
        }

        // Only log full diagnostics when debugging locally or in production logs.
        if (accountEmail === DEBUG_EMAIL || SHOULD_LOG_OTP_DEBUG) {
          const receivedIso = internalDate
            ? new Date(parseInt(internalDate, 10)).toISOString()
            : 'unknown date';
          console.log(
            `[DEBUG] Recent inbox email for ${accountEmail}: "${subject}" at ${receivedIso}`
          );
        }

        // FILTER: Only process emails with subject "OTP for Package Pickup"
        if (!subject.toLowerCase().includes('otp for package pickup')) {
          if (accountEmail === DEBUG_EMAIL || SHOULD_LOG_OTP_DEBUG) {
            console.log(
              `[DEBUG] Skipping email "${subject}" - not an OTP for Package Pickup email`
            );
          }
          continue; // Skip this email, move to next one
        }

        // This email has the correct subject, now extract and parse the body
        const bodyText = extractPlainTextFromPayload(payload);

        const parsed = parseEmailBody(bodyText);

        // Full email bodies can contain OTPs, so only log them during explicit local debugging.
        if (accountEmail === DEBUG_EMAIL && process.env.OTP_DEBUG === 'true') {
          if (!bodyText || bodyText.length === 0) {
            console.log(
              `[DEBUG] Warning: Empty email body extracted for ${accountEmail}`
            );
          } else {
            console.log(
              `[DEBUG] Full email body for ${accountEmail} (subject: "${subject}"):\n` +
                '----- BODY START -----\n' +
                bodyText +
                '\n----- BODY END -----'
            );
          }

          if (!parsed.otp) {
            console.log(
              `[DEBUG] Warning: No OTP extracted for ${accountEmail}. Body snippet:`,
              bodyText ? bodyText.substring(0, 300) : '(empty body)'
            );
          }
        }

        // Convert internalDate (ms since epoch) to JS Date string
        const receivedTime = internalDate ? new Date(parseInt(internalDate, 10)) : null;

        results.push({
          storeName: parsed.storeName,
          otp: parsed.otp,
          trackingNumbers: parsed.trackingNumbers,
          pickupLocation: parsed.pickupLocation,
          timeReceived: receivedTime ? receivedTime.toISOString() : null,
          accountEmail: accountEmail, // Which Gmail account this came from
          accountName: accountName, // Display name for the account
          rawSnippet: bodyText.slice(0, 500), // helpful for debugging in frontend if needed
        });
      } catch (err) {
        // Swallow per-message errors silently to keep console clean
      }
    }

    // Filter out invalid entries (must have both storeName and OTP)
    const validResults = results.filter(
      (item) => item.storeName && item.otp && item.timeReceived
    );
    if (SHOULD_LOG_OTP_DEBUG) {
      console.log(
        `[OTP] ${accountEmail || 'account'}: parsed ${validResults.length} valid OTP emails`
      );
    }

    // Sort newest first by timeReceived
    validResults.sort((a, b) => {
      if (!a.timeReceived || !b.timeReceived) return 0;
      return new Date(b.timeReceived) - new Date(a.timeReceived);
    });

    return validResults;
  } catch (err) {
    console.error(
      `[OTP] Error listing Gmail messages for ${accountEmail || 'account'} ` +
        `(code: ${err && (err.code || err.status)}):`,
      err && err.message ? err.message : err
    );
    throw new Error('Failed to list Gmail messages');
  }
}

module.exports = {
  fetchDarazOtpEmails,
  parseEmailBody, // exported mainly for testing
};


