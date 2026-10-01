// Thin fetch wrapper: attaches the auth token, throws readable errors.
const Api = (() => {
  const TOKEN_KEY = 'pos_token';
  const USER_KEY = 'pos_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function getUser() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function setToken(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
      clear();
      if (!location.pathname.endsWith('login.html')) location.href = 'login.html';
      throw new Error('Session expired. Please log in again.');
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }

    // The company was paused (or removed) from the platform console while
    // someone was signed in: end the session and say why on the login page.
    if (res.status === 403 && data && data.code === 'company_paused') {
      clear();
      if (!location.pathname.endsWith('login.html')) location.href = 'login.html?paused=1';
      throw new Error(data.error);
    }

    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  return {
    getToken, getUser, setToken, clear,
    login: (company_code, username, password) => request('POST', '/api/auth/login', { company_code, username, password }),
    registerCompany: (body) => request('POST', '/api/auth/register-company', body),
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url) => request('DELETE', url)
  };
})();
