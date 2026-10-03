const crypto = require('crypto');

function generateKey() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { generateKey, sha };