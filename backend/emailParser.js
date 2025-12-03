// backend/emailParser.js
// Contains logic to:
// - Fetch recent Daraz pickup OTP emails from Gmail
// - Parse email bodies to extract store name, OTP, tracking numbers, pickup location, and time

const { google } = require('googleapis');

// Gmail search parameters
// Only inspect the three most recent received emails in the inbox
const SEARCH_QUERY = 'in:inbox';

// Only log debug info for this specific account
const DEBUG_EMAIL = 'mtfdigitalemporium@gmail.com';

// Maximum number of emails to fetch (recent 3 only)
const MAX_EMAILS = 3;

/**
 * Decode a base64url-encoded string to UTF-8.
 */
function decodeBase64Url(data) {
  if (!data) return '';
  const buff = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buff.toString('utf8');
}

/**
 * Recursively extract the plain text body from a Gmail message payload.
 */
function extractPlainTextFromPayload(payload) {
  if (!payload) return '';

  // If this part has a body and mimeType is text/plain
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // If this is multipart, search its parts
  if (payload.parts && payload.parts.length) {
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
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: SEARCH_QUERY,
      maxResults: MAX_EMAILS,
      labelIds: ['INBOX'], // ensure we only inspect received messages
    });

    const messages = (listResponse.data.messages || []).slice(0, MAX_EMAILS);
    if (messages.length === 0) {
      return [];
    }

    const results = [];

    // Fetch each message in full format (these are already the 3 most recent)
    for (const msg of messages) {
      try {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const { payload, internalDate } = msgResponse.data;

        // Extract subject (for optional debug logging)
        let subject = '(no subject)';
        if (payload && Array.isArray(payload.headers)) {
          const subjHeader = payload.headers.find(
            (h) => h.name && h.name.toLowerCase() === 'subject'
          );
          if (subjHeader && subjHeader.value) {
            subject = subjHeader.value;
          }
        }

        // Only log for the akdigitalden account, and nothing else
        if (accountEmail === DEBUG_EMAIL) {
          const receivedIso = internalDate
            ? new Date(parseInt(internalDate, 10)).toISOString()
            : 'unknown date';
          console.log(
            `[DEBUG] Recent inbox email for ${accountEmail}: "${subject}" at ${receivedIso}`
          );
        }

        const bodyText = extractPlainTextFromPayload(payload);

        const parsed = parseEmailBody(bodyText);

        // For the debug account, log body and warnings if something is off
        if (accountEmail === DEBUG_EMAIL) {
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

    // Sort newest first by timeReceived
    validResults.sort((a, b) => {
      if (!a.timeReceived || !b.timeReceived) return 0;
      return new Date(b.timeReceived) - new Date(a.timeReceived);
    });

    return validResults;
  } catch (err) {
    console.error('Error listing Gmail messages:', err);
    throw new Error('Failed to list Gmail messages');
  }
}

module.exports = {
  fetchDarazOtpEmails,
  parseEmailBody, // exported mainly for testing
};


