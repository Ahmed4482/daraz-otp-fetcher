// backend/emailParser.js
// Contains logic to:
// - Fetch recent Daraz pickup OTP emails from Gmail
// - Parse email bodies to extract store name, OTP, tracking numbers, pickup location, and time

const { google } = require('googleapis');

// Gmail search parameters
// Search for OTP emails from any sender (not just noreply@support.daraz.pk)
const SEARCH_QUERY =
  'subject:"OTP for Package Pickup" newer_than:7d';

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
    console.error('Error parsing email body:', err);
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
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      return [];
    }

    const results = [];

    // Fetch each message in full format
    for (const msg of messages) {
      try {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        });

        const { payload, internalDate } = msgResponse.data;

        const bodyText = extractPlainTextFromPayload(payload);
        
        // Debug: log body text if OTP parsing fails
        if (!bodyText || bodyText.length === 0) {
          const accountInfo = accountEmail ? ` [Account: ${accountName || accountEmail}]` : '';
          console.log(`Warning: Empty email body extracted${accountInfo}`);
        }
        
        const parsed = parseEmailBody(bodyText);
        
        // Debug: log if OTP not found
        if (!parsed.otp) {
          const accountInfo = accountEmail ? ` [Account: ${accountName || accountEmail}]` : '';
          console.log(`OTP not found${accountInfo}. Body snippet:`, bodyText.substring(0, 300));
          // Try to find any 6-digit number in the body as fallback
          const anySixDigit = bodyText.match(/\b(\d{6})\b/);
          if (anySixDigit) {
            console.log(`Found 6-digit number in body (potential OTP): ${anySixDigit[1]}${accountInfo}`);
            parsed.otp = anySixDigit[1];
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
        console.error('Error fetching or parsing message:', err);
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


