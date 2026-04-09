const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Middleware: verify JWT token
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Login: validate credentials and return JWT
async function login(username, password) {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';

  if (username !== adminUser) {
    throw new Error('Invalid credentials');
  }

  // Support both plain text (initial setup) and hashed passwords
  const isValid = adminPass.startsWith('$2')
    ? await bcrypt.compare(password, adminPass)
    : password === adminPass;

  if (!isValid) {
    throw new Error('Invalid credentials');
  }

  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  return { token, username, role: 'admin' };
}

module.exports = { requireAuth, login, JWT_SECRET };
