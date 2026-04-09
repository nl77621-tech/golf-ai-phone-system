/**
 * Authentication Routes
 * Login endpoint for Command Center access
 */
const express = require('express');
const router = express.Router();
const { login } = require('../middleware/auth');

// POST /auth/login — Authenticate and return JWT
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const result = await login(username, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// GET /auth/verify — Check if token is still valid
router.get('/verify', (req, res) => {
  const { requireAuth } = require('../middleware/auth');
  requireAuth(req, res, () => {
    res.json({ valid: true, user: req.user });
  });
});

module.exports = router;
