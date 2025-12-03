// frontend/script.js
// Handles UI interactions:
// - Calls backend /api/otps endpoint
// - Shows loading spinner and errors
// - Renders OTP data into a responsive table

document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('fetchBtn');
  const loadingEl = document.getElementById('loading');
  const messageEl = document.getElementById('message');
  const tableBody = document.getElementById('otpTableBody');

  function setLoading(isLoading) {
    if (isLoading) {
      loadingEl.classList.remove('hidden');
      fetchBtn.disabled = true;
    } else {
      loadingEl.classList.add('hidden');
      fetchBtn.disabled = false;
    }
  }

  function setMessage(text, type = 'info') {
    messageEl.textContent = text || '';
    messageEl.className = `message ${type}`;
  }

  function formatDateOnly(isoString) {
    if (!isoString) return 'Unknown';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    
    // Get day of month
    const day = date.getDate();
    
    // Add ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
    let suffix = 'th';
    if (day === 1 || day === 21 || day === 31) {
      suffix = 'st';
    } else if (day === 2 || day === 22) {
      suffix = 'nd';
    } else if (day === 3 || day === 23) {
      suffix = 'rd';
    }
    
    // Get month name
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const month = monthNames[date.getMonth()];
    
    return `${day}${suffix} ${month}`;
  }

  function formatTime(isoString) {
    if (!isoString) return 'Unknown';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    // Format: HH:MM:SS (24-hour format with seconds)
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  function renderTable(data) {
    tableBody.innerHTML = '';

    if (!data || data.length === 0) {
      setMessage('No OTP emails found in the last 7 days.', 'info');
      return;
    }

    data.forEach((item) => {
      const tr = document.createElement('tr');

      const storeTd = document.createElement('td');
      storeTd.textContent = item.storeName || '';

      const emailTd = document.createElement('td');
      emailTd.textContent = item.accountEmail || 'Unknown';
      emailTd.classList.add('account-cell');

      const otpTd = document.createElement('td');
      otpTd.textContent = item.otp || 'N/A';
      otpTd.classList.add('otp-cell');

      const dateTd = document.createElement('td');
      dateTd.classList.add('date-cell');
      dateTd.textContent = formatDateOnly(item.timeReceived);

      const timeTd = document.createElement('td');
      timeTd.classList.add('time-cell');
      timeTd.textContent = formatTime(item.timeReceived);

      tr.appendChild(storeTd);
      tr.appendChild(emailTd);
      tr.appendChild(otpTd);
      tr.appendChild(dateTd);
      tr.appendChild(timeTd);

      tableBody.appendChild(tr);
    });

    setMessage(`Loaded ${data.length} OTP email(s).`, 'success');
  }

  async function fetchOtps() {
    setMessage('');
    setLoading(true);

    try {
      // Get API URL from config.js or use relative path for localhost
      const API_URL = window.API_BASE_URL || 
                      (window.location.hostname === 'localhost' ? '' : '');
      
      const response = await fetch(`${API_URL}/api/otps`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        let errorText = 'Failed to fetch OTPs.';
        try {
          const errJson = await response.json();
          if (errJson && errJson.message) {
            errorText = errJson.message;
          }
        } catch (_) {
          // ignore JSON parse errors
        }
        throw new Error(errorText);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Unknown error from server.');
      }

      renderTable(data.data || []);
    } catch (err) {
      console.error('Error fetching OTPs:', err);
      setMessage(
        'Unable to fetch OTPs. Please make sure the backend is running and Gmail authentication is completed.',
        'error'
      );
    } finally {
      setLoading(false);
    }
  }

  fetchBtn.addEventListener('click', fetchOtps);
});


